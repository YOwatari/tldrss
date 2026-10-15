/**
 * The full-text page's body as an HTML fragment. Everything a reader sees is
 * built here from the feed, so the model's answer only ever contributes the
 * lead, as plain text.
 */
import type { FeedEntry } from "../feed/parse";
import { plainTextOf, withoutUrls } from "../llm/sanitize";
import { DEFAULT_LANGUAGE, type DigestLanguage } from "./language";
import { pageMoreEntriesText, untitledEntryText } from "./text";

/**
 * `[3] Something happened.` — the per-entry bullet the prompt used to ask for.
 * The prompt no longer does, but a model may still add them out of habit.
 */
const BULLET_PATTERN = /^\s*(?:[-*•]\s*)?\[(\d+)\]\s*(.+)$/;

/** Tags that break a line of the answer: paragraphs, list items, line breaks. */
const BLOCK_TAG_PATTERN = /<\/?(?:p|div|ul|ol|li|br|h[1-6])\b[^>]*>/gi;

/**
 * Escapes text for HTML. `escapeXml` in `rss.ts` serves a different layer: the
 * digest body is HTML nested inside an XML element, so it is escaped twice.
 */
export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * The lead in the model's answer, as plain text: no markup, no urls.
 *
 * The prompt asks for the lead alone. Should the model still list entries,
 * only the prose before its first bullet is kept: the reader sees every title
 * below the lead already. The answer is never trusted to be markup, and a url
 * in it is no evidence the url exists — the model is prompted with
 * attacker-controlled feed text — so both are reduced to text. An empty
 * result means the answer held no lead, which the caller treats as a failure
 * to summarize.
 */
export function leadOf(summary: string): string {
  // Block tags end a line, so a bullet wrapped in `<li>` is found too.
  const lines = summary.replace(BLOCK_TAG_PATTERN, "\n").split("\n");
  const firstBullet = lines.findIndex((line) => BULLET_PATTERN.test(line));
  const prose = firstBullet === -1 ? summary : lines.slice(0, firstBullet).join("\n");

  return withoutUrls(plainTextOf(prose));
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

/** The entry's title, linked to the article when the feed gave a usable url. */
function renderHeading(entry: Pick<FeedEntry, "title" | "link">, language: DigestLanguage): string {
  // Title and url come from the feed, never from the model.
  const title = escapeHtml(entry.title ?? untitledEntryText(language));
  const href = safeHref(entry.link);

  return href === null ? title : `<a href="${escapeHtml(href)}">${title}</a>`;
}

/**
 * Renders the full-text page's body: the lead, then every selected entry
 * linked to its article, newest first, then how many the period held beyond
 * `MAX_ENTRIES`.
 */
export function renderDigestBodyHtml(params: {
  lead: string;
  entries: Pick<FeedEntry, "title" | "link">[];
  availableCount: number;
  language?: DigestLanguage;
}): string {
  const { lead, entries, availableCount, language = DEFAULT_LANGUAGE } = params;
  const parts: string[] = [];

  if (lead !== "") parts.push(`<p>${escapeHtml(lead)}</p>`);
  if (entries.length > 0) {
    const items = entries.map((entry) => `  <li>${renderHeading(entry, language)}</li>`);
    parts.push(`<ul>\n${items.join("\n")}\n</ul>`);
  }

  const left = availableCount - entries.length;
  if (left > 0) parts.push(`<p>${escapeHtml(pageMoreEntriesText(left, entries.length, language))}</p>`);

  return parts.join("\n");
}
