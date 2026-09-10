import type { DigestRef } from "./digest-ref";

/**
 * Long enough to outlast a generation (feed fetch + one model call), short
 * enough that a crashed one does not keep the feed empty for the rest of the day.
 */
export const GENERATION_LOCK_TTL_SECONDS = 5 * 60;

function generationLockKey(ref: DigestRef): string {
  return `generating:${ref.hash}:${ref.date}:${ref.language}`;
}

/**
 * Best-effort guard against two concurrent crawls generating the same digest
 * twice. KV has no compare-and-set, so a read and a write can interleave; the
 * cost of losing the race is a duplicate model call, not a wrong digest.
 */
export async function acquireGenerationLock(
  cache: KVNamespace,
  ref: DigestRef,
): Promise<boolean> {
  const key = generationLockKey(ref);
  if ((await cache.get(key)) !== null) return false;

  await cache.put(key, "1", { expirationTtl: GENERATION_LOCK_TTL_SECONDS });
  return true;
}

export async function releaseGenerationLock(
  cache: KVNamespace,
  ref: DigestRef,
): Promise<void> {
  await cache.delete(generationLockKey(ref));
}
