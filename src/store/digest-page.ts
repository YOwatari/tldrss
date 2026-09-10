/**
 * The digest body kept for the full-text page.
 *
 * Slack shows only the first lines of an item's `<description>`, so the item
 * links to a page instead. The body is stored beside the xml rather than
 * parsed back out of it: the page then never has to unwrap a CDATA section to
 * find the html it is about to serve.
 */
import { DIGEST_TTL_SECONDS } from "./digest-cache";
import type { DigestRef } from "./digest-ref";

/** What the page needs to render: the digest body and whose feed it is. */
export type DigestPage = {
  feedTitle: string;
  /** Sanitized HTML fragment; see `renderDigestHtml`. */
  html: string;
};

export function digestPageKey(ref: DigestRef): string {
  return `digest-html:${ref.hash}:${ref.date}:${ref.language}`;
}

/** Whether a value read back from KV is a record this module wrote. */
function isDigestPage(value: unknown): value is DigestPage {
  if (typeof value !== "object" || value === null) return false;

  const record = value as Record<string, unknown>;
  return typeof record.feedTitle === "string" && typeof record.html === "string";
}

/**
 * The stored page, or null when there is none.
 *
 * A value that does not parse, or that is not this record, is treated as
 * absent: it can only come from an older shape of this record, and a 404 is a
 * better answer than a page reading "undefined" — or a 500 — for something the
 * next generation rewrites anyway.
 */
export async function getDigestPage(
  cache: KVNamespace,
  ref: DigestRef,
): Promise<DigestPage | null> {
  const stored = await cache.get(digestPageKey(ref));
  if (stored === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return null;
  }

  return isDigestPage(parsed) ? parsed : null;
}

export async function putDigestPage(
  cache: KVNamespace,
  ref: DigestRef,
  page: DigestPage,
): Promise<void> {
  await cache.put(digestPageKey(ref), JSON.stringify(page), {
    expirationTtl: DIGEST_TTL_SECONDS,
  });
}
