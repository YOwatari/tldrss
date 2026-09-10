import { env as providedEnv, reset } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CRON_CONCURRENCY, handleScheduled } from "../../src/handlers/cron";
import { DEFAULT_LANGUAGE } from "../../src/digest/language";
import type { Env } from "../../src/env";
import { sha256Hex } from "../../src/hash";
import { digestCacheKey } from "../../src/store/digest-cache";
import { putSubscription } from "../../src/store/subscriptions";
import type { DigestInput, Summarizer } from "../../src/llm/summarizer";

/** The handler takes a `Summarizer`, so these tests need no `AI` binding. */
const bindings = providedEnv as unknown as Omit<Env, "AI">;

const kv = (providedEnv as unknown as { DIGEST_CACHE: KVNamespace }).DIGEST_CACHE;

const PUBLIC_ORIGIN = "https://worker.example";

/** 23:50 UTC, so the JST day the run covers is the day after it in UTC. */
const SCHEDULED_TIME = Date.parse("2026-09-09T23:50:00Z");
const JST_DATE = "2026-09-10";

const CRON = "50 23 * * *";

function envWith(overrides: Partial<Env> = {}): Env {
  return { ...bindings, PUBLIC_ORIGIN, ...overrides } as Env;
}

function fakeSummarizer(): Summarizer & { calls: DigestInput[] } {
  const calls: DigestInput[] = [];

  return {
    calls,
    async summarize(input) {
      calls.push(input);
      return "[1] It shipped.";
    },
  };
}

function feedXml(feedUrl: string): string {
  // Dated inside the 24 hour window ending at the scheduled time.
  const pubDate = new Date(SCHEDULED_TIME - 60 * 60 * 1000).toUTCString();

  return `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed of ${feedUrl}</title><item><title>Entry 1</title><link>${feedUrl}/1</link><pubDate>${pubDate}</pubDate><description>Hello</description></item></channel></rss>`;
}

/** Answers every feed url, or fails the ones named in `failing`. */
function stubFeedFetch(failing: string[] = []) {
  const fetched: string[] = [];

  const stub = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    fetched.push(url);

    if (failing.includes(url)) return new Response("nope", { status: 500 });
    return new Response(feedXml(url));
  });
  vi.stubGlobal("fetch", stub);

  return fetched;
}

async function register(...urls: string[]): Promise<string[]> {
  const hashes: string[] = [];

  for (const url of urls) {
    const hash = await sha256Hex(url);
    hashes.push(hash);
    await putSubscription(kv, hash, {
      url,
      registeredAt: "2026-09-01T00:00:00.000Z",
      lastSeenAt: "2026-09-09T21:00:00.000Z",
    });
  }

  return hashes;
}

function run(env: Env, summarizer: Summarizer) {
  return handleScheduled({ scheduledTime: SCHEDULED_TIME, cron: CRON }, env, summarizer);
}

function digestOf(hash: string, date = JST_DATE): Promise<string | null> {
  return kv.get(digestCacheKey({ hash, date, language: DEFAULT_LANGUAGE }));
}

function cacheWithFailedRelease(): KVNamespace {
  return {
    get: kv.get.bind(kv),
    put: kv.put.bind(kv),
    list: kv.list.bind(kv),
    delete: async () => {
      throw new Error("KV delete unavailable");
    },
  } as unknown as KVNamespace;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await reset();
});

