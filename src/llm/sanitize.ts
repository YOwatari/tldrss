import { decode as decodeHtmlEntities } from "html-entities";

/**
 * Reducing the model's answer to plain text. Nothing the model writes reaches
 * a reader as markup or as a link: the answer is prompted with feed text,
 * which is attacker-controlled, so neither its tags nor its urls are trusted.
 */

/**
 * A self-closed `<script/>` opens nothing, so only the tag goes. An html
 * parser would read it as an opening tag and swallow the rest of the answer,
 * but removing the tag alone leaves nothing executable behind either way.
 */
const SELF_CLOSED_RAW_TEXT_PATTERN = /<(?:script|style)\b(?:"[^"]*"|'[^']*'|[^>"'])*\/>/gi;

/**
 * Elements whose content is not text: dropping the tags alone would leave
 * the script body as visible text, so both go. A tag left unterminated takes
 * the rest of the answer with it — everything after it is script body.
 */
const RAW_TEXT_PATTERN = /<(script|style)\b[\s\S]*?(?:<\/\1\s*>|$)/gi;

/** `<!-- ... -->` and `<!doctype ...>`. */
const DECLARATION_PATTERN = /<!--[\s\S]*?(?:-->|$)|<![^>]*>?/g;

/** ```` ```html ```` and its bare form, which models wrap answers in. */
const CODE_FENCE_PATTERN = /```[a-zA-Z]*/g;

function withoutNonMarkup(raw: string): string {
  return raw
    .replace(SELF_CLOSED_RAW_TEXT_PATTERN, "")
    .replace(RAW_TEXT_PATTERN, "")
    .replace(DECLARATION_PATTERN, "")
    .replace(CODE_FENCE_PATTERN, "");
}

/** Tags that separate blocks of text, and so become a space rather than nothing. */
const BLOCK_TAGS = new Set([
  "address", "article", "aside", "blockquote", "br", "dd", "div", "dl", "dt", "figcaption", "figure",
  "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre",
  "section", "table", "td", "th", "tr", "ul",
]);

/** One tag, tolerating quoted attribute values that contain `>`. */
const TAG_PATTERN = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>?/g;

// Printable ASCII only: urls are ASCII here, and \S would also swallow Japanese text glued after one.
const URL_PATTERN = /https?:\/\/[\x21-\x7e]*/gi;

/**
 * The model's answer as one line of plain text, for places that cannot carry
 * markup. Entities are decoded because the renderer escapes the text again;
 * leaving them encoded would show `&amp;` to the reader.
 */
export function plainTextOf(raw: string): string {
  // Block boundaries become a space so that adjacent paragraphs do not fuse
  // into one word, which would also let url removal swallow the next word.
  // Inline tags are dropped without one, so `<strong>a</strong>b` stays `ab`.
  const text = withoutNonMarkup(raw).replace(TAG_PATTERN, (_match, _closing, name: string) =>
    BLOCK_TAGS.has(name.toLowerCase()) ? " " : "",
  );
  return decodeHtmlEntities(text)
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * `text` without any http(s) url, its whitespace collapsed. Text that reaches
 * Slack must carry no url, or Slack unfurls it; and a url the model wrote is
 * no evidence the url exists.
 */
export function withoutUrls(text: string): string {
  return text.replace(URL_PATTERN, "").replace(/\s+/g, " ").trim();
}
