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

type XmlNode = Record<string, unknown>;

const ATTRIBUTE_PREFIX = "@_";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: ATTRIBUTE_PREFIX,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
});

function isXmlNode(value: unknown): value is XmlNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Reads the text content of a node, whether it is a bare string or an element with attributes. */
function text(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = text(item);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (isXmlNode(value)) return text(value["#text"]);
  return undefined;
}

function firstText(node: XmlNode, keys: string[]): string | undefined {
  for (const key of keys) {
    const found = text(node[key]);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * RSS keeps the URL in the element text; Atom keeps it in a `href` attribute and
 * may repeat `<link>` for other relations (`self`, `edit`, enclosures).
 */
function extractLink(value: unknown): string | undefined {
  const candidates = toArray(value);
  const hrefs = candidates.filter(isXmlNode).map((node) => ({
    rel: text(node[`${ATTRIBUTE_PREFIX}rel`]),
    href: text(node[`${ATTRIBUTE_PREFIX}href`]),
  }));

  const alternate = hrefs.find((link) => link.href && (link.rel === undefined || link.rel === "alternate"));
  if (alternate?.href) return alternate.href;

  return text(candidates.find((candidate) => text(candidate) !== undefined));
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

function toEntry(node: XmlNode): FeedEntry {
  const pubDate = firstText(node, ["pubDate", "published", "updated", "dc:date", "date"]);
  const summary = firstText(node, ["description", "summary"]);
  const content = firstText(node, ["content:encoded", "content"]);

  return {
    title: firstText(node, ["title"]),
    link: extractLink(node["link"]) ?? firstText(node, ["guid", "id"]),
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
  if (!isXmlNode(document)) return { items: [] };

  const rss = document["rss"];
  if (isXmlNode(rss)) {
    const channel = rss["channel"];
    if (isXmlNode(channel)) {
      return {
        title: firstText(channel, ["title"]),
        link: extractLink(channel["link"]),
        items: toArray(channel["item"]).filter(isXmlNode).map(toEntry),
      };
    }
  }

  const feed = document["feed"];
  if (isXmlNode(feed)) {
    return {
      title: firstText(feed, ["title"]),
      link: extractLink(feed["link"]),
      items: toArray(feed["entry"]).filter(isXmlNode).map(toEntry),
    };
  }

  return { items: [] };
}
