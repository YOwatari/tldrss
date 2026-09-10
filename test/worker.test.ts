import {
  createExecutionContext,
  env as providedEnv,
  reset,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";

// `cloudflare:test` types `env` as the (empty) `Cloudflare.Env`; this worker's
// bindings come from wrangler.toml plus the test-only GEMINI_API_KEY binding.
const env = providedEnv as unknown as Env;

const FEED_ORIGIN = "https://source.example";
const FEED_URL = `${FEED_ORIGIN}/rss.xml`;
const WORKER_URL = `https://worker.example/?url=${FEED_URL}`;

function rssWithEntry(pubDate: string): string {
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>Test Feed</title><item><title>Entry 1</title><link>${FEED_ORIGIN}/1</link><pubDate>${pubDate}</pubDate><description>Hello</description></item></channel></rss>`;
}

function atomWithEntry(updated: string): string {
  return `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Atom Feed</title><entry><title>Atom Entry</title><link rel="alternate" href="${FEED_ORIGIN}/atom-1"/><updated>${updated}</updated><summary>Atom summary</summary></entry></feed>`;
}

function geminiResponse(text: string): Response {
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Routes outbound requests by origin so tests never touch the network. */
function stubOutbound(routes: { feed?: () => Response; gemini?: () => Response }) {
  const calls: string[] = [];
  const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);

    if (url.startsWith(FEED_ORIGIN) && routes.feed) return routes.feed();
    if (url.startsWith("https://generativelanguage.googleapis.com/") && routes.gemini) {
      return routes.gemini();
    }
    throw new Error(`Unexpected outbound request: ${url}`);
  });

  vi.stubGlobal("fetch", fetchSpy);
  return calls;
}

async function callWorker(url = WORKER_URL): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(url), env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

const hourAgo = () => new Date(Date.now() - 60 * 60 * 1000);

afterEach(async () => {
  vi.unstubAllGlobals();
  // Storage is shared across tests in this pool; drop KV state between them.
  await reset();
});

describe("worker fetch", () => {
  it("returns 400 when the url parameter is missing", async () => {
    const response = await callWorker("https://worker.example/");

    expect(response.status).toBe(400);
  });

  it("returns 400 for a non-http url", async () => {
    const response = await callWorker("https://worker.example/?url=ftp://source.example/rss.xml");

    expect(response.status).toBe(400);
  });

  it("summarizes an RSS 2.0 feed and stores the digest in KV", async () => {
    const calls = stubOutbound({
      feed: () => new Response(rssWithEntry(hourAgo().toUTCString()), { status: 200 }),
      gemini: () => geminiResponse("- summary"),
    });

    const response = await callWorker();
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/rss+xml; charset=utf-8");
    expect(body).toContain("<rss version=\"2.0\">");
    expect(body).toContain("- summary");
    expect(body).toContain("Daily Digest: Test Feed");
    expect(calls).toHaveLength(2);

    const cached = await env.DIGEST_CACHE.get(
      `digest:${new Date().toISOString().slice(0, 10)}:${FEED_URL}`,
    );
    expect(cached).toBe(body);
  });

  it("summarizes an Atom feed", async () => {
    stubOutbound({
      feed: () => new Response(atomWithEntry(hourAgo().toISOString()), { status: 200 }),
      gemini: () => geminiResponse("- atom summary"),
    });

    const body = await (await callWorker()).text();

    expect(body).toContain("- atom summary");
    expect(body).toContain("Daily Digest: Atom Feed");
  });

  it("serves the cached digest without hitting the network again", async () => {
    const calls = stubOutbound({
      feed: () => new Response(rssWithEntry(hourAgo().toUTCString()), { status: 200 }),
      gemini: () => geminiResponse("- summary"),
    });

    const first = await (await callWorker()).text();
    const second = await (await callWorker()).text();

    expect(second).toBe(first);
    expect(calls).toHaveLength(2);
  });

  it("skips the LLM call when nothing was published in the last 24 hours", async () => {
    const stale = new Date(Date.now() - 48 * 60 * 60 * 1000).toUTCString();
    const calls = stubOutbound({
      feed: () => new Response(rssWithEntry(stale), { status: 200 }),
    });

    const body = await (await callWorker()).text();

    expect(body).toContain("No new entries were published in the last 24 hours.");
    expect(calls).toEqual([FEED_URL]);
  });

  it("returns 502 when the upstream feed fails", async () => {
    stubOutbound({ feed: () => new Response("boom", { status: 500 }) });

    const response = await callWorker();

    expect(response.status).toBe(502);
  });
});
