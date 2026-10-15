import { XMLParser } from "fast-xml-parser";
import { describe, expect, it } from "vitest";
import { buildDigestXml, buildEmptyChannelXml } from "../../src/digest/build";
import type { Digest } from "../../src/digest/types";

const FEED_HASH = "a".repeat(64);

const LINKS = {
  siteUrl: "https://worker.example/",
  pageUrl: `https://worker.example/digest/${FEED_HASH}/2026-09-10?lang=en`,
};

const NOW = new Date("2026-09-10T00:00:00Z");

function digestOf(overrides: Partial<Digest> = {}): Digest {
  return {
    hash: FEED_HASH,
    date: "2026-09-10",
    language: "en",
    windowStart: "2026-09-09T23:50:00.000Z",
    windowEnd: "2026-09-10T23:50:00.000Z",
    publishAt: "2026-09-11T00:00:00.000Z",
    feedTitle: "Example Feed",
    lead: "Something shipped.",
    entries: [{ title: "Entry 1", link: "https://source.example/1" }],
    availableCount: 1,
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

  it("describes the item with the lead and the titles, as html in CDATA", () => {
    const xml = buildDigestXml({ digest: digestOf(), links: LINKS, now: NOW });

    expect(xml).toContain("<description><![CDATA[<p>Something shipped.</p><ul><li>Entry 1</li></ul>]]></description>");
  });

  it("escapes ]]> in the lead so it cannot close the CDATA section", () => {
    const xml = buildDigestXml({ digest: digestOf({ lead: "a ]]> b" }), links: LINKS, now: NOW });

    expect(xml).not.toContain("]]]]><![CDATA[>");
    expect(parse(xml).channel.item.description).toBe("<p>a ]]&gt; b</p><ul><li>Entry 1</li></ul>");
  });

  it("carries no link to the articles, so Slack has nothing to unfurl", () => {
    const description = parse(buildDigestXml({ digest: digestOf(), links: LINKS, now: NOW })).channel.item.description;

    expect(description).not.toMatch(/<a\b/);
    expect(description).not.toMatch(/https?:\/\//);
  });

  it("keeps the description within the configured length", () => {
    const entries = Array.from({ length: 30 }, (_, i) => ({ title: `Entry ${i + 1} title`, link: `https://source.example/${i}` }));
    const description = parse(
      buildDigestXml({ digest: digestOf({ entries, availableCount: 45 }), links: LINKS, now: NOW, descriptionMaxChars: 200 }),
    ).channel.item.description;

    expect(description.length).toBeLessThanOrEqual(200);
    expect(description).toMatch(/…and \d+ more/);
  });

  it("says when the channel was last built", () => {
    const rss = parse(buildDigestXml({ digest: digestOf(), links: LINKS, now: NOW }));

    expect(rss.channel.lastBuildDate).toBe(NOW.toUTCString());
  });

  it("points the channel at the worker rather than at the feed it summarizes", () => {
    const rss = parse(buildDigestXml({ digest: digestOf(), links: LINKS, now: NOW }));

    expect(rss.channel.link).toBe(LINKS.siteUrl);
  });

  it("claims no self address, which cannot be given without the feed url", () => {
    const xml = buildDigestXml({ digest: digestOf(), links: LINKS, now: NOW });

    // A self link would have to be the /feed url the reader subscribed to,
    // query string and any token in it included. See the note in `build.ts`.
    expect(xml).not.toContain('rel="self"');
    expect(xml).not.toContain("xmlns:atom");
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
