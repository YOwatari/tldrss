# tldrss
A daily RSS digest proxy on Cloudflare Workers.

## Usage
- Request: `/?url=https://example.com/rss.xml`
- The worker fetches the target feed (RSS 2.0 or Atom), keeps entries from the last 24 hours, summarizes them with Gemini (`gemini-2.5-flash`), and returns a single-item RSS 2.0 digest.
- Digest XML is cached in Workers KV (`DIGEST_CACHE`) to reduce repeated LLM/API work.

## Setup

```sh
npm ci
```

### Secrets
`GEMINI_API_KEY` is a secret and is not stored in `wrangler.toml`. Register it once per environment:

```sh
npx wrangler secret put GEMINI_API_KEY
```

For local development, put it in `.dev.vars` (git-ignored):

```
GEMINI_API_KEY=your-key
```

The model is a plain variable (`GEMINI_MODEL` in `wrangler.toml`) and can be overridden per environment.

## Development

```sh
npm run dev        # wrangler dev (local)
npm test           # vitest on the Workers runtime (workerd)
npm run typecheck  # tsc --noEmit
npm run build      # wrangler deploy --dry-run
```

Tests run inside workerd via `@cloudflare/vitest-pool-workers`, using Miniflare's real KV binding and
a declarative mock (`fetchMock`) for outbound requests.
