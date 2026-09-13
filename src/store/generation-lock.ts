import type { DigestRef } from "./digest-ref";
import { periodSuffix } from "../digest/period";

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
const inFlight = new Map<string, string>();

export function generationLockKey(ref: DigestRef): string {
  return `generating:${ref.hash}:${ref.date}:${ref.language}${periodSuffix(ref.period)}`;
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
  options: { deadlineAt?: number } = {},
): Promise<string | null> {
  const key = generationLockKey(ref);
  const attemptToken = crypto.randomUUID();
  if (inFlight.has(key)) return null;
  inFlight.set(key, attemptToken);

  const work = (async (): Promise<string | null> => {
    let token: string;
    try {
      if ((await cache.get(key)) !== null) {
        if (inFlight.get(key) === attemptToken) inFlight.delete(key);
        return null;
      }

      token = crypto.randomUUID();
      await cache.put(key, token, { expirationTtl: GENERATION_LOCK_TTL_SECONDS });
    } catch (error) {
      if (inFlight.get(key) === attemptToken) inFlight.delete(key);
      throw error;
    }

    if (inFlight.get(key) !== attemptToken) {
      // The caller timed out and another local attempt may now own the guard.
      // Only remove this token if it is still the value in KV.
      void deleteTokenIfCurrent(cache, key, token, attemptToken);
      return null;
    }
    inFlight.set(key, token);
    return token;
  })();

  if (options.deadlineAt === undefined) return work;
  const remaining = options.deadlineAt - Date.now();
  if (remaining <= 0) {
    if (inFlight.get(key) === attemptToken) inFlight.delete(key);
    void work.catch(() => undefined);
    throw new Error("Digest generation deadline exceeded during generation lock");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      if (inFlight.get(key) === attemptToken) inFlight.delete(key);
      reject(new Error("Digest generation deadline exceeded during generation lock"));
    }, remaining);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function deleteTokenIfCurrent(
  cache: KVNamespace,
  key: string,
  token: string,
  attemptToken: string,
): Promise<void> {
  try {
    if (inFlight.has(key) && inFlight.get(key) !== attemptToken) return;
    if ((await cache.get(key)) === token) await cache.delete(key);
  } catch {
    // The lock TTL remains the fallback when late cleanup cannot reach KV.
  }
}

/**
 * Drops only this isolate's acquisition guard. The KV lock is left intact;
 * an acquisition that completes later is responsible for releasing its token.
 */
export function cancelGenerationLockAttempt(ref: DigestRef, expectedToken?: string): void {
  const key = generationLockKey(ref);
  if (expectedToken === undefined || inFlight.get(key) === expectedToken) inFlight.delete(key);
}

/**
 * Releases the lock only when `token` still owns it. Two isolates can end up
 * holding the same key while KV converges; without the check, the first to
 * finish would unlock a generation that is still running elsewhere.
 *
 * The in-isolate guard is held until KV is done, so a request arriving mid
 * release cannot take a lock that the pending delete would then drop. It is
 * cleared even when KV fails, otherwise one failure would block the feed for
 * the lifetime of the isolate.
 */
export async function releaseGenerationLock(
  cache: KVNamespace,
  ref: DigestRef,
  token: string,
): Promise<void> {
  const key = generationLockKey(ref);

  const ownsLocalGuard = inFlight.get(key) === token;
  try {
    const currentToken = await cache.get(key);
    if (currentToken === null) {
      // The KV entry may have expired or been removed by test cleanup. No
      // remote owner exists in that case, so clear a stale local guard too.
      if (ownsLocalGuard) inFlight.delete(key);
      return;
    }
    if (currentToken !== token) return;
    // A caller from another isolate may observe the token, but only this
    // isolate's owner may issue the delete or clear its local guard.
    if (!ownsLocalGuard) return;
    await cache.delete(key);
  } catch (error) {
    // A failed KV read/delete cannot establish ownership. Clear the local
    // guard so a transient KV outage cannot permanently block this isolate.
    inFlight.delete(key);
    throw error;
  } finally {
    if (ownsLocalGuard) inFlight.delete(key);
  }
}
