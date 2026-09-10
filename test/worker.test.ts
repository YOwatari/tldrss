import {
  createExecutionContext,
  env as providedEnv,
  reset,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";
import { sha256Hex } from "../src/hash";
import { jstDate, previousDate } from "../src/time";

// `cloudflare:test` types `env` as the (empty) `Cloudflare.Env`; KV comes from
// wrangler.toml, while Workers AI is stubbed per test (it would call out to the
// Cloudflare API otherwise).
const bindings = providedEnv as unknown as Omit<Env, "AI">;

const FEED_ORIGIN = "https://source.example";
const FEED_URL = `${FEED_ORIGIN}/rss.xml`;
const WORKER_URL = `https://worker.example/feed?url=${FEED_URL}`;

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

/**
 * One request, including whatever it scheduled with `waitUntil`. The first
 * call to a feed only starts the generation, so most tests want `digestOf`.
 */
async function callWorker(env: Env, url = WORKER_URL): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(url), env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/**
 * The digest body: the first request kicks off the background generation, the
 * second one is served from KV.
 */
async function digestOf(env: Env, url = WORKER_URL): Promise<string> {
  await callWorker(env, url);
  return (await callWorker(env, url)).text();
}

const hourAgo = () => new Date(Date.now() - 60 * 60 * 1000);

/**
 * The digest KV entry for a feed, looked up by hash prefix rather than by a
 * key rebuilt from the wall clock: recomputing the date here would disagree
 * with the worker for a request made just before the JST boundary.
 */
async function storedDigest(
  feedUrl = FEED_URL,
  language = "en",
): Promise<{ key: string; value: string } | null> {
  const listed = await bindings.DIGEST_CACHE.list({
    prefix: `digest:${await sha256Hex(feedUrl)}:`,
  });
  const key = listed.keys.map((entry) => entry.name).find((name) => name.endsWith(`:${language}`));
  if (!key) return null;

  return { key, value: (await bindings.DIGEST_CACHE.get(key)) ?? "" };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  // Storage is shared across tests in this pool; drop KV state between them.
  await reset();
});

