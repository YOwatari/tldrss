import { describe, expect, it } from "vitest";
import { buildRssXml, filterEntriesFromLast24Hours } from "../src/rss";

describe("filterEntriesFromLast24Hours", () => {
  it("keeps only entries inside the 24-hour window", () => {
    const now = new Date("2026-09-10T12:00:00Z");
    const entries = [
      { title: "fresh", isoDate: "2026-09-10T10:00:00Z" },
      { title: "old", isoDate: "2026-09-09T11:59:59Z" },
      { title: "missing" },
    ];

    const filtered = filterEntriesFromLast24Hours(entries, now);
    expect(filtered.map((entry) => entry.title)).toEqual(["fresh"]);
  });
});

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
