import { describe, expect, it } from "vitest";
import { parseFeed } from "../../src/feed/parse";

const RSS_2_0 = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Example Blog</title>
    <link>https://example.com/</link>
    <description>Example description</description>
    <item>
      <title>First &amp; foremost</title>
      <link>https://example.com/1</link>
      <pubDate>Wed, 09 Sep 2026 10:00:00 GMT</pubDate>
      <description><![CDATA[<p>Hello <b>world</b></p>]]></description>
      <content:encoded><![CDATA[<p>Full body</p>]]></content:encoded>
    </item>
    <item>
      <title>Second</title>
      <link>https://example.com/2</link>
      <pubDate>Thu, 10 Sep 2026 01:30:00 GMT</pubDate>
      <description>Plain text</description>
    </item>
  </channel>
</rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Example</title>
  <link rel="self" href="https://example.org/feed.atom"/>
  <link rel="alternate" href="https://example.org/"/>
  <entry>
    <title>Atom entry</title>
    <link rel="alternate" type="text/html" href="https://example.org/entry-1"/>
    <link rel="edit" href="https://example.org/entry-1/edit"/>
    <updated>2026-09-10T02:00:00Z</updated>
    <summary type="html">&lt;p&gt;Summary text&lt;/p&gt;</summary>
    <content type="html">&lt;p&gt;Content text&lt;/p&gt;</content>
  </entry>
</feed>`;

const SINGLE_ITEM_RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>One</title><item><title>Only</title><link>https://example.com/only</link><pubDate>Wed, 09 Sep 2026 10:00:00 GMT</pubDate></item></channel></rss>`;

describe("parseFeed (RSS 2.0)", () => {
  it("reads channel metadata and every item", () => {
    const feed = parseFeed(RSS_2_0);

    expect(feed.title).toBe("Example Blog");
    expect(feed.link).toBe("https://example.com/");
    expect(feed.items).toHaveLength(2);
  });

  it("maps item fields onto the FeedEntry contract", () => {
    const [first] = parseFeed(RSS_2_0).items;

    expect(first.title).toBe("First & foremost");
    expect(first.link).toBe("https://example.com/1");
    expect(first.pubDate).toBe("Wed, 09 Sep 2026 10:00:00 GMT");
    expect(first.isoDate).toBe("2026-09-09T10:00:00.000Z");
    expect(first.contentSnippet).toBe("Hello world");
    expect(first.content).toBe("<p>Full body</p>");
  });

  it("treats a single item as a one-element list", () => {
    const feed = parseFeed(SINGLE_ITEM_RSS);

    expect(feed.items.map((item) => item.title)).toEqual(["Only"]);
  });
});

describe("parseFeed (Atom)", () => {
  it("reads feed metadata from the alternate link", () => {
    const feed = parseFeed(ATOM);

    expect(feed.title).toBe("Atom Example");
    expect(feed.link).toBe("https://example.org/");
  });

  it("maps entry fields onto the FeedEntry contract", () => {
    const [entry] = parseFeed(ATOM).items;

    expect(entry.title).toBe("Atom entry");
    expect(entry.link).toBe("https://example.org/entry-1");
    expect(entry.pubDate).toBe("2026-09-10T02:00:00Z");
    expect(entry.isoDate).toBe("2026-09-10T02:00:00.000Z");
    expect(entry.contentSnippet).toBe("Summary text");
    expect(entry.content).toBe("<p>Content text</p>");
  });
});

describe("parseFeed (malformed input)", () => {
  it("returns an empty feed when the document is not a feed", () => {
    const feed = parseFeed("<html><body>not a feed</body></html>");

    expect(feed.items).toEqual([]);
    expect(feed.title).toBeUndefined();
  });

  it("throws on unparsable xml", () => {
    expect(() => parseFeed("<rss><channel>")).toThrow();
  });
});
