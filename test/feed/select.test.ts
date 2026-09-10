import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_ENTRIES, selectRecentEntries } from "../../src/feed/select";

const now = new Date("2026-09-10T12:00:00Z");

function entryAt(title: string, isoDate: string) {
  return { title, link: `https://example.com/${title}`, isoDate };
}

describe("selectRecentEntries", () => {
  it("keeps only entries inside the 24-hour window", () => {
    const selection = selectRecentEntries(
      [
        entryAt("fresh", "2026-09-10T10:00:00Z"),
        entryAt("edge", "2026-09-09T12:00:00Z"),
        entryAt("old", "2026-09-09T11:59:59Z"),
      ],
      { now },
    );

    expect(selection.entries.map((entry) => entry.title)).toEqual(["fresh", "edge"]);
  });

  it("drops entries the feed gave no usable date", () => {
    const selection = selectRecentEntries(
      [
        { title: "undated", link: "https://example.com/undated" },
        { title: "unparsable", isoDate: "not a date" },
        entryAt("fresh", "2026-09-10T10:00:00Z"),
      ],
      { now },
    );

    expect(selection.entries.map((entry) => entry.title)).toEqual(["fresh"]);
  });

  it("drops entries dated in the future", () => {
    const selection = selectRecentEntries([entryAt("ahead", "2026-09-10T12:00:01Z")], { now });

    expect(selection.entries).toEqual([]);
  });

  it("falls back to pubDate when isoDate is absent", () => {
    const selection = selectRecentEntries(
      [{ title: "fresh", pubDate: "Thu, 10 Sep 2026 09:00:00 GMT" }],
      { now },
    );

    expect(selection.entries).toHaveLength(1);
  });

  it("orders the entries newest first whatever order the feed used", () => {
    const selection = selectRecentEntries(
      [
        entryAt("oldest", "2026-09-10T01:00:00Z"),
        entryAt("newest", "2026-09-10T11:00:00Z"),
        entryAt("middle", "2026-09-10T06:00:00Z"),
      ],
      { now },
    );

    expect(selection.entries.map((entry) => entry.title)).toEqual([
      "newest",
      "middle",
      "oldest",
    ]);
  });

  it("keeps the newest entries when the feed published more than the cap", () => {
    const entries = Array.from({ length: 5 }, (_, index) =>
      entryAt(`entry-${index}`, new Date(Date.UTC(2026, 8, 10, index)).toISOString()),
    );

    const selection = selectRecentEntries(entries, { now, maxEntries: 2 });

    expect(selection.entries.map((entry) => entry.title)).toEqual(["entry-4", "entry-3"]);
  });

  it("reports how many entries the window held before the cap applied", () => {
    const entries = Array.from({ length: 5 }, (_, index) =>
      entryAt(`entry-${index}`, new Date(Date.UTC(2026, 8, 10, index)).toISOString()),
    );

    const selection = selectRecentEntries([...entries, { title: "undated" }], {
      now,
      maxEntries: 2,
    });

    expect(selection.availableCount).toBe(5);
  });

  it("caps at DEFAULT_MAX_ENTRIES when no cap is configured", () => {
    const entries = Array.from({ length: DEFAULT_MAX_ENTRIES + 3 }, (_, index) =>
      entryAt(`entry-${index}`, new Date(Date.UTC(2026, 8, 10, 0, index)).toISOString()),
    );

    const selection = selectRecentEntries(entries, { now });

    expect(selection.entries).toHaveLength(DEFAULT_MAX_ENTRIES);
    expect(selection.availableCount).toBe(entries.length);
  });

  it("leaves the caller's array untouched", () => {
    const entries = [
      entryAt("oldest", "2026-09-10T01:00:00Z"),
      entryAt("newest", "2026-09-10T11:00:00Z"),
    ];

    selectRecentEntries(entries, { now });

    expect(entries.map((entry) => entry.title)).toEqual(["oldest", "newest"]);
  });
});
