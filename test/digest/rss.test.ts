import { describe, expect, it } from "vitest";
import { buildEmptyChannelXml, buildRssXml } from "../../src/digest/rss";

describe("buildRssXml", () => {
  it("builds valid rss with one digest item", () => {
    const xml = buildRssXml({
      publicUrl: "https://worker.example/?url=https://source.example/rss.xml",
      feedHash: "a".repeat(64),
      digestDate: "2026-09-10",
      feedTitle: "Example Feed",
      summaryHtml: "Line 1<br />Line 2",
      language: "en",
      now: new Date("2026-09-10T12:00:00Z"),
    });

    expect(xml).toContain("<rss version=\"2.0\">");
    expect(xml.match(/<item>/g)?.length).toBe(1);
    expect(xml).toContain("Daily Digest: Example Feed");
  });

  it("gives each language its own guid so readers do not merge the items", () => {
    const params = {
      publicUrl: "https://worker.example/",
      feedHash: "a".repeat(64),
      digestDate: "2026-09-10",
      feedTitle: "Example Feed",
      summaryHtml: "body",
      now: new Date("2026-09-10T12:00:00Z"),
    };

    const guidOf = (xml: string) => /<guid[^>]*>([^<]*)<\/guid>/.exec(xml)?.[1];

    expect(guidOf(buildRssXml({ ...params, language: "en" }))).not.toBe(
      guidOf(buildRssXml({ ...params, language: "ja" })),
    );
  });

  it("identifies the item by the feed hash, not by the url it came from", () => {
    const xml = buildRssXml({
      publicUrl: "https://worker.example/feed",
      feedHash: "a".repeat(64),
      digestDate: "2026-09-10",
      feedTitle: "Example Feed",
      summaryHtml: "body",
      language: "en",
      now: new Date("2026-09-10T12:00:00Z"),
    });

    expect(xml).toContain(`<guid isPermaLink="false">${"a".repeat(64)}-2026-09-10-en</guid>`);
  });

  it("escapes the html body so the reader receives markup, not tags", () => {
    const xml = buildRssXml({
      publicUrl: "https://worker.example/",
      feedHash: "a".repeat(64),
      digestDate: "2026-09-10",
      feedTitle: "Example Feed",
      summaryHtml: '* Something <a href="https://source.example/1">[1]</a>',
      language: "en",
      now: new Date("2026-09-10T12:00:00Z"),
    });

    // The body must not open a real element inside <description>.
    expect(xml).toContain(
      "&lt;a href=&quot;https://source.example/1&quot;&gt;[1]&lt;/a&gt;",
    );
    expect(xml).not.toContain("<description>* Something <a ");
  });
});

describe("buildEmptyChannelXml", () => {
  const params = {
    publicUrl: "https://worker.example/feed?url=https://source.example/rss.xml",
    feedTitle: "Example Feed",
  };

  it("builds a valid rss 2.0 channel with no item", () => {
    const xml = buildEmptyChannelXml(params);

    expect(xml).toContain('<rss version="2.0">');
    expect(xml).toContain("<channel>");
    expect(xml).not.toContain("<item>");
  });

  it("names the channel after the feed it stands in for", () => {
    expect(buildEmptyChannelXml(params)).toContain("Daily Digest: Example Feed");
  });

  it("escapes the feed title", () => {
    const xml = buildEmptyChannelXml({ ...params, feedTitle: "A & B <b>" });

    expect(xml).toContain("A &amp; B &lt;b&gt;");
    expect(xml).not.toContain("<b>");
  });
});
