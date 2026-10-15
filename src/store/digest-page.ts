/**
 * The digest kept for the full-text page.
 *
 * Slack shows only the first lines of an item's `<description>`, so the item
 * links to a page instead. The digest is stored beside the xml rather than
 * parsed back out of it, and as data rather than markup: the page renders it
 * at serve time (see `renderDigestBodyHtml`).
 */
import { digestCacheSuffix, digestTtlSeconds } from "../digest/period";
import type { DigestRef } from "./digest-ref";

/** One listed entry: only what the page shows. */
export type DigestPageEntry = { title?: string; link?: string };

/** What the page needs to render: whose feed it is, the lead and the entries. */
export type DigestPage = {
  feedTitle: string;
  /** Plain text; see `Digest.lead`. */
  lead: string;
  /** The selected entries, newest first. */
  entries: DigestPageEntry[];
  /** How many entries the period had before `MAX_ENTRIES`; at least `entries.length`. */
  availableCount: number;
};

/**
 * The record written before the page was stored as data: the body as a
 * sanitized HTML fragment. It is still served as it was until its TTL runs
 * out, since a Slack post made before the change links to it.
 */
export type LegacyDigestPage = {
  feedTitle: string;
  html: string;
};

export type StoredDigestPage = DigestPage | LegacyDigestPage;

export function isLegacyDigestPage(page: StoredDigestPage): page is LegacyDigestPage {
  return "html" in page;
}

export function digestPageKey(ref: DigestRef): string {
  return `digest-html:${ref.hash}:${ref.date}:${ref.language}${digestCacheSuffix(ref.period)}`;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isEntry(value: unknown): value is DigestPageEntry {
  if (typeof value !== "object" || value === null) return false;

  const entry = value as Record<string, unknown>;
  return isOptionalString(entry.title) && isOptionalString(entry.link);
}

/** Whether a value read back from KV is a record this module wrote. */
function isStoredDigestPage(value: unknown): value is StoredDigestPage {
  if (typeof value !== "object" || value === null) return false;

  const record = value as Record<string, unknown>;
  if (typeof record.feedTitle !== "string") return false;
  if (typeof record.html === "string") return true;

  return (
    typeof record.lead === "string" &&
    Array.isArray(record.entries) &&
    record.entries.every(isEntry) &&
    typeof record.availableCount === "number"
  );
}

/**
 * The stored page, or null when there is none.
 *
 * A value that does not parse, or that is neither record shape, is treated as
 * absent: a 404 is a better answer than a page reading "undefined" — or a
 * 500 — for something the next generation rewrites anyway.
 */
export async function getDigestPage(
  cache: KVNamespace,
  ref: DigestRef,
): Promise<StoredDigestPage | null> {
  const stored = await cache.get(digestPageKey(ref));
  if (stored === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return null;
  }

  return isStoredDigestPage(parsed) ? parsed : null;
}

export async function putDigestPage(
  cache: KVNamespace,
  ref: DigestRef,
  page: DigestPage,
): Promise<void> {
  const record: DigestPage = {
    feedTitle: page.feedTitle,
    lead: page.lead,
    // Excerpts and dates are not shown, so they are not stored either.
    entries: page.entries.map(({ title, link }) => ({ title, link })),
    availableCount: page.availableCount,
  };

  await cache.put(digestPageKey(ref), JSON.stringify(record), {
    expirationTtl: digestTtlSeconds(ref.period),
  });
}