describe("routing", () => {
  it("answers the root path with usage instructions", async () => {
    const response = await callWorker({ ...bindings, AI: stubAi().ai }, "https://worker.example/");

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("/feed?url=");
  });

  it("returns 405 for a method the endpoint does not serve", async () => {
    const { ai, run } = stubAi();
    const ctx = createExecutionContext();

    const response = await worker.fetch(
      new Request(WORKER_URL, { method: "POST" }),
      { ...bindings, AI: ai },
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    // A rejected method must not reach the feed or the model.
    expect(run).not.toHaveBeenCalled();
  });

  it("serves HEAD, which readers use to poll", async () => {
    stubFeedFetch(() => new Response(rssWithEntry(hourAgo().toUTCString())));
    const ctx = createExecutionContext();

    const response = await worker.fetch(
      new Request(WORKER_URL, { method: "HEAD" }),
      { ...bindings, AI: stubAi().ai },
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    await expect(storedDigest()).resolves.not.toBeNull();
  });

  it("returns 404 for any other path", async () => {
    const response = await callWorker(
      { ...bindings, AI: stubAi().ai },
      `https://worker.example/other?url=${FEED_URL}`,
    );

    expect(response.status).toBe(404);
  });
});

describe("GET /feed (request validation)", () => {
  it("returns 400 when the url parameter is missing", async () => {
    const response = await callWorker(
      { ...bindings, AI: stubAi().ai },
      "https://worker.example/feed",
    );

    expect(response.status).toBe(400);
  });

  it("returns 400 for a non-http url", async () => {
    const response = await callWorker(
      { ...bindings, AI: stubAi().ai },
      "https://worker.example/feed?url=ftp://source.example/rss.xml",
    );

    expect(response.status).toBe(400);
  });

  it("returns 400 for an unsupported language", async () => {
    const { ai, run } = stubAi();

    const response = await callWorker({ ...bindings, AI: ai }, `${WORKER_URL}&lang=fr`);

    expect(response.status).toBe(400);
    expect(run).not.toHaveBeenCalled();
  });

  it("serves one cache entry for urls that differ only by their fragment", async () => {
    stubFeedFetch(() => new Response(rssWithEntry(hourAgo().toUTCString())));
    const { ai, run } = stubAi();
    const env = { ...bindings, AI: ai };

    await digestOf(env);
    await callWorker(env, `${WORKER_URL}%23section`);

    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("GET /feed (cache miss)", () => {
  it("returns an item-less channel while the digest is generated", async () => {
    stubFeedFetch(() => new Response(rssWithEntry(hourAgo().toUTCString())));

    const response = await callWorker({ ...bindings, AI: stubAi().ai });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('<rss version="2.0">');
    expect(body).not.toContain("<item>");
  });

  it("stores the generated digest in KV under the JST-dated key", async () => {
    const calls = stubFeedFetch(() => new Response(rssWithEntry(hourAgo().toUTCString())));
    const { ai, run } = stubAi("- summary");

    await callWorker({ ...bindings, AI: ai });

    const cached = await storedDigest();
    // The date itself is covered by the `jstDate` unit tests; asserting the
    // shape here keeps this test independent of when it runs.
    expect(cached?.key).toMatch(
      new RegExp(`^digest:${await sha256Hex(FEED_URL)}:\\d{4}-\\d{2}-\\d{2}:en$`),
    );
    expect(cached?.value).toContain("- summary");
    expect(cached?.value).toContain("Daily Digest: Test Feed");
    expect(calls).toEqual([FEED_URL]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("serves the stored digest to the next request", async () => {
    stubFeedFetch(() => new Response(rssWithEntry(hourAgo().toUTCString())));
    const { ai } = stubAi("- summary");

    const body = await digestOf({ ...bindings, AI: ai });

    expect(body).toContain("- summary");
    expect(body).toContain("<item>");
  });

  it("sets the xml content type and a five minute cache lifetime", async () => {
    stubFeedFetch(() => new Response(rssWithEntry(hourAgo().toUTCString())));

    const response = await callWorker({ ...bindings, AI: stubAi().ai });

    expect(response.headers.get("content-type")).toBe("application/xml; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
  });

  it("generates only once while a generation is still running", async () => {
    stubFeedFetch(() => new Response(rssWithEntry(hourAgo().toUTCString())));
    const { ai, run } = stubAi();
    const env = { ...bindings, AI: ai };

    // Both requests start before either digest lands in KV.
    const first = createExecutionContext();
    const second = createExecutionContext();
    await Promise.all([
      worker.fetch(new Request(WORKER_URL), env, first),
      worker.fetch(new Request(WORKER_URL), env, second),
    ]);
    await Promise.all([waitOnExecutionContext(first), waitOnExecutionContext(second)]);

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("summarizes an Atom feed", async () => {
    stubFeedFetch(() => new Response(atomWithEntry(hourAgo().toISOString())));

    const body = await digestOf({ ...bindings, AI: stubAi("- atom summary").ai });

    expect(body).toContain("- atom summary");
    expect(body).toContain("Daily Digest: Atom Feed");
  });

  it("passes the configured model to Workers AI", async () => {
    stubFeedFetch(() => new Response(rssWithEntry(hourAgo().toUTCString())));
    const { ai, run } = stubAi();

    await callWorker({ ...bindings, AI: ai, AI_MODEL: "@cf/meta/llama-3.2-3b-instruct" });

    expect(run.mock.calls[0][0]).toBe("@cf/meta/llama-3.2-3b-instruct");
  });

  it("skips the model call when nothing was published in the last 24 hours", async () => {
    const stale = new Date(Date.now() - 48 * 60 * 60 * 1000).toUTCString();
    stubFeedFetch(() => new Response(rssWithEntry(stale)));
    const { ai, run } = stubAi();

    const body = await digestOf({ ...bindings, AI: ai });

    expect(body).toContain("No new entries were published in the last 24 hours.");
    expect(run).not.toHaveBeenCalled();
  });
});

describe("GET /feed (cache hit)", () => {
  it("serves the cached digest without hitting the feed or the model again", async () => {
    const calls = stubFeedFetch(() => new Response(rssWithEntry(hourAgo().toUTCString())));
    const { ai, run } = stubAi();
    const env = { ...bindings, AI: ai };

    const first = await digestOf(env);
    const second = await (await callWorker(env)).text();

    expect(second).toBe(first);
    expect(calls).toEqual([FEED_URL]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("falls back to yesterday's digest when today's is missing", async () => {
    // Frozen, so "yesterday" cannot shift between seeding KV and the request.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-10T03:00:00Z"));
    stubFeedFetch(() => new Response(rssWithEntry(hourAgo().toUTCString())));
    const yesterdayKey = `digest:${await sha256Hex(FEED_URL)}:${previousDate(jstDate())}:en`;
    await bindings.DIGEST_CACHE.put(yesterdayKey, "<rss>yesterday</rss>");

    const body = await (await callWorker({ ...bindings, AI: stubAi().ai })).text();

    expect(body).toBe("<rss>yesterday</rss>");
  });
});

describe("GET /feed (upstream failures)", () => {
  it("serves an empty channel instead of an error when the feed is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Network connection lost.");
      }),
    );
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await callWorker({ ...bindings, AI: stubAi().ai });

    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain("<item>");
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it("stores nothing when the upstream feed answers with an error status", async () => {
    stubFeedFetch(() => new Response("boom", { status: 500 }));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await callWorker({ ...bindings, AI: stubAi().ai });

    expect(response.status).toBe(200);
    await expect(storedDigest()).resolves.toBeNull();
    errors.mockRestore();
  });

  it("stores nothing when the feed body is not parsable xml", async () => {
    stubFeedFetch(() => new Response("<rss><channel>"));
    const { ai, run } = stubAi();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await callWorker({ ...bindings, AI: ai });

    await expect(storedDigest()).resolves.toBeNull();
    expect(run).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("retries the generation on the next request after a failure", async () => {
    let fail = true;
    stubFeedFetch(() =>
      fail ? new Response("boom", { status: 500 }) : new Response(rssWithEntry(hourAgo().toUTCString())),
    );
    const { ai, run } = stubAi();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const env = { ...bindings, AI: ai };

    await callWorker(env);
    fail = false;
    await callWorker(env);

    expect(run).toHaveBeenCalledTimes(1);
    await expect(storedDigest()).resolves.not.toBeNull();
    errors.mockRestore();
  });

  it("logs instead of rejecting when the lock cannot be written", async () => {
    stubFeedFetch(() => new Response(rssWithEntry(hourAgo().toUTCString())));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    // Reads still work, so the request path is unaffected; only the background
    // task hits the failing write.
    const failingCache = {
      ...bindings.DIGEST_CACHE,
      get: async () => null,
      put: async () => {
        throw new Error("KV unavailable");
      },
      delete: async () => {},
    } as unknown as KVNamespace;

    const response = await callWorker({
      ...bindings,
      DIGEST_CACHE: failingCache,
      AI: stubAi().ai,
    });

    expect(response.status).toBe(200);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it("does not log credentials carried in the feed url", async () => {
    const secretUrl = "https://source.example/rss.xml?token=super-secret";
    stubFeedFetch(() => new Response("<rss><channel>"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await callWorker(
      { ...bindings, AI: stubAi().ai },
      `https://worker.example/feed?url=${encodeURIComponent(secretUrl)}`,
    );

    const logged = errors.mock.calls.flat().map(String).join(" ");
    expect(logged).not.toContain("super-secret");
    expect(logged).not.toContain("token=");
    expect(logged).toContain("https://source.example");
    errors.mockRestore();
  });
});

describe("GET /feed (JST day boundary)", () => {
  const atUtc = (iso: string) => vi.setSystemTime(new Date(iso));

  /** The digest key the worker writes for a request made at `iso`. */
  async function keyWrittenAt(iso: string): Promise<string> {
    atUtc(iso);
    stubFeedFetch(() => new Response(rssWithEntry(new Date(Date.now() - 3_600_000).toUTCString())));
    await callWorker({ ...bindings, AI: stubAi().ai });

    const keys = await bindings.DIGEST_CACHE.list({ prefix: "digest:" });
    return keys.keys.map((entry) => entry.name).sort().at(-1) ?? "";
  }

  it("switches the key at 15:00 UTC, not at midnight UTC", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });

    const beforeBoundary = await keyWrittenAt("2026-09-10T14:59:59Z");
    await reset();
    const afterBoundary = await keyWrittenAt("2026-09-10T15:00:00Z");

    expect(beforeBoundary).toContain(":2026-09-10:");
    expect(afterBoundary).toContain(":2026-09-11:");
  });

  it("keeps one key across midnight UTC, which is 09:00 JST", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });

    const lateEvening = await keyWrittenAt("2026-09-10T23:50:00Z");
    await reset();
    const afterUtcMidnight = await keyWrittenAt("2026-09-11T00:10:00Z");

    expect(lateEvening).toContain(":2026-09-11:");
    expect(afterUtcMidnight).toBe(lateEvening);
  });
});

describe("GET /feed (language)", () => {
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

  it("says in Japanese that nothing was published when lang=ja", async () => {
    const stale = new Date(Date.now() - 48 * 60 * 60 * 1000).toUTCString();
    stubFeedFetch(() => new Response(rssWithEntry(stale)));
    const { ai, run } = stubAi();

    const body = await digestOf({ ...bindings, AI: ai }, `${WORKER_URL}&lang=ja`);

    expect(body).toContain("24 時間以内に公開された新しいエントリはありません。");
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

  it("accepts the default language spelled out", async () => {
    stubFeedFetch(() => new Response(rssWithEntry(hourAgo().toUTCString())));
    const { ai, run } = stubAi();

    const response = await callWorker({ ...bindings, AI: ai }, `${WORKER_URL}&lang=en`);

    expect(response.status).toBe(200);
    expect(run.mock.calls[0][1].messages[0].content).toContain("without preamble");
  });

  it("serves lang=en from the same cache entry as no lang at all", async () => {
    stubFeedFetch(() => new Response(rssWithEntry(hourAgo().toUTCString())));
    const { ai, run } = stubAi();
    const env = { ...bindings, AI: ai };

    await digestOf(env);
    await callWorker(env, `${WORKER_URL}&lang=en`);

    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("GET /feed (article links)", () => {
  it("heads each bullet with a link to the article it summarizes", async () => {
    stubFeedFetch(() => new Response(rssWithEntry(hourAgo().toUTCString())));

    const body = await digestOf({ ...bindings, AI: stubAi("[1] It shipped.").ai });

    expect(body).toContain(`&lt;a href=&quot;${FEED_ORIGIN}/1&quot;&gt;Entry 1&lt;/a&gt;`);
    expect(body).toContain("It shipped.");
  });

  it("drops a bullet citing an entry that does not exist", async () => {
    stubFeedFetch(() => new Response(rssWithEntry(hourAgo().toUTCString())));

    const body = await digestOf({
      ...bindings,
      AI: stubAi("[1] It shipped.\n[7] Invented.").ai,
    });

    expect(body).toContain("It shipped.");
    expect(body).not.toContain("Invented.");
  });

  it("keeps the model's text rather than serving an empty digest", async () => {
    stubFeedFetch(() => new Response(rssWithEntry(hourAgo().toUTCString())));

    const body = await digestOf({ ...bindings, AI: stubAi("[7] Invented.").ai });

    expect(body).toContain("Invented.");
  });
});

describe("GET /feed (guid)", () => {
  const guidOf = (xml: string) => /<guid[^>]*>([^<]*)<\/guid>/.exec(xml)?.[1];

  it("gives the English and Japanese digests different guids", async () => {
    stubFeedFetch(() => new Response(rssWithEntry(hourAgo().toUTCString())));
    const env = { ...bindings, AI: stubAi().ai };

    const english = guidOf(await digestOf(env));
    const japanese = guidOf(await digestOf(env, `${WORKER_URL}&lang=ja`));

    expect(english).toBeDefined();
    expect(english).not.toBe(japanese);
  });

  it("does not carry the feed url, and its credentials, into the links", async () => {
    const secretUrl = "https://source.example/rss.xml?token=super-secret";
    stubFeedFetch(() => new Response(rssWithEntry(hourAgo().toUTCString())));
    const workerUrl = `https://worker.example/feed?url=${encodeURIComponent(secretUrl)}`;

    // Both the placeholder channel and the generated digest reach readers.
    const placeholder = await (await callWorker({ ...bindings, AI: stubAi().ai }, workerUrl)).text();
    const digest = await (await callWorker({ ...bindings, AI: stubAi().ai }, workerUrl)).text();

    for (const body of [placeholder, digest]) {
      expect(body).toContain("<link>https://worker.example/feed</link>");
      expect(body).not.toContain("super-secret");
      expect(body).not.toContain("token=");
    }
  });

  it("does not carry the feed url, and its credentials, into the guid", async () => {
    const secretUrl = "https://source.example/rss.xml?token=super-secret";
    stubFeedFetch(() => new Response(rssWithEntry(hourAgo().toUTCString())));

    const body = await digestOf(
      { ...bindings, AI: stubAi().ai },
      `https://worker.example/feed?url=${encodeURIComponent(secretUrl)}`,
    );

    expect(guidOf(body)).toMatch(
      new RegExp(`^${await sha256Hex(secretUrl)}-\\d{4}-\\d{2}-\\d{2}-en$`),
    );
  });
});

describe("GET /feed (untitled entries)", () => {
  const untitledItem = (pubDate: string) =>
    `<?xml version="1.0"?><rss version="2.0"><channel><title>Test Feed</title><item><link>${FEED_ORIGIN}/1</link><pubDate>${pubDate}</pubDate><description>Hello</description></item></channel></rss>`;

  it("labels an untitled entry in Japanese for lang=ja", async () => {
    stubFeedFetch(() => new Response(untitledItem(hourAgo().toUTCString())));

    const body = await digestOf(
      { ...bindings, AI: stubAi("[1] It shipped.").ai },
      `${WORKER_URL}&lang=ja`,
    );

    expect(body).toContain("(タイトルなし)");
    expect(body).not.toContain("(untitled)");
  });
});
