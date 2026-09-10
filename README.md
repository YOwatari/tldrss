# tldrss
A daily RSS digest proxy on Cloudflare Workers.

## Usage
- Request: `GET /feed?url=https://example.com/rss.xml` (add `&lang=ja` for a Japanese digest). Other methods get a 405.
- `GET /digest/{sha256(url)}/{JST date}?lang={en|ja}` serves the full digest as an HTML page. Slack truncates the body of a feed item, so the item's title links here. The item link always spells the language out, `lang=en` included, so it keeps pointing at the same digest if the default ever changes; `lang` may be omitted when requesting the page by hand, and then defaults to `en`.
- `/` answers with usage instructions and doubles as a health check; any other path is a 404.
- The worker fetches the target feed (RSS 2.0 or Atom), keeps the newest entries from the last 24 hours (at most `MAX_ENTRIES`), summarizes them with [Workers AI](https://developers.cloudflare.com/workers-ai/), and returns a single-item RSS 2.0 digest.
- Entries the feed gave no readable date are skipped, as are entries dated ahead of the current time: a feed with a skewed clock would otherwise pin them to the top of every digest.
- Digest XML is cached in Workers KV (`DIGEST_CACHE`) under `digest:{sha256(url)}:{JST date}:{lang}` for 48 hours, so yesterday's digest stays servable when today's generation fails. The body of the page is stored beside it under `digest-html:{...}`.
- The digest carries at most one `<item>`, its `<guid isPermaLink="false">` is `{sha256(url)}-{JST date}-{lang}`, and its `<pubDate>` is 09:00 JST of the day it covers rather than the generation time — Slack posts one message per new guid, and readers sort by `pubDate`.
- A day the feed published nothing gets an item-less channel, so Slack posts nothing. Set `POST_NO_UPDATES` to have it report the quiet day instead.
- Neither the guid nor any link carries the feed url: it is user-supplied and may hold a token, while the XML reaches every subscriber.

### Response timing
Feed readers time out quickly, so `/feed` never generates a digest inside the request:

1. Today's digest (JST) is served from KV when present.
2. Otherwise yesterday's digest is served, and today's is generated in the background.
3. When neither exists, a valid RSS 2.0 channel with no `<item>` is returned immediately and the digest is generated in the background.

When the model cannot be reached, the digest degrades to the day's titles and links instead of disappearing, and that fallback is cached like any other digest — a model outage costs the day its summary rather than causing a retry on every crawl.

Upstream and model failures are logged and answered with 200, never with an error status, so a reader does not show the subscription as broken. A `generating:{...}` key (TTL 5 minutes) makes concurrent requests unlikely to generate the same digest twice; KV has no compare-and-set and is only eventually consistent across isolates, so this reduces duplicate work rather than ruling it out.

## Bindings
| Binding | Kind | Purpose |
| --- | --- | --- |
| `DIGEST_CACHE` | KV namespace | Caches the generated digest for 48 hours |
| `AI` | Workers AI | Runs the summarization model |
| `AI_MODEL` | var | Model id (default: `@cf/meta/llama-4-scout-17b-16e-instruct`) |
| `MAX_ENTRIES` | var | Entries per digest (default: 30, capped at 100) |
| `POST_NO_UPDATES` | var | Publish an item on a day with no new entries (default: off; `true` or `1` turns it on) |

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
npm test           # vitest on the Workers runtime (workerd)
npm run typecheck  # tsc --noEmit
npm run build      # wrangler deploy --dry-run
```

Tests run inside workerd via `@cloudflare/vitest-pool-workers`, using Miniflare's real KV binding.
Workers AI has no local emulation, so tests inject a stub `AI` binding and `remoteBindings` is off.
