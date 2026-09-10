import { env as providedEnv, reset } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  register, touch, remove, SUBSCRIPTION_TTL_SECONDS,
  listSubscriptions,
  putSubscription,
  subscriptionKey,
} from "../../src/store/subscriptions";

const kv = (providedEnv as unknown as { DIGEST_CACHE: KVNamespace }).DIGEST_CACHE;

const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);

const SUBSCRIPTION = {
  url: "https://source.example/rss.xml",
  registeredAt: "2026-09-01T00:00:00.000Z",
  lastSeenAt: "2026-09-10T00:00:00.000Z",
};

afterEach(async () => {
  await reset();
});

describe("subscriptionKey", () => {
  it("is built from the feed hash", () => {
    expect(subscriptionKey(HASH)).toBe(`sub:${HASH}`);
  });

  it("does not collide with the digest stored for the same feed", () => {
    expect(subscriptionKey(HASH)).not.toBe(`digest:${HASH}:2026-09-10:en`);
  });
});

describe("listSubscriptions", () => {
  it("returns an empty list when nothing is registered", async () => {
    await expect(listSubscriptions(kv)).resolves.toEqual([]);
  });

  it("returns what putSubscription stored, keyed by its hash", async () => {
    await putSubscription(kv, HASH, SUBSCRIPTION);

    await expect(listSubscriptions(kv)).resolves.toEqual([{ hash: HASH, ...SUBSCRIPTION }]);
  });

  it("returns one entry per registered feed", async () => {
    await putSubscription(kv, HASH, SUBSCRIPTION);
    await putSubscription(kv, OTHER_HASH, {
      ...SUBSCRIPTION,
      url: "https://other.example/feed.xml",
    });

    const hashes = (await listSubscriptions(kv)).map((entry) => entry.hash);

    expect(hashes.sort()).toEqual([HASH, OTHER_HASH]);
  });

  it("ignores the digests stored in the same namespace", async () => {
    await kv.put(`digest:${HASH}:2026-09-10:en`, "<rss/>");

    await expect(listSubscriptions(kv)).resolves.toEqual([]);
  });

  it("skips a record that is not a subscription instead of failing the run", async () => {
    await kv.put(subscriptionKey(OTHER_HASH), "not json");
    await kv.put(subscriptionKey("c".repeat(64)), JSON.stringify({ url: 42 }));
    await putSubscription(kv, HASH, SUBSCRIPTION);

    await expect(listSubscriptions(kv)).resolves.toEqual([{ hash: HASH, ...SUBSCRIPTION }]);
  });

  it("lists every page when the namespace holds more than one", async () => {
    const hashes = Array.from({ length: 12 }, (_, index) => String(index).padStart(64, "0"));
    for (const hash of hashes) {
      await putSubscription(kv, hash, SUBSCRIPTION);
    }

    const listed = await listSubscriptions(kv, { pageSize: 5 });

    expect(listed.map((entry) => entry.hash).sort()).toEqual([...hashes].sort());
  });
});


describe("subscription lifecycle", () => {
  const now = new Date("2026-09-10T00:00:00Z");

  it("registers independently during concurrent crawls and preserves registration time", async () => {
    const urls = ["https://one.example/rss", "https://two.example/rss"];
    const entries = await Promise.all(urls.map(url => register(kv, url, now)));
    expect((await listSubscriptions(kv)).map(s => s.url).sort()).toEqual(urls);
    expect(entries[0].registeredAt).toBe(now.toISOString());
    expect(await register(kv, urls[0], new Date(now.getTime() + 1000))).toEqual(entries[0]);
    const keys = await kv.list({ prefix: "sub:" });
    for (const key of keys.keys) {
      expect(key.expiration).toBeGreaterThan(Math.floor(Date.now() / 1000) + SUBSCRIPTION_TTL_SECONDS - 10);
    }
  });

  it("writes only at the twelve-hour boundary and preserves registeredAt", async () => {
    const entry = await register(kv, SUBSCRIPTION.url, now);
    expect(await touch(kv, entry.hash, new Date(now.getTime() + 12 * 3600000 - 1))).toBe(false);
    expect((await listSubscriptions(kv))[0].lastSeenAt).toBe(now.toISOString());
    expect(await touch(kv, entry.hash, new Date(now.getTime() + 12 * 3600000))).toBe(true);
    expect((await listSubscriptions(kv))[0]).toMatchObject({
      registeredAt: now.toISOString(), lastSeenAt: "2026-09-10T12:00:00.000Z",
    });
    await remove(kv, entry.hash);
    expect(await listSubscriptions(kv)).toEqual([]);
    expect(await touch(kv, entry.hash, now)).toBe(false);
    await remove(kv, entry.hash);
  });
});

it("renews expiration on refresh and disappears from listing after eight idle days", async () => {
  let clock = 0;
  const records = new Map<string, { value: string; expires: number }>();
  let writes = 0;
  const fake = {
    async put(key: string, value: string, options: { expirationTtl: number }) {
      writes++;
      records.set(key, { value, expires: clock + options.expirationTtl * 1000 });
    },
    async get(key: string) {
      const record = records.get(key);
      return record && record.expires > clock ? record.value : null;
    },
    async list() {
      return { list_complete: true, keys: [...records].filter(([, record]) => record.expires > clock).map(([name]) => ({ name })) };
    },
  } as unknown as KVNamespace;
  const entry = await register(fake, SUBSCRIPTION.url, new Date(clock));
  clock = 12 * 3600000 - 1;
  await touch(fake, entry.hash, new Date(clock));
  expect(writes).toBe(1);
  clock++;
  await touch(fake, entry.hash, new Date(clock));
  expect(writes).toBe(2);
  clock += SUBSCRIPTION_TTL_SECONDS * 1000 - 1;
  expect(await listSubscriptions(fake)).toHaveLength(1);
  clock++;
  expect(await listSubscriptions(fake)).toEqual([]);
});


it("serves existing subscriptions while a new admission is blocked on KV", async () => {
  const existing = await register(kv, SUBSCRIPTION.url);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const cache = {
    get: kv.get.bind(kv),
    put: kv.put.bind(kv),
    list: async (options: KVNamespaceListOptions) => {
      entered();
      await gate;
      return kv.list(options);
    },
  } as unknown as KVNamespace;
  const admission = register(cache, "https://new.example/rss");
  await started;
  let served = false;
  const crawl = register(cache, SUBSCRIPTION.url).then(entry => {
    expect(entry).toEqual(existing);
    served = true;
  });
  try {
    await vi.waitFor(() => expect(served).toBe(true));
  } finally {
    release();
    await Promise.all([admission, crawl]);
  }
});

it("rechecks a missing record under the lock when the same URL is registered concurrently", async () => {
  const records = new Map<string, string>();
  let misses = 0;
  let release!: () => void;
  const bothRead = new Promise<void>(resolve => { release = resolve; });
  const put = vi.fn(async (key: string, value: string) => { records.set(key, value); });
  const cache = {
    async get(key: string) {
      if (++misses <= 2) {
        if (misses === 2) release();
        await bothRead;
        return null;
      }
      return records.get(key) ?? null;
    },
    put,
    async list() { return { list_complete: true, keys: [...records.keys()].map(name => ({ name })) }; },
  } as unknown as KVNamespace;
  const results = await Promise.all([
    register(cache, SUBSCRIPTION.url, new Date(0), 1),
    register(cache, SUBSCRIPTION.url, new Date(1000), 1),
  ]);
  expect(results[0]).toEqual(results[1]);
  expect(put).toHaveBeenCalledTimes(1);
});
