import type { DigestRef } from "./digest-ref";

/**
 * Long enough to outlast a generation (feed fetch + one model call), short
 * enough that a crashed one does not keep the feed empty for the rest of the day.
 */
export const GENERATION_LOCK_TTL_SECONDS = 5 * 60;

/**
 * Generations started by this isolate. KV has no compare-and-set, so two
 * requests handled together would both read the key as free; this set closes
 * that window synchronously before the first await.
 */
const inFlight = new Set<string>();

function generationLockKey(ref: DigestRef): string {
  return `generating:${ref.hash}:${ref.date}:${ref.language}`;
}

/**
 * Best-effort guard against two concurrent crawls generating the same digest
 * twice. Across isolates KV is only eventually consistent, so the guard can
 * still lose a race; the cost of losing it is a duplicate model call, not a
 * wrong digest.
 */
export async function acquireGenerationLock(
  cache: KVNamespace,
  ref: DigestRef,
): Promise<boolean> {
  const key = generationLockKey(ref);
  if (inFlight.has(key)) return false;
  inFlight.add(key);

  try {
    if ((await cache.get(key)) !== null) {
      inFlight.delete(key);
      return false;
    }

    await cache.put(key, "1", { expirationTtl: GENERATION_LOCK_TTL_SECONDS });
    return true;
  } catch (error) {
    inFlight.delete(key);
    throw error;
  }
}

export async function releaseGenerationLock(
  cache: KVNamespace,
  ref: DigestRef,
): Promise<void> {
  const key = generationLockKey(ref);
  inFlight.delete(key);
  await cache.delete(key);
}
