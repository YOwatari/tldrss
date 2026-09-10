import type { FeedEntry } from "./parse";

/** The digest covers one day, so entries older than this are out of scope. */
const WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Entries handed to the model when `MAX_ENTRIES` is unset. A busy feed can
 * publish far more in a day than fits a prompt, so the window alone is not a
 * bound; see `env.ts` for how the override is read.
 */
export const DEFAULT_MAX_ENTRIES = 30;

export type EntrySelection = {
  /** The entries to summarize, newest first and capped. */
  entries: FeedEntry[];
  /**
   * How many dated entries the window held before the cap applied. The prompt
   * tells the model when it is seeing a subset, so it needs the full count.
   */
  availableCount: number;
};

/** Publication time in epoch ms, or null when the feed gave none we can read. */
function publishedAt(entry: FeedEntry): number | null {
  const dateText = entry.isoDate ?? entry.pubDate;
  if (!dateText) return null;

  const timestamp = Date.parse(dateText);
  return Number.isFinite(timestamp) ? timestamp : null;
}

/**
 * The entries of the last 24 hours, newest first, capped at `maxEntries`.
 *
 * Undated entries are dropped rather than assumed recent: a feed that omits
 * dates would otherwise have its whole backlog summarized every day. Entries
 * dated ahead of `now` are dropped for the same reason — a feed with a skewed
 * clock could pin them to the top of every digest.
 *
 * The numbering the prompt uses is the position in the returned list, so
 * anything that resolves those numbers has to read the same list.
 */
export function selectRecentEntries(
  entries: FeedEntry[],
  options: { now?: Date; maxEntries?: number } = {},
): EntrySelection {
  const nowMs = (options.now ?? new Date()).getTime();
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const cutoff = nowMs - WINDOW_MS;

  const dated = entries
    .map((entry) => ({ entry, at: publishedAt(entry) }))
    .filter((item): item is { entry: FeedEntry; at: number } => item.at !== null)
    .filter((item) => item.at >= cutoff && item.at <= nowMs)
    // Feeds are not required to be newest-first, so order before capping.
    .sort((left, right) => right.at - left.at);

  return {
    entries: dated.slice(0, maxEntries).map((item) => item.entry),
    availableCount: dated.length,
  };
}
