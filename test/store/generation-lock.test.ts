import { env as providedEnv, reset } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { DigestRef } from "../../src/store/digest-ref";
import {
  GENERATION_LOCK_TTL_SECONDS,
  acquireGenerationLock,
  generationLockKey,
  releaseGenerationLock,
} from "../../src/store/generation-lock";

const kv = (providedEnv as unknown as { DIGEST_CACHE: KVNamespace }).DIGEST_CACHE;

const REF = { hash: "b".repeat(64), date: "2026-09-10", language: "ja" } as const;

afterEach(async () => {
  // The lock also tracks in-flight generations in module state, so both
  // variants of REF are released explicitly rather than only dropping KV.
  await kv.delete(generationLockKey(REF));
  await kv.delete(generationLockKey({ ...REF, language: "en" }));
  await releaseGenerationLock(kv, REF, held.get(generationLockKey(REF)) ?? "");
  await releaseGenerationLock(
    kv,
    { ...REF, language: "en" },
    held.get(generationLockKey({ ...REF, language: "en" })) ?? "",
  );
  held.clear();
  await reset();
});

/** Tokens handed out during a test, so `afterEach` can release them. */
const held = new Map<string, string>();

async function acquire(ref: DigestRef = REF): Promise<string | null> {
  const token = await acquireGenerationLock(kv, ref);
  if (token) held.set(generationLockKey(ref), token);
  return token;
}

describe("acquireGenerationLock", () => {
  it("grants a token when the lock is free", async () => {
    await expect(acquire()).resolves.toEqual(expect.any(String));
  });

  it("refuses a second holder while the first still holds it", async () => {
    await acquire();

    await expect(acquire()).resolves.toBeNull();
  });

  it("locks each feed, day and language on its own", async () => {
    await acquire();

    await expect(acquire({ ...REF, language: "en" })).resolves.toEqual(expect.any(String));
  });

  it("gives each holder a token of its own", async () => {
    const first = await acquire();
    await releaseGenerationLock(kv, REF, first ?? "");

    expect(await acquire()).not.toBe(first);
  });

  it("expires so a crashed generation cannot block the feed forever", async () => {
    expect(GENERATION_LOCK_TTL_SECONDS).toBe(5 * 60);
  });
});

describe("releaseGenerationLock", () => {
  it("lets the next request generate again", async () => {
    const token = await acquire();

    await releaseGenerationLock(kv, REF, token ?? "");

    await expect(acquire()).resolves.toEqual(expect.any(String));
  });

  it("leaves a lock held by another isolate in place", async () => {
    await acquire();

    await releaseGenerationLock(kv, REF, "token-of-another-isolate");

    await expect(kv.get(generationLockKey(REF))).resolves.not.toBeNull();
  });
});
