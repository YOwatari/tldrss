import { describe, expect, it } from "vitest";
import { jstDate, previousDate } from "../src/time";

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
