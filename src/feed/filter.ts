import type { FeedEntry } from "./parse";

export function filterEntriesFromLast24Hours(
  entries: FeedEntry[],
  now: Date = new Date(),
): FeedEntry[] {
  const cutoff = now.getTime() - 24 * 60 * 60 * 1000;

  return entries.filter((entry) => {
    const dateText = entry.isoDate ?? entry.pubDate;
    if (!dateText) return false;
    const publishedAt = Date.parse(dateText);
    return Number.isFinite(publishedAt) && publishedAt >= cutoff && publishedAt <= now.getTime();
  });
}
