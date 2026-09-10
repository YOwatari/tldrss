# tldrss
A daily RSS digest proxy on Cloudflare Workers.

## Usage
- Request: `GET /feed?url=https://example.com/rss.xml` (add `&lang=ja` for a Japanese digest). Other methods get a 405.
- `GET /digest/{sha256(url)}/{JST date}?lang={en|ja}` serves the full digest as an HTML page. Slack truncates the body of a feed item, so the item's title links here. The item link always spells the language out, `lang=en` included, so it keeps pointing at the same digest if the default ever changes; `lang` may be omitted when requesting the page by hand, and then defaults to `en`.
- `/` answers with usage instructions and doubles as a health check; any other path is a 404.
- The worker fetches the target feed (RSS 2.0 or Atom), keeps the newest entries from the last 24 hours (at most `MAX_ENTRIES`), summarizes them with [Workers AI](https://developers.cloudflare.com/workers-ai/), and returns a single-item RSS 2.0 digest.
- Entries the feed gave no readable date are skipped, as are entries dated ahead of the current time: a feed with a skewed clock would otherwise pin them to the top of every digest.
- Digest XML is cached in Workers KV (`DIGEST_CACHE`) under `digest:{sha256(url)}:{JST date}:{lang}` for 48 hours, so yesterday's digest stays servable when today's generation fails. The body of the page is stored beside it under `digest-html:{...}`.
- The digest carries at most one `<item>`, its `<guid isPermaLink="false">` is `{sha256(url)}-{JST date}-{lang}`, and its `<pubDate>` is 09:00 JST of the day it covers rather than the generation time — Slack posts one message per new guid, and readers sort by `pubDate`. The channel also carries a `<lastBuildDate>`, but no `<atom:link rel="self">`: a self address would have to be the `/feed?url=...` the reader subscribed to, and that is the one thing the XML must not carry.
- A day the feed published nothing gets an item-less channel, so Slack posts nothing. Set `POST_NO_UPDATES` to have it report the quiet day instead.
- Neither the guid nor any link carries the feed url: it is user-supplied and may hold a token, while the XML reaches every subscriber. The channel's `<link>` is the worker itself for the same reason.

### Response timing
Feed readers time out quickly, so `/feed` never generates a digest inside the request. The scheduled run below is what usually fills KV before the morning crawl; a feed it missed falls back to these steps:

1. Today's digest (JST) is served from KV when present.
2. Otherwise yesterday's digest is served, and today's is generated in the background.
3. When neither exists, a valid RSS 2.0 channel with no `<item>` is returned immediately and the digest is generated in the background.

When the model cannot be reached, the digest degrades to the day's titles and links instead of disappearing, and that fallback is cached like any other digest — a model outage costs the day its summary rather than causing a retry on every crawl.

Upstream and model failures are logged and answered with 200, never with an error status, so a reader does not show the subscription as broken. A `generating:{...}` key (TTL 5 minutes) makes concurrent requests unlikely to generate the same digest twice; KV has no compare-and-set and is only eventually consistent across isolates, so this reduces duplicate work rather than ruling it out.

### Scheduled pre-generation
A cron trigger runs at 08:50 JST (`50 23 * * *` in UTC, the schedule Cloudflare reads) and generates the day's digest for every subscription, so the 09:00 crawl is served straight from KV.

- Subscriptions are one KV record per feed, `sub:{sha256(url)}`, holding the feed url and when it was last crawled. Separate keys rather than one list: several feeds are crawled at once, and a read-modify-write of a shared list would drop whatever was registered in between. Self-registration from `/feed` is not in place yet, so until then the run only covers records written by hand.
- The base time is the scheduled time, not the moment the run starts: a run the platform starts late still covers the 24 hours its schedule named, and dates the digest by the JST day that window ends on — 23:50 UTC is already tomorrow in Tokyo.
- Five feeds are generated at once, and one feed's failure is counted rather than raised, so it costs no other feed its digest.
- A digest the day already has is left alone and no model is called, which keeps a re-run by hand free. There is no `?force=` to override that: the endpoint is public.
- Only the default language is pre-generated. A subscription names a feed, not a language, and generating every language would multiply the cost of the run; a crawl in another language still has its digest built in the background.
- Each run logs one JSON line — `{"event":"cron.digest","cron":…,"date":…,"total":…,"generated":…,"skipped":…,"failed":…,"durationMs":…}` — so Workers Logs can filter and aggregate it.

## Bindings
| Binding | Kind | Purpose |
| --- | --- | --- |
| `DIGEST_CACHE` | KV namespace | Caches the generated digest for 48 hours |
| `AI` | Workers AI | Runs the summarization model |
| `AI_MODEL` | var | Model id (default: `@cf/meta/llama-4-scout-17b-16e-instruct`) |
| `MAX_ENTRIES` | var | Entries per digest (default: 30, capped at 100) |
| `POST_NO_UPDATES` | var | Publish an item on a day with no new entries (default: off; `true` or `1` turns it on) |
| `PUBLIC_ORIGIN` | var | The address readers reach the worker at, e.g. `https://tldrss.example`. Required by the scheduled run, which has no request to read an origin off; a run without it generates nothing |

No API key is needed: Workers AI is billed through the account that owns the worker.
Swap `AI_MODEL` in `wrangler.toml` for any [text generation model](https://developers.cloudflare.com/workers-ai/models/).

## Digest body
The model is asked for a lead paragraph and one plain-text bullet per entry, each citing an entry number. The worker builds the HTML itself from those numbers, so every title and link a reader sees comes from the feed rather than from the model. An answer that ignores the format is passed through `llm/sanitize.ts` instead, which keeps only `<p> <h3> <ul> <li> <a> <strong> <br>`, drops every attribute, balances what the model left open, and keeps an `href` only when it is one the feed published — the model is prompted with attacker-controlled feed text, so a url it writes is no evidence the url exists.

Swapping the model provider means implementing `Summarizer` (`src/llm/summarizer.ts`) and naming it in `src/index.ts`, the only place a provider appears; the handler takes a `Summarizer` and never builds one. Each summarization gets two attempts inside a 20-second budget, which leaves room for the feed fetch and the KV writes inside the 30 seconds Cloudflare grants `ctx.waitUntil` after a response.

## Setup

```sh
npm ci
```

## Development

```sh
npm run dev        # wrangler dev (Workers AI runs remotely, so `wrangler login` is required)
npm run dev -- --test-scheduled  # same, plus the /__scheduled endpoint below
npm test           # vitest on the Workers runtime (workerd)
npm run typecheck  # tsc --noEmit
npm run build      # wrangler deploy --dry-run
```

The cron trigger does not fire under `wrangler dev`; `--test-scheduled` exposes it as an endpoint instead:

```sh
curl "http://localhost:8787/__scheduled?cron=50+23+*+*+*"
```

The run needs `PUBLIC_ORIGIN` (`http://localhost:8787` locally) and at least one `sub:` record to work on:

```sh
npx wrangler kv key put --local --binding DIGEST_CACHE \
  "sub:$(printf %s 'https://example.com/rss.xml' | shasum -a 256 | cut -d' ' -f1)" \
  '{"url":"https://example.com/rss.xml","registeredAt":"2026-09-10T00:00:00.000Z","lastSeenAt":"2026-09-10T00:00:00.000Z"}'
```

Tests run inside workerd via `@cloudflare/vitest-pool-workers`, using Miniflare's real KV binding.
Workers AI has no local emulation, so tests inject a stub `AI` binding and `remoteBindings` is off.
