import { createExecutionContext, env as providedEnv, reset } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import type { Env } from "../../src/env";
import { handleScheduled } from "../../src/handlers/cron";
import { CRON_STATUS_KEY } from "../../src/store/cron-status";
import { putSubscription } from "../../src/store/subscriptions";
import { sha256Hex } from "../../src/hash";

const kv = (providedEnv as unknown as Env).DIGEST_CACHE;
const scheduledTime = Date.parse("2026-09-09T23:50:00Z");
const trigger = { scheduledTime, cron: "50 23 * * *" };
const summarizer = { summarize: vi.fn().mockResolvedValue("[1] A summary.") };
const bindings = () => ({ DIGEST_CACHE: kv, PUBLIC_ORIGIN: "https://worker.example" }) as Env;

async function health(env = bindings(), method = "GET") {
  return worker.fetch(new Request("https://worker.example/health", { method }), env, createExecutionContext());
}

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await reset();
});

describe("Cron health", () => {
  it("reports an unobserved Cron as unavailable, with no cacheable response", async () => {
    const response = await health();
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ status: "error", reason: "cron_missing" });
  });

  it("persists a successful empty run and serves its status without calling AI", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(scheduledTime + 60_000);
    await handleScheduled(trigger, bindings(), summarizer);
    const response = await health();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "ok", cron: { scheduledTime, summary: { total: 0, failed: 0 } },
    });
    const head = await health(bindings(), "HEAD");
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("detects a missing morning run at 09:05 JST, after a 15 minute grace period", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(scheduledTime);
    await handleScheduled(trigger, bindings(), summarizer);
    vi.setSystemTime(Date.parse("2026-09-11T00:04:59Z"));
    expect((await health()).status).toBe(200);
    vi.setSystemTime(Date.parse("2026-09-11T00:05:00Z"));
    const response = await health();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ reason: "cron_stale" });
  });

  it("reports invalid configuration even before Cron runs", async () => {
    const response = await health({ ...bindings(), PUBLIC_ORIGIN: "" });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ reason: "invalid_public_origin" });
    await handleScheduled(trigger, { ...bindings(), PUBLIC_ORIGIN: "" }, summarizer);
    expect(JSON.parse((await kv.get(CRON_STATUS_KEY))!)).toMatchObject({
      summary: { error: "invalid_public_origin" },
    });
  });

  it("records partial failures without exposing private feed URLs or exception text", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(scheduledTime);
    const privateUrl = "https://source.example/rss?token=private-secret";
    await putSubscription(kv, await sha256Hex(privateUrl), {
      url: privateUrl, registeredAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(),
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error(privateUrl)));
    await handleScheduled(trigger, bindings(), summarizer);
    const response = await health();
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ reason: "cron_failed", cron: { summary: { total: 1, failed: 1 } } });
    expect(text).not.toContain("private-secret");
    expect(text).not.toContain("source.example");
  });

  it("records subscription listing failures and still rejects the scheduled invocation", async () => {
    const failure = new Error("private upstream details");
    const cache = {
      get: kv.get.bind(kv), put: kv.put.bind(kv),
      list: async () => { throw failure; },
    } as unknown as KVNamespace;
    await expect(handleScheduled(trigger, { ...bindings(), DIGEST_CACHE: cache }, summarizer)).rejects.toBe(failure);
    expect(JSON.parse((await kv.get(CRON_STATUS_KEY))!)).toMatchObject({
      summary: { error: "subscription_read_failed" },
    });
    expect(await kv.get(CRON_STATUS_KEY)).not.toContain("private upstream");
  });

  it("does not hide a failure to persist the monitoring record", async () => {
    const cache = {
      list: kv.list.bind(kv), get: kv.get.bind(kv),
      put: async () => { throw new Error("KV write failed"); },
    } as unknown as KVNamespace;
    await expect(handleScheduled(trigger, { ...bindings(), DIGEST_CACHE: cache }, summarizer)).rejects.toThrow("KV write failed");
  });

  it.each(["not json", "{}", '{"scheduledTime":null}', '{"scheduledTime":9999999999999,"summary":{"failed":0}}'])(
    "rejects malformed monitoring data: %s", async (stored) => {
      await kv.put(CRON_STATUS_KEY, stored);
      expect((await health()).status).toBe(503);
    },
  );

  it("returns 503 on a KV outage without disclosing the error", async () => {
    const cache = { get: async () => { throw new Error("secret"); } } as unknown as KVNamespace;
    const response = await health({ ...bindings(), DIGEST_CACHE: cache });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "error", reason: "storage_unavailable" });
  });

  it("rejects mutations", async () => {
    expect((await health(bindings(), "POST")).status).toBe(405);
  });
});
