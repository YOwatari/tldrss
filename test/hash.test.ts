import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/hash";

describe("sha256Hex", () => {
  it("returns the known digest of a well-known input", async () => {
    // Reference vector: sha256("abc")
    await expect(sha256Hex("abc")).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("returns 64 lowercase hex characters", async () => {
    const hash = await sha256Hex("https://example.com/rss.xml");

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives different urls different hashes", async () => {
    const [first, second] = await Promise.all([
      sha256Hex("https://example.com/a.xml"),
      sha256Hex("https://example.com/b.xml"),
    ]);

    expect(first).not.toBe(second);
  });
});
