import { env as providedEnv, reset } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import {
  DIGEST_TTL_SECONDS,
  digestCacheKey,
  getDigest,
  putDigest,
} from "../../src/store/digest-cache";

const kv = (providedEnv as unknown as { DIGEST_CACHE: KVNamespace }).DIGEST_CACHE;

const REF = { hash: "a".repeat(64), date: "2026-09-10", language: "en" } as const;

afterEach(async () => {
  await reset();
});

describe("digestCacheKey", () => {
  it("is built from the hash, the JST date and the language", () => {
    expect(digestCacheKey(REF)).toBe(`digest:${"a".repeat(64)}:2026-09-10:en`);
  });

  it("separates the languages of one feed and day", () => {
    expect(digestCacheKey(REF)).not.toBe(digestCacheKey({ ...REF, language: "ja" }));
  });
});

describe("getDigest", () => {
  it("returns null when nothing was stored", async () => {
    await expect(getDigest(kv, REF)).resolves.toBeNull();
  });

  it("returns what putDigest stored", async () => {
    await putDigest(kv, REF, "<rss/>");

    await expect(getDigest(kv, REF)).resolves.toBe("<rss/>");
  });

  it("does not serve another day's digest", async () => {
    await putDigest(kv, REF, "<rss/>");

    await expect(getDigest(kv, { ...REF, date: "2026-09-11" })).resolves.toBeNull();
  });
});

describe("putDigest", () => {
  it("keeps the digest for two days so yesterday's stays servable", async () => {
    expect(DIGEST_TTL_SECONDS).toBe(48 * 60 * 60);

    const stored: KVNamespacePutOptions[] = [];
    const spy = {
      put: async (_key: string, _value: string, options?: KVNamespacePutOptions) => {
        if (options) stored.push(options);
      },
    } as unknown as KVNamespace;

    await putDigest(spy, REF, "<rss/>");

    expect(stored).toEqual([{ expirationTtl: DIGEST_TTL_SECONDS }]);
  });
});
