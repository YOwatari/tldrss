import { describe, expect, it } from "vitest";
import { MAX_ENTRIES_CEILING, maxEntriesOf } from "../src/env";
import { DEFAULT_MAX_ENTRIES } from "../src/feed/select";

function envWith(maxEntries: unknown) {
  return { MAX_ENTRIES: maxEntries } as never;
}

describe("maxEntriesOf", () => {
  it("falls back to the default when MAX_ENTRIES is unset", () => {
    expect(maxEntriesOf({} as never)).toBe(DEFAULT_MAX_ENTRIES);
  });

  it("reads the configured cap", () => {
    expect(maxEntriesOf(envWith("12"))).toBe(12);
  });

  it("accepts a cap wrangler passed through as a number", () => {
    expect(maxEntriesOf(envWith(12))).toBe(12);
  });

  it.each(["0", "-1", "1.5", "abc", "", " "])(
    "falls back to the default for the unusable value %o",
    (value) => {
      expect(maxEntriesOf(envWith(value))).toBe(DEFAULT_MAX_ENTRIES);
    },
  );

  it("clamps a cap above the ceiling", () => {
    expect(maxEntriesOf(envWith(`${MAX_ENTRIES_CEILING + 50}`))).toBe(MAX_ENTRIES_CEILING);
  });
});
