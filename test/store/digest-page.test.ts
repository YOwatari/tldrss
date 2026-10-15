import { env as providedEnv, reset } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import {
  digestPageKey,
  getDigestPage,
  putDigestPage,
} from "../../src/store/digest-page";

const kv = (providedEnv as unknown as { DIGEST_CACHE: KVNamespace }).DIGEST_CACHE;

const REF = { hash: "a".repeat(64), date: "2026-09-10", language: "en" } as const;

const PAGE = {
  feedTitle: "Example Feed",
  lead: "Something shipped.",
  entries: [{ title: "Entry 1", link: "https://source.example/1" }],
  availableCount: 1,
};

afterEach(async () => {
  await reset();
});

describe("digestPageKey", () => {
  it("is built from the hash, the JST date and the language", () => {
    expect(digestPageKey(REF)).toBe(`digest-html:${"a".repeat(64)}:2026-09-10:en:v2`);
  });

  it("separates the languages of one feed and day", () => {
    expect(digestPageKey(REF)).not.toBe(digestPageKey({ ...REF, language: "ja" }));
  });

  it("does not collide with the xml stored for the same digest", () => {
    expect(digestPageKey(REF)).not.toBe(`digest:${REF.hash}:${REF.date}:${REF.language}`);
  });
});

describe("getDigestPage", () => {
  it("returns null when nothing was stored", async () => {
    await expect(getDigestPage(kv, REF)).resolves.toBeNull();
  });

  it("returns what putDigestPage stored", async () => {
    await putDigestPage(kv, REF, PAGE);

    await expect(getDigestPage(kv, REF)).resolves.toEqual(PAGE);
  });

  it("does not serve another day's page", async () => {
    await putDigestPage(kv, REF, PAGE);

    await expect(
      getDigestPage(kv, { ...REF, date: "2026-09-11" }),
    ).resolves.toBeNull();
  });

  it("stores only the title and link of each entry", async () => {
    await putDigestPage(kv, REF, {
      ...PAGE,
      entries: [{ title: "Entry 1", link: "https://source.example/1", content: "body", isoDate: "x" } as never],
    });

    await expect(getDigestPage(kv, REF)).resolves.toEqual(PAGE);
  });

  it("returns a record of the legacy shape as it was stored", async () => {
    const legacy = { feedTitle: "Example Feed", html: "<ul><li>Old</li></ul>" };
    await kv.put(digestPageKey(REF), JSON.stringify(legacy));

    await expect(getDigestPage(kv, REF)).resolves.toEqual(legacy);
  });

  it("treats a stored value it cannot read as absent", async () => {
    await kv.put(digestPageKey(REF), "not json");

    await expect(getDigestPage(kv, REF)).resolves.toBeNull();
  });

  it("treats a record of another shape as absent", async () => {
    for (const stored of [
      '"just a string"',
      "null",
      '{"html":"<p>a</p>"}',
      "{}",
      '{"feedTitle":"F","lead":"L","entries":[1],"availableCount":1}',
      '{"feedTitle":"F","lead":"L","entries":[]}',
    ]) {
      await kv.put(digestPageKey(REF), stored);

      await expect(getDigestPage(kv, REF)).resolves.toBeNull();
    }
  });
});
