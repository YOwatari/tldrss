import { describe, expect, it } from "vitest";
import { buildDigestPrompt, buildRssXml } from "../../src/digest/rss";

describe("buildRssXml", () => {
  it("builds valid rss with one digest item", () => {
    const xml = buildRssXml({
      requestUrl: "https://worker.example/?url=https://source.example/rss.xml",
      feedUrl: "https://source.example/rss.xml",
      feedTitle: "Example Feed",
      summary: "Line 1\nLine 2",
      now: new Date("2026-09-10T12:00:00Z"),
    });

    expect(xml).toContain("<rss version=\"2.0\">");
    expect(xml.match(/<item>/g)?.length).toBe(1);
    expect(xml).toContain("Line 1&#10;Line 2");
    expect(xml).toContain("Daily Digest: Example Feed");
  });
});

describe("buildDigestPrompt", () => {
  it("lists every entry with title, url and excerpt", () => {
    const prompt = buildDigestPrompt("Example Feed", [
      { title: "Entry 1", link: "https://example.com/1", contentSnippet: "Snippet 1" },
      { link: "https://example.com/2", content: "Body 2" },
    ]);

    expect(prompt).toContain("Example Feed");
    expect(prompt).toContain("1. Entry 1\nURL: https://example.com/1\nExcerpt: Snippet 1");
    expect(prompt).toContain("2. (untitled)\nURL: https://example.com/2\nExcerpt: Body 2");
  });
});
