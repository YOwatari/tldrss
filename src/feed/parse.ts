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
  trimValues: true,
});

function tagName(node: OrderedNode): string {
  return Object.keys(node).find((key) => key !== ATTRIBUTES_KEY) ?? "";
}

/** `fast-xml-parser` keeps namespace prefixes, so `<atom:entry>` must match "entry" too. */
function localName(name: string): string {
  const separator = name.indexOf(":");
  return separator === -1 ? name : name.slice(separator + 1);
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
 * Matches on the full tag name first so prefixed RSS extensions such as
 * `content:encoded` keep working, then falls back to the local name.
 */
function matches(node: OrderedNode, name: string): boolean {
  const tag = tagName(node);
  return tag === name || localName(tag) === name;
}

function findAll(nodes: OrderedNode[], name: string): OrderedNode[] {
  return nodes.filter((node) => matches(node, name));
}

function find(nodes: OrderedNode[], name: string): OrderedNode | undefined {
  return nodes.find((node) => matches(node, name));
}

/** Concatenates the text of a child list, descending into nested markup. */
function textOf(nodes: OrderedNode[]): string {
  const parts: string[] = [];

  for (const node of nodes) {
    const tag = tagName(node);
    if (tag === TEXT_KEY) {
      const value = node[TEXT_KEY];
      if (typeof value === "string" && value.length > 0) parts.push(value);
      continue;
    }
    const nested = textOf(childrenOf(node));
    if (nested.length > 0) parts.push(nested);
  }

  return parts.join(" ").trim();
}

function firstText(nodes: OrderedNode[], names: string[]): string | undefined {
  for (const name of names) {
    const node = find(nodes, name);
    if (!node) continue;
    const value = textOf(childrenOf(node));
    if (value.length > 0) return value;
  }
  return undefined;
}

/**
 * RSS keeps the URL in the element text; Atom keeps it in a `href` attribute and
 * may repeat `<link>` for other relations (`self`, `edit`, enclosures).
 */
function extractLink(nodes: OrderedNode[]): string | undefined {
  const links = findAll(nodes, "link");

  for (const link of links) {
    const { href, rel } = attributesOf(link);
    if (href && (rel === undefined || rel === "alternate")) return href;
  }

  for (const link of links) {
    const value = textOf(childrenOf(link));
    if (value.length > 0) return value;
  }

  return undefined;
}

function stripHtml(html: string): string {
  return html
    .replaceAll(/<[^>]*>/g, " ")
    .replaceAll(/&nbsp;/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
}

function toIsoDate(dateText: string | undefined): string | undefined {
  if (!dateText) return undefined;
  const timestamp = Date.parse(dateText);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function toEntry(entry: OrderedNode): FeedEntry {
  const fields = childrenOf(entry);
  const pubDate = firstText(fields, ["pubDate", "published", "updated", "dc:date", "date"]);
  const summary = firstText(fields, ["description", "summary"]);
  const content = firstText(fields, ["content:encoded", "content"]);

  return {
    title: firstText(fields, ["title"]),
    link: extractLink(fields) ?? firstText(fields, ["guid", "id"]),
    contentSnippet: summary === undefined ? undefined : stripHtml(summary),
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
    const channel = find(childrenOf(rss), "channel");
    if (channel) {
      const fields = childrenOf(channel);
      return {
        title: firstText(fields, ["title"]),
        link: extractLink(fields),
        items: findAll(fields, "item").map(toEntry),
      };
    }
  }

  const feed = find(roots, "feed");
  if (feed) {
    const fields = childrenOf(feed);
    return {
      title: firstText(fields, ["title"]),
      link: extractLink(fields),
      items: findAll(fields, "entry").map(toEntry),
    };
  }

  return { items: [] };
}
