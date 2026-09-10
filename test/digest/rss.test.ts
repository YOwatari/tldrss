import { describe, expect, it } from "vitest";
import { buildRssXml } from "../../src/digest/rss";

describe("buildRssXml", () => {
  it("builds valid rss with one digest item", () => {
    const xml = buildRssXml({
      requestUrl: "https://worker.example/?url=https://source.example/rss.xml",
      feedUrl: "https://source.example/rss.xml",
      feedTitle: "Example Feed",
      summaryHtml: "Line 1<br />Line 2",
      now: new Date("2026-09-10T12:00:00Z"),
    });

    expect(xml).toContain("<rss version=\"2.0\">");
    expect(xml.match(/<item>/g)?.length).toBe(1);
    expect(xml).toContain("Daily Digest: Example Feed");
  });

  it("escapes the html body so the reader receives markup, not tags", () => {
    const xml = buildRssXml({
      requestUrl: "https://worker.example/",
      feedUrl: "https://source.example/rss.xml",
      feedTitle: "Example Feed",
      summaryHtml: '* Something <a href="https://source.example/1">[1]</a>',
      now: new Date("2026-09-10T12:00:00Z"),
    });

    // The body must not open a real element inside <description>.
    expect(xml).toContain(
      "&lt;a href=&quot;https://source.example/1&quot;&gt;[1]&lt;/a&gt;",
    );
    expect(xml).not.toContain("<description>* Something <a ");
  });
});
