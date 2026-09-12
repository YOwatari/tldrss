import { describe, expect, it } from "vitest";
import { digestTtlSeconds, periodDate, previousPeriodDate } from "../../src/digest/period";
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
