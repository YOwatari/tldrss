import { XMLParser } from "fast-xml-parser";
import { describe, expect, it } from "vitest";
import { buildDigestXml, buildEmptyChannelXml } from "../../src/digest/build";
import type { Digest } from "../../src/digest/types";

const FEED_HASH = "a".repeat(64);

const LINKS = {
  feedUrl: "https://worker.example/feed",
  pageUrl: `https://worker.example/digest/${FEED_HASH}/2026-09-10?lang=en`,
};

const NOW = new Date("2026-09-10T00:00:00Z");

function digestOf(overrides: Partial<Digest> = {}): Digest {
  return {
    hash: FEED_HASH,
    date: "2026-09-10",
    language: "en",
    feedTitle: "Example Feed",
    html: "<p>Something shipped.</p>",
    entries: [{ title: "Entry 1", link: "https://source.example/1" }],
    ...overrides,
  };
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@" });

function parse(xml: string) {
  return parser.parse(xml).rss;
}

describe("buildDigestXml", () => {
  it("parses back as an rss 2.0 feed with exactly one item", () => {
    const rss = parse(buildDigestXml({ digest: digestOf(), links: LINKS, now: NOW }));

    expect(rss["@version"]).toBe("2.0");
    expect(rss.channel.title).toBe("Daily Digest: Example Feed");
    expect(Array.isArray(rss.channel.item)).toBe(false);
    expect(rss.channel.item).toBeDefined();
  });

  it("titles the item after the feed and the day it covers", () => {
    const xml = buildDigestXml({ digest: digestOf(), links: LINKS, now: NOW });

    expect(parse(xml).channel.item.title).toBe("Daily Digest: Example Feed (2026-09-10)");
  });

  it("titles a Japanese digest in Japanese", () => {
    const xml = buildDigestXml({
      digest: digestOf({ language: "ja" }),
      links: LINKS,
      now: NOW,
    });

    expect(parse(xml).channel.item.title).toBe("【日刊要約】Example Feed (2026-09-10)");
  });

  it("identifies the item by the feed hash and the day, never by the feed url", () => {
    const rss = parse(buildDigestXml({ digest: digestOf(), links: LINKS, now: NOW }));

    expect(rss.channel.item.guid["#text"]).toBe(`${FEED_HASH}-2026-09-10-en`);
    expect(rss.channel.item.guid["@isPermaLink"]).toBe("false");
  });

  it("gives each language its own guid so readers do not merge the items", () => {
    const guidOf = (language: "en" | "ja") =>
      parse(buildDigestXml({ digest: digestOf({ language }), links: LINKS, now: NOW }))
        .channel.item.guid["#text"];

    expect(guidOf("en")).not.toBe(guidOf("ja"));
  });

  it("dates the item at 09:00 JST of the day it covers, not at generation time", () => {
    const xml = buildDigestXml({ digest: digestOf(), links: LINKS, now: NOW });

    expect(parse(xml).channel.item.pubDate).toBe("Thu, 10 Sep 2026 09:00:00 +0900");
  });

  it("points the item at the page that carries the full digest", () => {
    const xml = buildDigestXml({ digest: digestOf(), links: LINKS, now: NOW });

    expect(parse(xml).channel.item.link).toBe(LINKS.pageUrl);
  });

  it("carries the body as CDATA, so the reader receives html rather than text", () => {
    const xml = buildDigestXml({ digest: digestOf(), links: LINKS, now: NOW });

    expect(xml).toContain("<![CDATA[<p>Something shipped.</p>]]>");
    expect(xml).not.toContain("&lt;p&gt;");
  });

  it("keeps a body containing ]]> from closing the section early", () => {
    const html = "<p>Compare a[i] with b]]> and c</p>";
    const xml = buildDigestXml({ digest: digestOf({ html }), links: LINKS, now: NOW });

    // Split across two sections, so no section ends before the body does.
    expect(xml).toContain("]]]]><![CDATA[>");
    expect(parse(xml).channel.item.description).toBe(html);
  });

  it("declares the channel's own address and when it was last built", () => {
    const rss = parse(buildDigestXml({ digest: digestOf(), links: LINKS, now: NOW }));

    expect(rss.channel["atom:link"]["@rel"]).toBe("self");
    expect(rss.channel["atom:link"]["@href"]).toBe(LINKS.feedUrl);
    expect(rss.channel.lastBuildDate).toBe(NOW.toUTCString());
  });

  it("escapes a feed title that carries markup", () => {
    const xml = buildDigestXml({
      digest: digestOf({ feedTitle: "A & B <b>" }),
      links: LINKS,
      now: NOW,
    });

    expect(xml).toContain("A &amp; B &lt;b&gt;");
    expect(parse(xml).channel.title).toBe("Daily Digest: A & B <b>");
  });
});

describe("buildEmptyChannelXml", () => {
  const params = { feedTitle: "Example Feed", language: "en", links: LINKS, now: NOW } as const;

  it("builds a valid rss 2.0 channel with no item", () => {
    const rss = parse(buildEmptyChannelXml(params));

    expect(rss["@version"]).toBe("2.0");
    expect(rss.channel.title).toBe("Daily Digest: Example Feed");
    expect(rss.channel.item).toBeUndefined();
  });

  it("names the channel in the language the reader asked for", () => {
    const rss = parse(buildEmptyChannelXml({ ...params, language: "ja" }));

    expect(rss.channel.title).toBe("【日刊要約】Example Feed");
  });

  it("escapes the feed title", () => {
    const xml = buildEmptyChannelXml({ ...params, feedTitle: "A & B <b>" });

    expect(xml).toContain("A &amp; B &lt;b&gt;");
    expect(xml).not.toContain("<b>");
  });
});
