import { env as providedEnv, reset } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import {
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
