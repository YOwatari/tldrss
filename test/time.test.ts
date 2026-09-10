import { describe, expect, it } from "vitest";
import { digestPubDate, jstDate, previousDate } from "../src/time";

describe("jstDate", () => {
  it("uses the next day once UTC passes 15:00", () => {
    expect(jstDate(new Date("2026-09-10T15:00:00Z"))).toBe("2026-09-11");
  });

  it("still uses the same day just before 15:00 UTC", () => {
    expect(jstDate(new Date("2026-09-10T14:59:59Z"))).toBe("2026-09-10");
  });

  it("rolls over the month at the JST boundary", () => {
    expect(jstDate(new Date("2026-09-30T15:00:00Z"))).toBe("2026-10-01");
  });
});

describe("previousDate", () => {
  it("returns the day before", () => {
    expect(previousDate("2026-09-10")).toBe("2026-09-09");
  });

  it("crosses a month boundary", () => {
    expect(previousDate("2026-10-01")).toBe("2026-09-30");
  });

  it("crosses a year boundary", () => {
    expect(previousDate("2026-01-01")).toBe("2025-12-31");
  });
});

describe("digestPubDate", () => {
  it("dates the digest at 09:00 JST of the day it covers", () => {
    expect(digestPubDate("2026-09-10")).toBe("Thu, 10 Sep 2026 09:00:00 +0900");
  });

  it("pads a single-digit day of the month, as RFC 822 asks", () => {
    expect(digestPubDate("2026-01-01")).toBe("Thu, 01 Jan 2026 09:00:00 +0900");
  });

  it("names the weekday of the JST day, not of the UTC instant", () => {
    // 2026-09-10T09:00+09:00 is 2026-09-10T00:00Z, so both agree here; the
    // guard is against a date built from the UTC evening before.
    expect(digestPubDate("2026-09-13")).toBe("Sun, 13 Sep 2026 09:00:00 +0900");
  });

  it("rejects a date it cannot read rather than dating the digest wrongly", () => {
    expect(() => digestPubDate("not-a-date")).toThrow(/not-a-date/);
  });
});
