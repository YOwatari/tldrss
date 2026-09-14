import { describe, expect, it } from "vitest";
import { digestTtlSeconds, editionOf, nextPublicationAt, periodDate, periodWindow, previousPeriodDate, publishedPeriodDate } from "../../src/digest/period";
import { selectRecentEntries } from "../../src/feed/select";
import { buildDigestPrompt, systemPromptFor } from "../../src/llm/prompt";

describe("weekly editions", () => {
  it.each([
    ["2026-09-13T14:59:59Z", "2026-09-07"],
    ["2026-09-13T15:00:00Z", "2026-09-14"],
    ["2027-01-01T00:00:00Z", "2026-12-28"],
  ])("anchors %s to Monday in JST", (instant, expected) => {
    expect(periodDate(new Date(instant), "weekly")).toBe(expected);
  });

  it("keeps the previous edition across month/year boundaries for two weeks", () => {
    expect(previousPeriodDate("2027-01-04", "weekly")).toBe("2026-12-28");
    expect(digestTtlSeconds("weekly")).toBe(14 * 86400);
    expect(digestTtlSeconds()).toBe(2 * 86400);
  });

  it("selects a completed week without including next week's boundary", () => {
    const entries = ["2026-09-06T23:59:59+09:00", "2026-09-07T00:00:00+09:00", "2026-09-13T23:59:59+09:00", "2026-09-14T00:00:00+09:00"]
      .map(isoDate => ({ isoDate }));
    expect(selectRecentEntries(entries, {
      now: new Date("2026-09-14T00:00:00+09:00"), windowMs: 7 * 86400000, exclusiveEnd: true,
    }).entries).toEqual([entries[2], entries[1]]);
  });

  it.each(["en", "ja"] as const)("uses weekly prompt wording in %s without altering feed titles", language => {
    const prompt = buildDigestPrompt({ feedTitle: "daily 日次 $&", entries: [], availableCount: 0, language, period: "weekly" });
    expect(prompt).toContain("daily 日次 $&");
    expect(prompt).toContain(language === "ja" ? "週次ダイジェスト" : "weekly digest");
    expect(systemPromptFor(language, "weekly")).toContain(language === "ja" ? "週次" : "weekly");
  });
});

describe("daily fixed editions", () => {
  const edition = editionOf("2026-09-14");

  it("derives the 08:50 window and 09:00 publication from the edition date", () => {
    expect(edition).toEqual({
      date: "2026-09-14",
      period: "daily",
      windowStart: "2026-09-12T23:50:00.000Z",
      windowEnd: "2026-09-13T23:50:00.000Z",
      publishAt: "2026-09-14T00:00:00.000Z",
    });
  });

  it("switches the public edition exactly at 09:00 JST", () => {
    expect(publishedPeriodDate(new Date("2026-09-13T23:59:59Z"))).toBe("2026-09-13");
    expect(publishedPeriodDate(new Date("2026-09-14T00:00:00Z"))).toBe("2026-09-14");
  });

  it("keeps the weekly publication boundary across the year", () => {
    expect(publishedPeriodDate(new Date("2027-01-03T23:59:59Z"), "weekly")).toBe("2026-12-28");
    expect(publishedPeriodDate(new Date("2027-01-04T00:00:00Z"), "weekly")).toBe("2027-01-04");
    expect(periodWindow("2027-01-04", "weekly")).toMatchObject({
      start: new Date("2026-12-27T15:00:00Z"),
      end: new Date("2027-01-03T15:00:00Z"),
    });
  });

  it("includes the start and excludes the end of the fixed window", () => {
    const window = periodWindow("2026-09-14");
    const entries = [
      { isoDate: window.start.toISOString() },
      { isoDate: new Date(window.end.getTime() - 1).toISOString() },
      { isoDate: window.end.toISOString() },
    ];
    expect(selectRecentEntries(entries, { start: window.start, end: window.end }).entries).toEqual(entries.slice(0, 2).reverse());
  });

  it("finds the next publication boundary for response cache expiry", () => {
    expect(nextPublicationAt(new Date("2026-09-13T23:59:59Z")).toISOString()).toBe("2026-09-14T00:00:00.000Z");
    expect(nextPublicationAt(new Date("2026-09-14T00:00:00Z")).toISOString()).toBe("2026-09-15T00:00:00.000Z");
  });
});