describe("handleScheduled", () => {
  it("generates and stores a digest for every subscription", async () => {
    stubFeedFetch();
    const [first, second] = await register(
      "https://a.example/rss.xml",
      "https://b.example/rss.xml",
    );
    const summarizer = fakeSummarizer();

    const summary = await run(envWith(), summarizer);

    expect(summary).toMatchObject({ date: JST_DATE, total: 2, generated: 2, failed: 0 });
    await expect(digestOf(first)).resolves.toContain("<rss");
    await expect(digestOf(second)).resolves.toContain("<rss");
  });

  it("dates the digest by the JST day of the scheduled time, across the UTC boundary", async () => {
    stubFeedFetch();
    const [hash] = await register("https://a.example/rss.xml");

    const summary = await run(envWith(), fakeSummarizer());

    expect(summary.date).toBe(JST_DATE);
    // 2026-09-09 is the UTC day of the run, and must not be the one stored.
    await expect(digestOf(hash, "2026-09-09")).resolves.toBeNull();
    await expect(digestOf(hash)).resolves.toContain(`/digest/${hash}/${JST_DATE}`);
  });

  it("counts a stored digest as generated even when releasing its lock fails", async () => {
    const fetched = stubFeedFetch();
    const [hash] = await register("https://a.example/rss.xml");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const summarizer = fakeSummarizer();
    const env = envWith({ DIGEST_CACHE: cacheWithFailedRelease() });

    const summary = await run(env, summarizer);

    expect(summary).toMatchObject({ total: 1, generated: 1, skipped: 0, failed: 0 });
    await expect(digestOf(hash)).resolves.toContain("<rss");
    expect(errors.mock.calls).toEqual([
      [`Failed to release generation lock for ${hash} (Error)`],
    ]);

    const repeated = await run(env, summarizer);

    expect(repeated).toMatchObject({ total: 1, generated: 0, skipped: 1, failed: 0 });
    expect(summarizer.calls).toHaveLength(1);
    expect(fetched).toEqual(["https://a.example/rss.xml"]);
  });

  it.each(["build", "store"])(
    "reports the original %s error even when releasing the lock also fails",
    async (stage) => {
      stubFeedFetch();
      const [hash] = await register("https://a.example/rss.xml");
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const generationError = new TypeError("Generation failed");
      const cache = cacheWithFailedRelease();
      if (stage === "build") {
        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(generationError));
      } else {
        cache.put = async (key, value, options) => {
          if (key.startsWith("digest:")) throw generationError;
          await kv.put(key, value, options);
        };
      }

      const summary = await run(envWith({ DIGEST_CACHE: cache }), fakeSummarizer());

      expect(summary).toMatchObject({ total: 1, generated: 0, skipped: 0, failed: 1 });
      await expect(digestOf(hash)).resolves.toBeNull();
      expect(errors.mock.calls).toEqual([
        [`Failed to release generation lock for ${hash} (Error)`],
        [`Failed to generate digest for ${hash} (TypeError)`],
      ]);
    },
  );

  it("keeps generating the other digests when one feed fails", async () => {
    stubFeedFetch(["https://broken.example/rss.xml"]);
    const [broken, healthy] = await register(
      "https://broken.example/rss.xml",
      "https://b.example/rss.xml",
    );

    const summary = await run(envWith(), fakeSummarizer());

    expect(summary).toMatchObject({ total: 2, generated: 1, failed: 1 });
    await expect(digestOf(broken)).resolves.toBeNull();
    await expect(digestOf(healthy)).resolves.toContain("<rss");
  });

  it("does not regenerate a digest the day already has", async () => {
    const fetched = stubFeedFetch();
    const [hash] = await register("https://a.example/rss.xml");
    await kv.put(
      digestCacheKey({ hash, date: JST_DATE, language: DEFAULT_LANGUAGE }),
      "<rss>kept</rss>",
    );
    const summarizer = fakeSummarizer();

    const summary = await run(envWith(), summarizer);

    expect(summary).toMatchObject({ total: 1, generated: 0, skipped: 1, failed: 0 });
    expect(summarizer.calls).toEqual([]);
    expect(fetched).toEqual([]);
    await expect(digestOf(hash)).resolves.toBe("<rss>kept</rss>");
  });

  it("runs at most CRON_CONCURRENCY feeds at a time", async () => {
    let inFlight = 0;
    let peak = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await scheduler.wait(1);
        inFlight -= 1;

        return new Response(feedXml(String(input)));
      }),
    );
    const urls = Array.from({ length: 12 }, (_, index) => `https://${index}.example/rss.xml`);
    await register(...urls);

    const summary = await run(envWith(), fakeSummarizer());

    expect(summary.generated).toBe(urls.length);
    expect(peak).toBeLessThanOrEqual(CRON_CONCURRENCY);
    expect(peak).toBeGreaterThan(1);
  });

  it("generates nothing when PUBLIC_ORIGIN is unset, rather than storing dead links", async () => {
    const fetched = stubFeedFetch();
    const [hash] = await register("https://a.example/rss.xml");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const summary = await run(envWith({ PUBLIC_ORIGIN: undefined }), fakeSummarizer());

    expect(summary).toMatchObject({ total: 0, generated: 0 });
    expect(fetched).toEqual([]);
    expect(error).toHaveBeenCalled();
    await expect(digestOf(hash)).resolves.toBeNull();
  });

  it("logs the run as one JSON line", async () => {
    stubFeedFetch();
    await register("https://a.example/rss.xml");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await run(envWith(), fakeSummarizer());

    const logged = log.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(logged).toContainEqual(
      expect.objectContaining({
        cron: CRON,
        date: JST_DATE,
        total: 1,
        generated: 1,
        skipped: 0,
        failed: 0,
        durationMs: expect.any(Number),
      }),
    );
  });
});
