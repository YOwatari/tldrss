import { XMLParser } from "fast-xml-parser";

/**
 * Feed entry contract shared by the rest of the worker.
 * Field names intentionally match what `rss-parser` used to produce so that
 * downstream code (filtering, prompt building) stays untouched.
 */
export type FeedEntry = {
  title?: string;
  link?: string;
  contentSnippet?: string;
  content?: string;
  pubDate?: string;
  isoDate?: string;
};

export type ParsedFeed = {
  title?: string;
  link?: string;
  items: FeedEntry[];
};

/**
 * With `preserveOrder`, every node is an object with exactly one tag key whose
 * value is the ordered child list, plus an optional attribute bag under ":@".
 * Text nodes use the "#text" key. Keeping document order matters for Atom
 * `type="xhtml"` constructs, whose text is mixed with markup.
 */
type OrderedNode = Record<string, unknown>;

const ATTRIBUTES_KEY = ":@";
const TEXT_KEY = "#text";

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseTagValue: false,
  parseAttributeValue: false,
  // Whitespace around text nodes carries meaning in mixed content
  // (`<title>Git<b>Hub</b>!</title>`), so it is normalized at the end instead.
  trimValues: false,
});

function normalizeText(text: string): string {
  return text.replaceAll(/\s+/g, " ").trim();
}

function tagName(node: OrderedNode): string {
  return Object.keys(node).find((key) => key !== ATTRIBUTES_KEY) ?? "";
}

/** `fast-xml-parser` keeps namespace prefixes, so `<atom:entry>` must match "entry" too. */
function localName(name: string): string {
  const separator = name.indexOf(":");
  return separator === -1 ? name : name.slice(separator + 1);
}

function prefixOf(name: string): string {
  const separator = name.indexOf(":");
  return separator === -1 ? "" : name.slice(0, separator);
}

function isOrderedNode(value: unknown): value is OrderedNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function childrenOf(node: OrderedNode): OrderedNode[] {
  const value = node[tagName(node)];
  return Array.isArray(value) ? value.filter(isOrderedNode) : [];
}

function attributesOf(node: OrderedNode): Record<string, string> {
  const attributes = node[ATTRIBUTES_KEY];
  return isOrderedNode(attributes) ? (attributes as Record<string, string>) : {};
}

/**
 * Exact tag names win across the whole list before local names are considered,
 * so `<content>` beats a `<media:content>` extension that happens to share its
 * local name, while prefixed documents (`<atom:entry>`) and prefixed RSS
 * extensions (`content:encoded`) both still resolve.
 *
 * When only local names match, children carrying the container's own prefix win:
 * inside `<atom:entry>`, `<atom:title>` beats a `<media:title>` extension.
 */
function findAll(nodes: OrderedNode[], name: string, preferredPrefix = ""): OrderedNode[] {
  const exact = nodes.filter((node) => tagName(node) === name);
  if (exact.length > 0) return exact;

  const byLocalName = nodes.filter((node) => localName(tagName(node)) === name);
  const preferred = byLocalName.filter((node) => prefixOf(tagName(node)) === preferredPrefix);
  return preferred.length > 0 ? preferred : byLocalName;
}

function find(nodes: OrderedNode[], name: string, preferredPrefix = ""): OrderedNode | undefined {
  return findAll(nodes, name, preferredPrefix)[0];
}

/**
 * Concatenates the text of a child list in document order, descending into
 * nested markup — the same shape as DOM `textContent`, so inline markup never
 * inserts or drops characters.
 */
function textOf(nodes: OrderedNode[]): string {
  let text = "";

  for (const node of nodes) {
    if (tagName(node) === TEXT_KEY) {
      const value = node[TEXT_KEY];
      if (typeof value === "string") text += value;
      continue;
    }
    text += textOf(childrenOf(node));
  }

  return text;
}

function firstText(
  nodes: OrderedNode[],
  names: string[],
  preferredPrefix = "",
): string | undefined {
  for (const name of names) {
    const node = find(nodes, name, preferredPrefix);
    if (!node) continue;
    const value = normalizeText(textOf(childrenOf(node)));
    if (value.length > 0) return value;
  }
  return undefined;
}

/**
 * RSS keeps the URL in the element text; Atom keeps it in a `href` attribute and
 * may repeat `<link>` for other relations (`self`, `edit`, enclosures).
 */
function extractLink(nodes: OrderedNode[], preferredPrefix = ""): string | undefined {
  const links = findAll(nodes, "link", preferredPrefix);

  for (const link of links) {
    const { href, rel } = attributesOf(link);
    const url = href === undefined ? "" : normalizeText(href);
    if (url.length > 0 && (rel === undefined || normalizeText(rel) === "alternate")) return url;
  }

  for (const link of links) {
    const value = normalizeText(textOf(childrenOf(link)));
    if (value.length > 0) return value;
  }

  return undefined;
}

/**
 * Only markup-shaped constructs are stripped: entities are already decoded by
 * this point, so plain text such as "1 < 2 and 3 > 1" must survive intact.
 */
const HTML_TAG = /<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>/g;

function stripHtml(html: string): string {
  return normalizeText(html.replaceAll(HTML_TAG, " ").replaceAll(/&nbsp;/g, " "));
}

function toIsoDate(dateText: string | undefined): string | undefined {
  if (!dateText) return undefined;
  const timestamp = Date.parse(dateText);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function toEntry(entry: OrderedNode): FeedEntry {
  const fields = childrenOf(entry);
  const prefix = prefixOf(tagName(entry));
  const pubDate = firstText(
    fields,
    ["pubDate", "published", "updated", "dc:date", "date"],
    prefix,
  );
  const summary = firstText(fields, ["description", "summary"], prefix);
  const content = firstText(fields, ["content:encoded", "content"], prefix);
  // Content-only feeds still get a cleaned snippet; `content` keeps the markup.
  const snippetSource = summary ?? content;

  return {
    title: firstText(fields, ["title"], prefix),
    link: extractLink(fields, prefix) ?? firstText(fields, ["guid", "id"], prefix),
    contentSnippet: snippetSource === undefined ? undefined : stripHtml(snippetSource),
    content,
    pubDate,
    isoDate: toIsoDate(pubDate),
  };
}

/**
 * Parses an RSS 2.0 or Atom document. Throws when the XML itself is malformed;
 * a well-formed document that is not a feed yields an empty item list.
 */
export function parseFeed(xml: string): ParsedFeed {
  const document = parser.parse(xml, true) as unknown;
  if (!Array.isArray(document)) return { items: [] };
  const roots = document.filter(isOrderedNode);

  const rss = find(roots, "rss");
  if (rss) {
    const rssPrefix = prefixOf(tagName(rss));
    const channel = find(childrenOf(rss), "channel", rssPrefix);
    if (channel) {
      const fields = childrenOf(channel);
      const prefix = prefixOf(tagName(channel));
      return {
        title: firstText(fields, ["title"], prefix),
        link: extractLink(fields, prefix),
        items: findAll(fields, "item", prefix).map(toEntry),
      };
    }
  }

  const feed = find(roots, "feed");
  if (feed) {
    const fields = childrenOf(feed);
    const prefix = prefixOf(tagName(feed));
    return {
      title: firstText(fields, ["title"], prefix),
      link: extractLink(fields, prefix),
      items: findAll(fields, "entry", prefix).map(toEntry),
    };
  }

  return { items: [] };
}
