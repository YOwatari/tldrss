# tldrss
A daily RSS digest proxy on Cloudflare Workers.

## Usage
- Request: `/?url=https://example.com/rss.xml`
- The worker fetches the target feed, keeps entries from the last 24 hours, summarizes them with Gemini (`gemini-1.5-flash`), and returns a single-item RSS 2.0 digest.
- Digest XML is cached in Workers KV (`DIGEST_CACHE`) to reduce repeated LLM/API work.
