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
 * Elements whose content is not markup: dropping the tags alone would leave
 * the script body as visible text, so both go.
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
 * The `href` of a link the reader can safely follow, already escaped, or null.
 *
 * The value is decoded first: `java&#115;cript:` reaches the reader as a
 * working `javascript:` url, so the scheme has to be judged after decoding.
 * `URL` then re-encodes what it accepted, which is what gets written back.
 */
function safeHref(attributes: string): string | null {
  const match = HREF_PATTERN.exec(attributes);
  if (!match) return null;

  const raw = decodeHtmlEntities(match[1] ?? match[2] ?? match[3] ?? "");
  try {
    const url = new URL(raw);
    // Relative urls end up here too: they would resolve against the reader's
    // own page rather than the source, so only absolute http(s) urls survive.
    return /^https?:$/.test(url.protocol) ? escapeText(url.toString()) : null;
  } catch {
    return null;
  }
}

function openTag(tag: string, attributes: string): string {
  if (tag !== "a") return `<${tag}>`;

  const href = safeHref(attributes);
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
 * trusted to be markup, or to be safe.
 */
export function sanitizeLlmHtml(raw: string): string {
  const source = raw
    .replace(RAW_TEXT_PATTERN, "")
    .replace(DECLARATION_PATTERN, "")
    .replace(CODE_FENCE_PATTERN, "");

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
    parts.push(openTag(tag, attributes));
  }

  parts.push(renderText(source.slice(cursor)));
  // Whatever the model left open is closed here, so the body stays well-formed.
  parts.push(open.reverse().map((tag) => `</${tag}>`).join(""));

  return parts.join("").trim();
}
