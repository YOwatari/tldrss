/**
 * The digest body as an HTML fragment. Everything a reader sees is built here
 * from the feed, so the model's answer only ever contributes prose.
 */
import type { FeedEntry } from "../feed/parse";
import { sanitizeLlmHtml } from "../llm/sanitize";
import { DEFAULT_LANGUAGE, type DigestLanguage } from "./language";
import { untitledEntryText } from "./text";

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

/**
 * Last resort: the model's own answer, reduced to markup a digest may carry.
 *
 * The prompt asks for plain lines, so this is usually just escaped text. A
 * model that answers in html anyway is the reason it goes through the
 * sanitizer rather than straight through `escapeHtml`.
 */
function renderRawText(summary: string): string {
  return sanitizeLlmHtml(summary);
}

/**
 * The href of a link the reader can safely follow, or null.
 *
 * Escaping alone would not help here: a feed-controlled `javascript:` or
 * `data:` url stays active once the reader decodes the html. Entries can also
 * carry a guid in place of a link (see `parse.ts`), which would render as a
 * broken relative link, so only absolute http(s) urls become anchors.
 */
function safeHref(link: string | undefined): string | null {
  if (link === undefined) return null;

  try {
    const url = new URL(link);
    return /^https?:$/.test(url.protocol) ? link : null;
  } catch {
    return null;
  }
}

function renderItem(entry: FeedEntry, summary: string, language: DigestLanguage): string {
  // Title and url come from the feed, never from the model.
  const title = escapeHtml(entry.title ?? untitledEntryText(language));
  const href = safeHref(entry.link);
  const heading = href === null ? title : `<a href="${escapeHtml(href)}">${title}</a>`;

  return `  <li>${heading}<br />${escapeHtml(summary)}</li>`;
}

/**
 * Renders the digest body as an HTML fragment: an optional lead paragraph
 * followed by one linked article per bullet, built from the feed rather than
 * from the model's own formatting.
 */
export function renderDigestHtml(
  summary: string,
  entries: FeedEntry[],
  language: DigestLanguage = DEFAULT_LANGUAGE,
): string {
  const { lead, byEntry, sawBullet } = resolveBullets(summary, entries);

  // The model ignored the format, or there was nothing to summarize at all.
  if (!sawBullet) return renderRawText(summary);

  const items = entries
    .map((entry, index) => {
      const bullet = byEntry.get(index);
      return bullet === undefined ? null : renderItem(entry, bullet, language);
    })
    .filter((item) => item !== null);

  // Not one bullet resolved to an entry. Showing the model's own text keeps
  // something readable in the feed rather than an empty digest.
  if (items.length === 0) return renderRawText(summary);

  const paragraph =
    lead.length === 0 ? "" : `<p>${lead.map(escapeHtml).join("<br />")}</p>\n`;

  return `${paragraph}<ul>\n${items.join("\n")}\n</ul>`;
}
