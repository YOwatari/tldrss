/**
 * The item `<description>` Slack shows under the digest's title.
 *
 * Slack counts tags toward its length limit and cuts wherever the limit falls,
 * so a cut inside a tag leaves a raw `<a href>` in the post (seen in the
 * 2026-10-12 weekly). The budget is therefore kept here, on the escaped html,
 * rather than left to Slack.
 *
 * No entry links: Slack offers no feed-side way to stop unfurling them, and
 * routing them through a relay url of ours would make it an open redirector.
 */
import type { FeedEntry } from "../feed/parse";
import type { DigestLanguage } from "./language";
import { escapeHtml } from "./html";
import { moreEntriesText, untitledEntryText } from "./text";

export const DEFAULT_DESCRIPTION_MAX_CHARS = 450;
export const MIN_DESCRIPTION_MAX_CHARS = 100;

// Printable ASCII only: urls are ASCII here, and \S would also swallow Japanese text glued after one.
const URL_PATTERN = /https?:\/\/[\x21-\x7e]*/gi;
const SENTENCE_END = /[。．.!?！？]/u;
const ELLIPSIS = "…";

function withoutUrls(text: string): string {
  return text.replace(URL_PATTERN, "").replace(/\s+/g, " ").trim();
}

function paragraph(text: string): string {
  return `<p>${escapeHtml(text)}</p>`;
}

function list(titles: string[]): string {
  return titles.length === 0 ? "" : `<ul>${titles.map((title) => `<li>${escapeHtml(title)}</li>`).join("")}</ul>`;
}

/**
 * The longest non-empty prefix of `chars` that `fits`, or null. Prefixes are
 * cut by code point and measured after escaping, so neither a surrogate pair
 * nor an entity is ever split.
 */
function longestFittingPrefix(chars: string[], fits: (prefix: string) => boolean): string | null {
  let low = 0;
  let high = chars.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(chars.slice(0, mid).join(""))) low = mid;
    else high = mid - 1;
  }
  return low === 0 ? null : chars.slice(0, low).join("");
}

function renderLead(lead: string, budget: number): string {
  if (lead === "") return "";

  const whole = paragraph(lead);
  if (whole.length <= budget) return whole;

  const cut = (prefix: string) => paragraph(prefix + ELLIPSIS);
  const fits = (prefix: string) => cut(prefix).length <= budget;
  const chars = Array.from(lead);

  for (let end = chars.length - 1; end > 0; end--) {
    if (!SENTENCE_END.test(chars[end - 1])) continue;
    const prefix = chars.slice(0, end).join("");
    if (fits(prefix)) return cut(prefix);
  }

  const prefix = longestFittingPrefix(chars, fits);
  return prefix === null ? "" : cut(prefix);
}

const LIST_MARKUP = "<ul></ul><li></li>";

/**
 * Room held back from the lead so the first title can be listed whole. It is
 * capped at half of what lead and list share: reserving a title of any length
 * would let one oversized title (which gets truncated anyway) starve the lead.
 */
function firstTitleReserve(titles: string[], shared: number): number {
  if (titles.length === 0) return 0;
  const half = Math.floor((shared - LIST_MARKUP.length) / 2);
  return LIST_MARKUP.length + Math.min(escapeHtml(titles[0]).length, half);
}

/**
 * Lead, then as many whole titles as fit in feed order, then how many were
 * left out. Everything is measured as the html Slack receives.
 */
export function renderDescriptionHtml(params: {
  lead: string;
  entries: FeedEntry[];
  availableCount: number;
  language: DigestLanguage;
  maxChars: number;
}): string {
  const { entries, availableCount, language, maxChars } = params;
  const titles = entries.map((entry) => withoutUrls(entry.title ?? "") || untitledEntryText(language));
  const remainder = (listed: number) => {
    const left = availableCount - listed;
    return left > 0 ? paragraph(moreEntriesText(left, language)) : "";
  };

  const plainLead = withoutUrls(params.lead);
  // The budgets below reserve room for a remainder line, which a day where
  // everything fits never shows; trying the whole description first keeps
  // that reserve from cutting a lead that fits.
  const whole = (plainLead === "" ? "" : paragraph(plainLead)) + list(titles) + remainder(titles.length);
  if (whole.length <= maxChars) return whole;

  const shared = maxChars - remainder(0).length;
  const leadBudget = shared - firstTitleReserve(titles, shared);
  const lead = renderLead(plainLead, leadBudget);

  const render = (listed: string[]) => lead + list(listed) + remainder(listed.length);

  let k = 0;
  // Stopping at the first misfit, rather than filling with a later shorter
  // title, keeps the listed entries the newest ones.
  while (k < titles.length && render(titles.slice(0, k + 1)).length <= maxChars) k++;
  if (k > 0 || titles.length === 0) return render(titles.slice(0, k));

  const firstTitle = longestFittingPrefix(
    Array.from(titles[0]),
    (prefix) => render([prefix + ELLIPSIS]).length <= maxChars,
  );
  return firstTitle === null ? render([]) : render([firstTitle + ELLIPSIS]);
}
