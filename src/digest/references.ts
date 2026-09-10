import type { FeedEntry } from "../feed/parse";

/**
 * `[3] Something happened.` — the shape each bullet of the model's answer is
 * asked to take. A leading list marker is tolerated because models add one.
 */
const BULLET_PATTERN = /^\s*(?:[-*•]\s*)?\[(\d+)\]\s*(.+)$/;

/**
 * Escapes text for HTML. `escapeXml` in `rss.ts` serves a different layer: the
 * digest body is HTML nested inside an XML element, so it is escaped twice.
 */
function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Pairs each bullet with the entry its number refers to, keeping feed order.
 * Numbers the model invented resolve to nothing and are dropped, so a bullet
 * can never end up under the wrong article.
 */
function resolveBullets(
  summary: string,
  entries: FeedEntry[],
): { lead: string[]; byEntry: Map<number, string>; sawBullet: boolean } {
  const byEntry = new Map<number, string>();
  const lead: string[] = [];
  let sawBullet = false;

  for (const line of summary.split("\n")) {
    const match = BULLET_PATTERN.exec(line);
    if (!match) {
      // Prose introducing the digest; anything after the bullets is the
      // model padding its answer and is dropped.
      if (!sawBullet && line.trim() !== "") lead.push(line.trim());
      continue;
    }
    sawBullet = true;

    const index = Number(match[1]) - 1;
    // Keep the first take when the model covers one entry twice.
    if (!entries[index] || byEntry.has(index)) continue;

    byEntry.set(index, match[2].trim());
  }

  return { lead, byEntry, sawBullet };
}

function renderItem(entry: FeedEntry, summary: string): string {
  // Title and url come from the feed, never from the model.
  const title = escapeHtml(entry.title ?? "(untitled)");
  const heading = entry.link ? `<a href="${escapeHtml(entry.link)}">${title}</a>` : title;

  return `  <li>${heading}<br />${escapeHtml(summary)}</li>`;
}

/**
 * Renders the digest body as an HTML fragment: an optional lead paragraph
 * followed by one linked article per bullet, built from the feed rather than
 * from the model's own formatting.
 */
export function renderDigestHtml(summary: string, entries: FeedEntry[]): string {
  const { lead, byEntry, sawBullet } = resolveBullets(summary, entries);

  // The model ignored the format, or there was nothing to summarize at all.
  if (!sawBullet) {
    return escapeHtml(summary)
      .split("\n")
      .map((line) => line.trimEnd())
      .join("<br />");
  }

  const items = entries
    .map((entry, index) => {
      const bullet = byEntry.get(index);
      return bullet === undefined ? null : renderItem(entry, bullet);
    })
    .filter((item) => item !== null);

  // Every bullet cited an entry that does not exist; nothing can be shown.
  if (items.length === 0) return "";

  const paragraph =
    lead.length === 0 ? "" : `<p>${lead.map(escapeHtml).join("<br />")}</p>\n`;

  return `${paragraph}<ul>\n${items.join("\n")}\n</ul>`;
}
