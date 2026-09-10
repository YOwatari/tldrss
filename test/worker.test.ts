import {
  createExecutionContext,
  env as providedEnv,
  reset,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";

// `cloudflare:test` types `env` as the (empty) `Cloudflare.Env`; KV comes from
// wrangler.toml, while Workers AI is stubbed per test (it would call out to the
// Cloudflare API otherwise).
const bindings = providedEnv as unknown as Omit<Env, "AI">;

const FEED_ORIGIN = "https://source.example";
const FEED_URL = `${FEED_ORIGIN}/rss.xml`;
const WORKER_URL = `https://worker.example/?url=${FEED_URL}`;

function rssWithEntry(pubDate: string): string {
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>Test Feed</title><item><title>Entry 1</title><link>${FEED_ORIGIN}/1</link><pubDate>${pubDate}</pubDate><description>Hello</description></item></channel></rss>`;
}

function atomWithEntry(updated: string): string {
  return `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Atom Feed</title><entry><title>Atom Entry</title><link rel="alternate" href="${FEED_ORIGIN}/atom-1"/><updated>${updated}</updated><summary>Atom summary</summary></entry></feed>`;
}

/** Stubs the feed origin so tests never touch the network. */
function stubFeedFetch(respond: () => Response) {
  const calls: string[] = [];
  const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);

    if (url.startsWith(FEED_ORIGIN)) return respond();
    throw new Error(`Unexpected outbound request: ${url}`);
  });

  vi.stubGlobal("fetch", fetchSpy);
  return calls;
}

function stubAi(response = "- summary") {
  const run = vi.fn().mockResolvedValue({ response });
  return { ai: { run } as unknown as Ai, run };
}

async function callWorker(env: Env, url = WORKER_URL): Promise<Response> {
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
    const response = await callWorker(
      { ...bindings, AI: stubAi().ai },
      "https://worker.example/",
    );

    expect(response.status).toBe(400);
  });

  it("returns 400 for a non-http url", async () => {
    const response = await callWorker(
      { ...bindings, AI: stubAi().ai },
      "https://worker.example/?url=ftp://source.example/rss.xml",
    );

    expect(response.status).toBe(400);
  });

  it("summarizes an RSS 2.0 feed with Workers AI and stores the digest in KV", async () => {
    const calls = stubFeedFetch(() => new Response(rssWithEntry(hourAgo().toUTCString())));
    const { ai, run } = stubAi("- summary");

    const response = await callWorker({ ...bindings, AI: ai });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/rss+xml; charset=utf-8");
    expect(body).toContain("<rss version=\"2.0\">");
    expect(body).toContain("- summary");
    expect(body).toContain("Daily Digest: Test Feed");
    expect(calls).toEqual([FEED_URL]);
    expect(run).toHaveBeenCalledTimes(1);

    const cached = await bindings.DIGEST_CACHE.get(
      `digest:${new Date().toISOString().slice(0, 10)}:en:${FEED_URL}`,
    );
    expect(cached).toBe(body);
  });

  it("passes the configured model to Workers AI", async () => {
    stubFeedFetch(() => new Response(rssWithEntry(hourAgo().toUTCString())));
    const { ai, run } = stubAi();

    await callWorker({ ...bindings, AI: ai, AI_MODEL: "@cf/meta/llama-3.2-3b-instruct" });

    expect(run.mock.calls[0][0]).toBe("@cf/meta/llama-3.2-3b-instruct");
  });

  it("summarizes an Atom feed", async () => {
    stubFeedFetch(() => new Response(atomWithEntry(hourAgo().toISOString())));

    const body = await (
      await callWorker({ ...bindings, AI: stubAi("- atom summary").ai })
    ).text();

    expect(body).toContain("- atom summary");
    expect(body).toContain("Daily Digest: Atom Feed");
  });

  it("serves the cached digest without hitting the feed or the model again", async () => {
    const calls = stubFeedFetch(() => new Response(rssWithEntry(hourAgo().toUTCString())));
    const { ai, run } = stubAi();
    const env = { ...bindings, AI: ai };

    const first = await (await callWorker(env)).text();
    const second = await (await callWorker(env)).text();

    expect(second).toBe(first);
    expect(calls).toEqual([FEED_URL]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("skips the model call when nothing was published in the last 24 hours", async () => {
    const stale = new Date(Date.now() - 48 * 60 * 60 * 1000).toUTCString();
    stubFeedFetch(() => new Response(rssWithEntry(stale)));
    const { ai, run } = stubAi();

    const body = await (await callWorker({ ...bindings, AI: ai })).text();

    expect(body).toContain("No new entries were published in the last 24 hours.");
    expect(run).not.toHaveBeenCalled();
  });

  it("returns 502 when the feed body is not parsable xml", async () => {
    stubFeedFetch(() => new Response("<rss><channel>"));
    const { ai, run } = stubAi();

    const response = await callWorker({ ...bindings, AI: ai });

    expect(response.status).toBe(502);
    expect(run).not.toHaveBeenCalled();
  });

  it("returns 502 when the feed request itself fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Network connection lost.");
      }),
    );

    const response = await callWorker({ ...bindings, AI: stubAi().ai });

    expect(response.status).toBe(502);
  });

  it("does not log credentials carried in the feed url", async () => {
    const secretUrl = "https://source.example/rss.xml?token=super-secret";
    stubFeedFetch(() => new Response("<rss><channel>"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await callWorker(
      { ...bindings, AI: stubAi().ai },
      `https://worker.example/?url=${encodeURIComponent(secretUrl)}`,
    );

    expect(response.status).toBe(502);
    const logged = errors.mock.calls.flat().map(String).join(" ");
    expect(logged).not.toContain("super-secret");
    expect(logged).not.toContain("token=");
    expect(logged).toContain("https://source.example");
    errors.mockRestore();
  });

  it("returns 502 when the upstream feed fails", async () => {
    stubFeedFetch(() => new Response("boom", { status: 500 }));

    const response = await callWorker({ ...bindings, AI: stubAi().ai });

    expect(response.status).toBe(502);
  });
});

