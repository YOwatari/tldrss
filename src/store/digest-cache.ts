import type { DigestRef } from "./digest-ref";

/**
 * Two days, so a digest stays servable as "yesterday's" even when the next
 * day's generation fails.
 */
export const DIGEST_TTL_SECONDS = 48 * 60 * 60;

export function digestCacheKey(ref: DigestRef): string {
  return `digest:${ref.hash}:${ref.date}:${ref.language}`;
}

export function getDigest(cache: KVNamespace, ref: DigestRef): Promise<string | null> {
  return cache.get(digestCacheKey(ref));
}

export async function putDigest(
  cache: KVNamespace,
  ref: DigestRef,
  xml: string,
): Promise<void> {
  await cache.put(digestCacheKey(ref), xml, { expirationTtl: DIGEST_TTL_SECONDS });
}
