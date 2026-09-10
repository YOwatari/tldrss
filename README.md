# tldrss
A daily RSS digest proxy on Cloudflare Workers.

## Usage
- Request: `/?url=https://example.com/rss.xml`
- The worker fetches the target feed (RSS 2.0 or Atom), keeps entries from the last 24 hours, summarizes them with [Workers AI](https://developers.cloudflare.com/workers-ai/), and returns a single-item RSS 2.0 digest.
- Digest XML is cached in Workers KV (`DIGEST_CACHE`) to reduce repeated inference.

## Bindings
| Binding | Kind | Purpose |
| --- | --- | --- |
| `DIGEST_CACHE` | KV namespace | Caches the generated digest for an hour |
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
