import { createExecutionContext, env as providedEnv, reset, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";
import { handleFeed } from "../../src/handlers/feed";
import { sha256Hex } from "../../src/hash";
import { jstDate } from "../../src/time";
import { listSubscriptions, register } from "../../src/store/subscriptions";

const kv = (providedEnv as unknown as Env).DIGEST_CACHE;
const url = "https://source.example/rss";
const summarize = vi.fn();
async function crawl(config: Partial<Env> = {}, token?: string, feed = url) {
  const ctx = createExecutionContext();
  const request = new URL("https://worker.example/feed");
  request.searchParams.set("url", feed);
  if (token !== undefined) request.searchParams.set("token", token);
  const response = await handleFeed(new Request(request), {
    DIGEST_CACHE: kv, AI: {} as Ai, ALLOWED_FEED_HOSTS: "source.example", ...config,
  }, ctx, { summarize });
  await waitOnExecutionContext(ctx);
  return response;
}
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); await reset(); });

it.each([
  [{ ALLOWED_FEED_HOSTS: "" }, undefined],
  [{ ALLOWED_FEED_HOSTS: "elsewhere.example" }, undefined],
  [{ ALLOWED_FEED_HOSTS: "example" }, undefined],
  [{ FEED_TOKEN: "secret" }, undefined],
  [{ FEED_TOKEN: "secret" }, "wrong"],
  [{ ALLOWED_FEED_HOSTS: "elsewhere.example", FEED_TOKEN: "secret" }, "secret"],
] as [Partial<Env>, string | undefined][])("rejects unauthorized crawls before any side effects: %j", async (config, token) => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  // Authorization is also required for a cache hit.
  await kv.put(`digest:${await sha256Hex(url)}:${jstDate()}:en`, "<rss/>");
  expect((await crawl(config, token)).status).toBe(403);
  expect(await listSubscriptions(kv)).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
  expect(summarize).not.toHaveBeenCalled();
});

it.each([
  [{ ALLOWED_FEED_HOSTS: " Source.Example, other.example " }, undefined],
  [{ ALLOWED_FEED_HOSTS: "", FEED_TOKEN: "secret" }, "secret"],
  [{ FEED_TOKEN: "secret" }, "secret"],
] as [Partial<Env>, string | undefined][])("registers on a cache hit with configured protection: %j", async (config, token) => {
  await kv.put(`digest:${await sha256Hex(url)}:${jstDate()}:en`, "<rss/>");
  expect((await crawl(config, token)).status).toBe(200);
  expect(await listSubscriptions(kv)).toMatchObject([{ url }]);
});

it("refreshes a normalized cached subscription only after twelve hours", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-10T00:00:00Z"));
  await kv.put(`digest:${await sha256Hex(url)}:${jstDate()}:en`, "<rss/>");
  await crawl({}, undefined, url + "#fragment");
  vi.setSystemTime(new Date("2026-09-10T11:59:59Z"));
  await crawl();
  expect((await listSubscriptions(kv))[0].lastSeenAt).toBe("2026-09-10T00:00:00.000Z");
  vi.setSystemTime(new Date("2026-09-10T12:00:00Z"));
  await crawl();
  expect(await listSubscriptions(kv)).toMatchObject([{ url, registeredAt: "2026-09-10T00:00:00.000Z", lastSeenAt: "2026-09-10T12:00:00.000Z" }]);
});

it("returns 429 for a new subscription at capacity while allowing existing crawls", async () => {
  await register(kv, url);
  await kv.put(`digest:${await sha256Hex(url)}:${jstDate()}:en`, "<rss/>");
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  expect((await crawl({ MAX_SUBSCRIPTIONS: "1" }, undefined, url + "?other")).status).toBe(429);
  expect((await crawl({ MAX_SUBSCRIPTIONS: "1" })).status).toBe(200);
  expect(await listSubscriptions(kv)).toHaveLength(1);
  expect(fetch).not.toHaveBeenCalled();
  expect(summarize).not.toHaveBeenCalled();
});

it("serializes concurrent admission at the cap in one isolate", async () => {
  const result = await Promise.allSettled([register(kv, url, new Date(), 1), register(kv, url + "?other", new Date(), 1)]);
  expect(result.map(r => r.status).sort()).toEqual(["fulfilled", "rejected"]);
  expect(await listSubscriptions(kv)).toHaveLength(1);
});

it("uses the default cap of twenty when not configured", async () => {
  for (let i = 0; i < 20; i++) await register(kv, `${url}?feed=${i}`);
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  expect((await crawl()).status).toBe(429);
  expect(fetch).not.toHaveBeenCalled();
});


it("reports storage error types without leaking private feed credentials", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const secretFeed = url + "?token=private-secret";
  const cache = { async get() { throw new TypeError(`Cannot read ${secretFeed}`); } } as unknown as KVNamespace;
  const response = await crawl({ DIGEST_CACHE: cache }, undefined, secretFeed);
  expect(response.status).toBe(503);
  expect(errors).toHaveBeenCalledWith("Failed to persist subscription (TypeError)");
  expect(JSON.stringify(errors.mock.calls)).not.toContain("private-secret");
  expect(fetch).not.toHaveBeenCalled();
  expect(summarize).not.toHaveBeenCalled();
});