describe("worker fetch (language)", () => {
  it("returns an English digest by default", async () => {
    stubFeedFetch(() => new Response(rssWithEntry(hourAgo().toUTCString())));
    const { ai, run } = stubAi();

    await callWorker({ ...bindings, AI: ai });

    expect(run.mock.calls[0][1].messages[0].content).toContain("without preamble");
  });

  it("returns a Japanese digest for lang=ja", async () => {
    stubFeedFetch(() => new Response(rssWithEntry(hourAgo().toUTCString())));
    const { ai, run } = stubAi();

    await callWorker({ ...bindings, AI: ai }, `${WORKER_URL}&lang=ja`);

    expect(run.mock.calls[0][1].messages[0].content).toContain("日本語");
  });

  it("returns 400 for an unsupported language", async () => {
    const { ai, run } = stubAi();

    const response = await callWorker({ ...bindings, AI: ai }, `${WORKER_URL}&lang=fr`);

    expect(response.status).toBe(400);
    expect(run).not.toHaveBeenCalled();
  });

  it("caches each language separately", async () => {
    stubFeedFetch(() => new Response(rssWithEntry(hourAgo().toUTCString())));
    const { ai, run } = stubAi();
    const env = { ...bindings, AI: ai };

    await callWorker(env);
    await callWorker(env, `${WORKER_URL}&lang=ja`);

    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe("worker fetch (article links)", () => {
  it("heads each bullet with a link to the article it summarizes", async () => {
    stubFeedFetch(() => new Response(rssWithEntry(hourAgo().toUTCString())));

    const body = await (
      await callWorker({ ...bindings, AI: stubAi("[1] It shipped.").ai })
    ).text();

    expect(body).toContain(`&lt;a href=&quot;${FEED_ORIGIN}/1&quot;&gt;Entry 1&lt;/a&gt;`);
    expect(body).toContain("It shipped.");
  });

  it("drops a bullet citing an entry that does not exist", async () => {
    stubFeedFetch(() => new Response(rssWithEntry(hourAgo().toUTCString())));

    const body = await (
      await callWorker({ ...bindings, AI: stubAi("[1] It shipped.\n[7] Invented.").ai })
    ).text();

    expect(body).toContain("It shipped.");
    expect(body).not.toContain("Invented.");
  });

  it("keeps the model's text rather than serving an empty digest", async () => {
    stubFeedFetch(() => new Response(rssWithEntry(hourAgo().toUTCString())));

    const body = await (
      await callWorker({ ...bindings, AI: stubAi("[7] Invented.").ai })
    ).text();

    expect(body).toContain("Invented.");
  });
});
