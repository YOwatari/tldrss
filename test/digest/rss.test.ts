import { describe, expect, it } from "vitest";
import { buildEmptyChannelXml, buildRssXml } from "../../src/digest/rss";

describe("buildRssXml", () => {
  it("builds valid rss with one digest item", () => {
    const xml = buildRssXml({
      requestUrl: "https://worker.example/?url=https://source.example/rss.xml",
      feedUrl: "https://source.example/rss.xml",
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
      requestUrl: "https://worker.example/",
      feedUrl: "https://source.example/rss.xml",
      feedTitle: "Example Feed",
      summaryHtml: "body",
      now: new Date("2026-09-10T12:00:00Z"),
    };

    const guidOf = (xml: string) => /<guid[^>]*>([^<]*)<\/guid>/.exec(xml)?.[1];

    expect(guidOf(buildRssXml({ ...params, language: "en" }))).not.toBe(
      guidOf(buildRssXml({ ...params, language: "ja" })),
    );
  });

  it("escapes the html body so the reader receives markup, not tags", () => {
    const xml = buildRssXml({
      requestUrl: "https://worker.example/",
      feedUrl: "https://source.example/rss.xml",
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
    requestUrl: "https://worker.example/feed?url=https://source.example/rss.xml",
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
