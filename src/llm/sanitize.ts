import { decode as decodeHtmlEntities } from "html-entities";

/**
 * Tags a digest body may contain. Everything a reader needs for a lead
 * paragraph and a list of linked articles, and nothing that can execute,
 * load a resource, or style the page around it.
 */
const ALLOWED_TAGS = new Set(["p", "h3", "ul", "li", "a", "strong", "br"]);

/** Allowed tags that carry no content and so are never closed. */
const VOID_TAGS = new Set(["br"]);

/**
 * A self-closed `<script/>` opens nothing, so only the tag goes. An html
 * parser would read it as an opening tag and swallow the rest of the document,
 * but here that would cost the digest every entry after a single stray tag,
 * and removing the tag alone leaves nothing executable behind either way.
 */
const SELF_CLOSED_RAW_TEXT_PATTERN = /<(?:script|style)\b(?:"[^"]*"|'[^']*'|[^>"'])*\/>/gi;

/**
 * Elements whose content is not markup: dropping the tags alone would leave
 * the script body as visible text, so both go. A tag left unterminated takes
 * the rest of the answer with it — everything after it is script body.
 */
const RAW_TEXT_PATTERN = /<(script|style)\b[\s\S]*?(?:<\/\1\s*>|$)/gi;

/** `<!-- ... -->` and `<!doctype ...>`; neither survives into a digest. */
const DECLARATION_PATTERN = /<!--[\s\S]*?(?:-->|$)|<![^>]*>?/g;

/** ```` ```html ```` and its bare form, which models wrap answers in. */
const CODE_FENCE_PATTERN = /```[a-zA-Z]*/g;

/** One tag, tolerating quoted attribute values that contain `>`. */
const TAG_PATTERN = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>?/g;

const HREF_PATTERN = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

/** An entity already in the text stays as it is; a bare `&` becomes one. */
const BARE_AMPERSAND = /&(?!#\d+;|#[xX][0-9a-fA-F]+;|[a-zA-Z][a-zA-Z0-9]*;)/g;

function escapeText(text: string): string {
  return text
    .replace(BARE_AMPERSAND, "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * A text node, with its line breaks made visible.
 *
 * A model that ignores the format answers in plain lines, and a feed reader
 * renders a raw newline as a space, so the digest would collapse into one
 * paragraph. Whitespace that only separates two tags carries no such meaning
 * and is dropped instead.
 */
function renderText(text: string): string {
  const lines = text.split("\n");
  if (lines.length === 1) return escapeText(text);

  return lines
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map(escapeText)
    .join("<br />");
}

/**
 * One absolute http(s) url in the spelling `URL` settles on, or null.
 *
 * The value is decoded first: `java&#115;cript:` reaches the reader as a
 * working `javascript:` url, so the scheme has to be judged after decoding.
 * Relative urls end up as null too — they would resolve against the reader's
 * own page rather than the source.
 */
function normalizeUrl(raw: string): string | null {
  try {
    const url = new URL(decodeHtmlEntities(raw));
    return /^https?:$/.test(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * The `href` of a link the digest may carry, already escaped, or null.
 *
 * A url the model wrote is not evidence that the url exists: the model is
 * prompted with feed text, which is attacker-controlled, so an answer can
 * carry a link the feed never published. Only the urls the caller vouched for
 * survive; the scheme check alone would leave phishing links working.
 */
function safeHref(attributes: string, allowed: Set<string>): string | null {
  const match = HREF_PATTERN.exec(attributes);
  if (!match) return null;

  const url = normalizeUrl(match[1] ?? match[2] ?? match[3] ?? "");
  if (url === null || !allowed.has(url)) return null;

  return escapeText(url);
}

function openTag(tag: string, attributes: string, allowed: Set<string>): string {
  if (tag !== "a") return `<${tag}>`;

  const href = safeHref(attributes, allowed);
  // A link with no usable target keeps its text but stops being a link.
  return href === null ? "<a>" : `<a href="${href}">`;
}

/** Closes `stack` down to and including `tag`, or nothing when it is not open. */
function closeDownTo(stack: string[], tag: string): string {
  const depth = stack.lastIndexOf(tag);
  if (depth === -1) return "";

  return stack.splice(depth).reverse().map((open) => `</${open}>`).join("");
}

/**
 * The model's answer reduced to markup a digest may carry: the allowed tags,
 * balanced, with every attribute but a safe `href` removed, and all remaining
 * text escaped.
 *
 * The renderer builds the digest body itself and does not need this — see
 * `digest/html.ts`. It is the guard on the one path where the model's
 * own formatting reaches the reader, so nothing the model writes has to be
 * trusted to be markup, to be safe, or to point where it claims.
 */
export type SanitizeOptions = {
  /**
   * The urls an anchor may point at, in any spelling. Anything else keeps its
   * text and loses its link, so a digest can only ever link where the caller
   * says the feed does.
   */
  allowedHrefs?: Iterable<string>;
};

export function sanitizeLlmHtml(raw: string, options: SanitizeOptions = {}): string {
  const source = raw
    .replace(SELF_CLOSED_RAW_TEXT_PATTERN, "")
    .replace(RAW_TEXT_PATTERN, "")
    .replace(DECLARATION_PATTERN, "")
    .replace(CODE_FENCE_PATTERN, "");

  const allowed = new Set(
    [...(options.allowedHrefs ?? [])]
      .map(normalizeUrl)
      .filter((url): url is string => url !== null),
  );

  const parts: string[] = [];
  const open: string[] = [];
  let cursor = 0;

  TAG_PATTERN.lastIndex = 0;
  for (let match = TAG_PATTERN.exec(source); match; match = TAG_PATTERN.exec(source)) {
    parts.push(renderText(source.slice(cursor, match.index)));
    cursor = match.index + match[0].length;

    const [, closing, rawTag, attributes] = match;
    const tag = rawTag.toLowerCase();
    // A disallowed tag is dropped; the text it wrapped is kept.
    if (!ALLOWED_TAGS.has(tag)) continue;

    if (VOID_TAGS.has(tag)) {
      if (!closing) parts.push(`<${tag} />`);
      continue;
    }

    if (closing) {
      parts.push(closeDownTo(open, tag));
      continue;
    }

    open.push(tag);
    parts.push(openTag(tag, attributes, allowed));
  }

  parts.push(renderText(source.slice(cursor)));
  // Whatever the model left open is closed here, so the body stays well-formed.
  parts.push(open.reverse().map((tag) => `</${tag}>`).join(""));

  return parts.join("").trim();
}
