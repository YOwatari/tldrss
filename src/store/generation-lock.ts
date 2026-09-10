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

export function generationLockKey(ref: DigestRef): string {
  return `generating:${ref.hash}:${ref.date}:${ref.language}`;
}

/**
 * Best-effort guard against two concurrent crawls generating the same digest
 * twice. Across isolates KV is only eventually consistent, so the guard can
 * still lose a race; the cost of losing it is a duplicate model call, not a
 * wrong digest.
 *
 * Returns the token identifying this holder, or `null` when someone else holds
 * the lock. The token has to be handed back to `releaseGenerationLock`.
 */
export async function acquireGenerationLock(
  cache: KVNamespace,
  ref: DigestRef,
): Promise<string | null> {
  const key = generationLockKey(ref);
  if (inFlight.has(key)) return null;
  inFlight.add(key);

  try {
    if ((await cache.get(key)) !== null) {
      inFlight.delete(key);
      return null;
    }

    const token = crypto.randomUUID();
    await cache.put(key, token, { expirationTtl: GENERATION_LOCK_TTL_SECONDS });
    return token;
  } catch (error) {
    inFlight.delete(key);
    throw error;
  }
}

/**
 * Releases the lock only when `token` still owns it. Two isolates can end up
 * holding the same key while KV converges; without the check, the first to
 * finish would unlock a generation that is still running elsewhere.
 */
export async function releaseGenerationLock(
  cache: KVNamespace,
  ref: DigestRef,
  token: string,
): Promise<void> {
  const key = generationLockKey(ref);
  inFlight.delete(key);

  if ((await cache.get(key)) !== token) return;
  await cache.delete(key);
}
