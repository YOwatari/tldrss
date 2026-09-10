import { env as providedEnv, reset } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import {
  GENERATION_LOCK_TTL_SECONDS,
  acquireGenerationLock,
  releaseGenerationLock,
} from "../../src/store/generation-lock";

const kv = (providedEnv as unknown as { DIGEST_CACHE: KVNamespace }).DIGEST_CACHE;

const REF = { hash: "b".repeat(64), date: "2026-09-10", language: "ja" } as const;

afterEach(async () => {
  // The lock also tracks in-flight generations in module state, so both
  // variants of REF are released explicitly rather than only dropping KV.
  await releaseGenerationLock(kv, REF);
  await releaseGenerationLock(kv, { ...REF, language: "en" });
  await reset();
});

describe("acquireGenerationLock", () => {
  it("grants the lock when it is free", async () => {
    await expect(acquireGenerationLock(kv, REF)).resolves.toBe(true);
  });

  it("refuses a second holder while the first still holds it", async () => {
    await acquireGenerationLock(kv, REF);

    await expect(acquireGenerationLock(kv, REF)).resolves.toBe(false);
  });

  it("locks each feed, day and language on its own", async () => {
    await acquireGenerationLock(kv, REF);

    await expect(acquireGenerationLock(kv, { ...REF, language: "en" })).resolves.toBe(true);
  });

  it("expires so a crashed generation cannot block the feed forever", async () => {
    expect(GENERATION_LOCK_TTL_SECONDS).toBe(5 * 60);
  });
});

describe("releaseGenerationLock", () => {
  it("lets the next request generate again", async () => {
    await acquireGenerationLock(kv, REF);

    await releaseGenerationLock(kv, REF);

    await expect(acquireGenerationLock(kv, REF)).resolves.toBe(true);
  });
});
