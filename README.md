# tldrss
A daily RSS digest proxy on Cloudflare Workers.

## Usage
- Request: `/feed?url=https://example.com/rss.xml` (add `&lang=ja` for a Japanese digest).
- `/` answers with usage instructions and doubles as a health check; any other path is a 404.
- The worker fetches the target feed (RSS 2.0 or Atom), keeps entries from the last 24 hours, summarizes them with [Workers AI](https://developers.cloudflare.com/workers-ai/), and returns a single-item RSS 2.0 digest.
- Digest XML is cached in Workers KV (`DIGEST_CACHE`) under `digest:{sha256(url)}:{JST date}:{lang}` for 48 hours, so yesterday's digest stays servable when today's generation fails.

### Response timing
Feed readers time out quickly, so `/feed` never generates a digest inside the request:

1. Today's digest (JST) is served from KV when present.
2. Otherwise yesterday's digest is served, and today's is generated in the background.
3. When neither exists, a valid RSS 2.0 channel with no `<item>` is returned immediately and the digest is generated in the background.

Upstream and model failures are logged and answered with 200, never with an error status, so a reader does not show the subscription as broken. A `generating:{...}` key (TTL 5 minutes) keeps concurrent requests from generating the same digest twice.

## Bindings
| Binding | Kind | Purpose |
| --- | --- | --- |
| `DIGEST_CACHE` | KV namespace | Caches the generated digest for 48 hours |
| `AI` | Workers AI | Runs the summarization model |
| `AI_MODEL` | var | Model id (default: `@cf/meta/llama-3.3-70b-instruct-fp8-fast`) |

No API key is needed: Workers AI is billed through the account that owns the worker.
Swap `AI_MODEL` in `wrangler.toml` for any [text generation model](https://developers.cloudflare.com/workers-ai/models/).

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
