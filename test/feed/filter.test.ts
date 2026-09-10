import { describe, expect, it } from "vitest";
import { filterEntriesFromLast24Hours } from "../../src/feed/filter";

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

  it("falls back to pubDate when isoDate is absent", () => {
    const now = new Date("2026-09-10T12:00:00Z");
    const entries = [{ title: "fresh", pubDate: "Thu, 10 Sep 2026 09:00:00 GMT" }];

    expect(filterEntriesFromLast24Hours(entries, now)).toHaveLength(1);
  });
});
