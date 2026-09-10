import { type Env, maxSubscriptionsOf } from "../src/env";
import { describe, expect, it } from "vitest";
import {
  MAX_ENTRIES_CEILING,
  maxEntriesOf,
  publicOriginOf,
  shouldPostNoUpdates,
} from "../src/env";
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

describe("shouldPostNoUpdates", () => {
  const envWithFlag = (value: unknown) => ({ POST_NO_UPDATES: value }) as never;

  it("stays silent on a quiet day by default", () => {
    expect(shouldPostNoUpdates({} as never)).toBe(false);
  });

  it("posts a digest saying so when the var is turned on", () => {
    expect(shouldPostNoUpdates(envWithFlag("true"))).toBe(true);
  });

  it("accepts the spellings wrangler and a boolean literal produce", () => {
    expect(shouldPostNoUpdates(envWithFlag("1"))).toBe(true);
    expect(shouldPostNoUpdates(envWithFlag(true))).toBe(true);
  });

  it("treats anything else as off, rather than as a syntax error", () => {
    for (const value of ["false", "0", "", "yes please", undefined]) {
      expect(shouldPostNoUpdates(envWithFlag(value))).toBe(false);
    }
  });
});

describe("publicOriginOf", () => {
  const envWith = (value?: string) => ({ PUBLIC_ORIGIN: value }) as never;

  it("is null when the var is unset, since there is no origin to link to", () => {
    expect(publicOriginOf({} as never)).toBeNull();
  });

  it("is the origin of the configured url", () => {
    expect(publicOriginOf(envWith("https://tldrss.example"))).toBe(
      "https://tldrss.example",
    );
  });

  it("drops a path, a trailing slash and a query the var carried", () => {
    expect(
      publicOriginOf(envWith("https://tldrss.example/feed?url=x")),
    ).toBe("https://tldrss.example");
  });

  it("keeps a non-default port, which is part of the address readers use", () => {
    expect(publicOriginOf(envWith("http://localhost:8787"))).toBe(
      "http://localhost:8787",
    );
  });

  it("is null for a value that is not an absolute http url", () => {
    expect(publicOriginOf(envWith("tldrss.example"))).toBeNull();
    expect(publicOriginOf(envWith(""))).toBeNull();
    expect(publicOriginOf(envWith("ftp://tldrss.example"))).toBeNull();
  });
});


it.each([undefined, "", "0", "-1", "1.5", "oops", "Infinity"])("defaults invalid subscription cap %s to twenty", value => {
  expect(maxSubscriptionsOf({ MAX_SUBSCRIPTIONS: value } as Env)).toBe(20);
});
it("accepts a positive subscription cap", () => {
  expect(maxSubscriptionsOf({ MAX_SUBSCRIPTIONS: "3" } as Env)).toBe(3);
});
