import { createExecutionContext, env as providedEnv, reset, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";
import { handleFeed } from "../../src/handlers/feed";
import { handleScheduled } from "../../src/handlers/cron";
import { handleDigestPage } from "../../src/handlers/digest-page";
import { listSubscriptions, register, subscriptionKey, touch, remove } from "../../src/store/subscriptions";
import { getDigest, putDigest } from "../../src/store/digest-cache";
import { digestLinksOf } from "../../src/digest/generate";
import { putDigestPage } from "../../src/store/digest-page";
import { periodDate } from "../../src/digest/period";
import type { DigestInput } from "../../src/llm/summarizer";

const env = { ...providedEnv, ALLOWED_FEED_HOSTS: "source.example", PUBLIC_ORIGIN: "https://worker.example" } as unknown as Env;
const feedUrl = "https://source.example/weekly";
const calls: DigestInput[] = [];
const summarizer = { async summarize(input: DigestInput) { calls.push(input); return "[1] A weekly update."; } };

afterEach(async () => {
  calls.length = 0;
  vi.unstubAllGlobals();
  await reset();
});

it("registers both periods and serves the same weekly edition through Cron and crawls", async () => {
  const now = new Date();
  const date = periodDate(now, "weekly");
  const end = Date.parse(`${date}T00:00:00+09:00`);
  const published = new Date(end - 3 * 86400000).toUTCString();
  const fetchStub = vi.fn(async () => new Response(`<rss version="2.0"><channel><title>Feed</title><item><title>Article</title><link>https://source.example/1</link><pubDate>${published}</pubDate></item></channel></rss>`));
  vi.stubGlobal("fetch", fetchStub);
  const daily = await register(env.DIGEST_CACHE, feedUrl, now);
  await register(env.DIGEST_CACHE, feedUrl, now, 20, "weekly");
  expect(await listSubscriptions(env.DIGEST_CACHE)).toHaveLength(2);
  const run = await handleScheduled({ scheduledTime: now.getTime(), cron: "50 23 * * *" }, env, summarizer);
  expect(run).toMatchObject({ total: 2, generated: 2, failed: 0 });
  expect(calls).toHaveLength(1);
  expect(calls[0].period).toBe("weekly");
  const ref = { hash: daily.hash, date, language: "en", period: "weekly" } as const;
  const xml = await getDigest(env.DIGEST_CACHE, ref);
  expect(xml).toContain("Weekly Digest: Feed");
  expect(xml).toContain(`${daily.hash}-${date}-en-weekly`);
  const page = await handleDigestPage(new Request(digestLinksOf(env.PUBLIC_ORIGIN!, ref).pageUrl), env);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("Weekly Digest: Feed");
  const ctx = createExecutionContext();
  const response = await handleFeed(new Request(`${env.PUBLIC_ORIGIN}/feed?url=${feedUrl}&period=weekly`), env, ctx, summarizer);
  await waitOnExecutionContext(ctx);
  expect(await response.text()).toBe(xml);
  const repeat = await handleScheduled({ scheduledTime: now.getTime(), cron: "50 23 * * *" }, env, summarizer);
  expect(repeat).toMatchObject({ generated: 0, skipped: 2 });
  expect(fetchStub).toHaveBeenCalledTimes(2);
});

it("serves the previous weekly edition when background generation fails", async () => {
  const now = new Date();
  const previous = new Date(now.getTime() - 7 * 86400000);
  const { hash } = await register(env.DIGEST_CACHE, feedUrl, now, 20, "weekly");
  await putDigest(env.DIGEST_CACHE, { hash, date: periodDate(previous, "weekly"), language: "en", period: "weekly" }, "<rss>previous week</rss>");
  vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 503 })));
  const ctx = createExecutionContext();
  const response = await handleFeed(new Request(`${env.PUBLIC_ORIGIN}/feed?url=${feedUrl}&period=weekly`), env, ctx, summarizer);
  await waitOnExecutionContext(ctx);
  expect(await response.text()).toBe("<rss>previous week</rss>");
});

it("refreshes and removes weekly subscriptions independently", async () => {
  const earlier = new Date(Date.now() - 13 * 3600000);
  const { hash } = await register(env.DIGEST_CACHE, feedUrl, earlier);
  await register(env.DIGEST_CACHE, feedUrl, earlier, 20, "weekly");
  expect(await touch(env.DIGEST_CACHE, hash, new Date(), "weekly")).toBe(true);
  await remove(env.DIGEST_CACHE, hash, "weekly");
  expect(await env.DIGEST_CACHE.get(subscriptionKey(hash))).not.toBeNull();
  expect(await env.DIGEST_CACHE.get(subscriptionKey(hash, "weekly"))).toBeNull();
});

it("rejects unsupported periods before registering a subscription", async () => {
  const ctx = createExecutionContext();
  const response = await handleFeed(new Request(`${env.PUBLIC_ORIGIN}/feed?url=${feedUrl}&period=monthly`), env, ctx, summarizer);
  expect(response.status).toBe(400);
  expect(await listSubscriptions(env.DIGEST_CACHE)).toEqual([]);
});

it("retains both weekly XML and HTML for fourteen days", async () => {
  const put = vi.fn(async () => {});
  const cache = { put } as unknown as KVNamespace;
  const ref = { hash: "a".repeat(64), date: "2026-09-14", language: "en", period: "weekly" } as const;
  await putDigest(cache, ref, "<rss/>");
  await putDigestPage(cache, ref, { feedTitle: "Feed", html: "<p>Weekly</p>" });
  expect(put).toHaveBeenNthCalledWith(1, expect.stringContaining(":weekly"), "<rss/>", { expirationTtl: 14 * 86400 });
  expect(put).toHaveBeenNthCalledWith(2, expect.stringContaining(":weekly"), expect.any(String), { expirationTtl: 14 * 86400 });
});
