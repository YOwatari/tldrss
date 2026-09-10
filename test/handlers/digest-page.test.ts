import { env as providedEnv, reset } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { handleDigestPage } from "../../src/handlers/digest-page";
import { putDigestPage } from "../../src/store/digest-page";

const bindings = providedEnv as unknown as Env;

const HASH = "a".repeat(64);
const REF = { hash: HASH, date: "2026-09-10", language: "en" } as const;

const PAGE = {
  feedTitle: "Example Feed",
  html: '<ul>\n  <li><a href="https://source.example/1">Entry 1</a><br />It shipped.</li>\n</ul>',
};

function get(path: string): Promise<Response> {
  return handleDigestPage(new Request(`https://worker.example${path}`), bindings);
}

afterEach(async () => {
  await reset();
});

describe("handleDigestPage", () => {
  it("serves the stored digest body as an html page", async () => {
    await putDigestPage(bindings.DIGEST_CACHE, REF, PAGE);

    const response = await get(`/digest/${HASH}/2026-09-10`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(body).toContain("<!DOCTYPE html>");
    expect(body).toContain('<a href="https://source.example/1">Entry 1</a>');
    expect(body).toContain("Daily Digest: Example Feed (2026-09-10)");
  });

  it("serves the page of the language the reader asked for", async () => {
    await putDigestPage(bindings.DIGEST_CACHE, { ...REF, language: "ja" }, PAGE);

    const response = await get(`/digest/${HASH}/2026-09-10?lang=ja`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('<html lang="ja">');
    expect(body).toContain("【日刊要約】Example Feed (2026-09-10)");
  });

  it("does not serve the English page to a reader asking for Japanese", async () => {
    await putDigestPage(bindings.DIGEST_CACHE, REF, PAGE);

    expect((await get(`/digest/${HASH}/2026-09-10?lang=ja`)).status).toBe(404);
  });

  it("returns 404 when no digest was stored for that day", async () => {
    expect((await get(`/digest/${HASH}/2026-09-11`)).status).toBe(404);
  });

  it("returns 404 for a path that is not a digest address", async () => {
    for (const path of [
      "/digest",
      `/digest/${HASH}`,
      `/digest/${HASH}/2026-09-10/extra`,
      `/digest/${HASH}/10-09-2026`,
      "/digest/not-a-hash/2026-09-10",
    ]) {
      expect((await get(path)).status).toBe(404);
    }
  });

  it("returns 400 for a language it cannot serve", async () => {
    expect((await get(`/digest/${HASH}/2026-09-10?lang=fr`)).status).toBe(400);
  });

  it("escapes a feed title carrying markup", async () => {
    await putDigestPage(bindings.DIGEST_CACHE, REF, {
      ...PAGE,
      feedTitle: "A & B <script>",
    });

    const body = await (await get(`/digest/${HASH}/2026-09-10`)).text();

    expect(body).toContain("A &amp; B &lt;script&gt;");
    expect(body).not.toContain("<script>");
  });

  it("keeps the page from loading anything the digest did not bring with it", async () => {
    await putDigestPage(bindings.DIGEST_CACHE, REF, PAGE);

    const response = await get(`/digest/${HASH}/2026-09-10`);

    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    // The path carries the feed hash, so it must not travel to the articles.
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });
});
