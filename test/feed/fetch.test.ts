import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchFeed, FeedFetchError } from "../../src/feed/fetch";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("fetchFeed", () => {
  it("validates relative redirects before following them", async () => {
    const fetched: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      fetched.push(url);
      return url.endsWith("/start")
        ? new Response(null, { status: 302, headers: { location: "/final" } })
        : new Response("<rss/>");
    }));

    await expect(fetchFeed(new URL("https://source.example/start"), {
      timeoutMs: 1000, maxBytes: 1000, isAllowed: url => url.hostname === "source.example",
    })).resolves.toBe("<rss/>");
    expect(fetched).toEqual(["https://source.example/start", "https://source.example/final"]);
  });

  it("rejects a redirect to a disallowed destination", async () => {
    const fetched: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      fetched.push(String(input));
      return new Response(null, { status: 302, headers: { location: "https://private.example/feed" } });
    }));

    await expect(fetchFeed(new URL("https://source.example/feed"), {
      timeoutMs: 1000, maxBytes: 1000, isAllowed: url => url.hostname === "source.example",
    })).rejects.toMatchObject({ code: "policy" });
    expect(fetched).toEqual(["https://source.example/feed"]);
  });

  it("rejects redirect loops and excessive redirects", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => new Response(null, {
      status: 302, headers: { location: String(input) },
    })));
    await expect(fetchFeed(new URL("https://source.example/feed"), {
      timeoutMs: 1000, maxBytes: 1000, isAllowed: () => true, maxRedirects: 2,
    })).rejects.toMatchObject({ code: "redirect" });
  });

  it("times out when the upstream never responds", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    const pending = fetchFeed(new URL("https://source.example/feed"), { timeoutMs: 100, maxBytes: 1000 });
    const assertion = expect(pending).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(101);
    await assertion;
  });

  it("times out while reading a body that stops after headers", async () => {
    vi.useFakeTimers();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("<rss>")); },
      cancel() {},
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body)));
    const pending = fetchFeed(new URL("https://source.example/feed"), { timeoutMs: 100, maxBytes: 1000 });
    const assertion = expect(pending).rejects.toBeInstanceOf(FeedFetchError);
    await vi.advanceTimersByTimeAsync(101);
    await assertion;
  });

  it("counts streamed bytes and rejects a body without Content-Length", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); controller.enqueue(new Uint8Array([4])); controller.close(); },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body)));
    await expect(fetchFeed(new URL("https://source.example/feed"), { timeoutMs: 1000, maxBytes: 3 })).rejects.toMatchObject({ code: "too_large" });
  });

  it("accepts a body at the configured limit", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("<rss/>")); controller.close(); },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body)));
    await expect(fetchFeed(new URL("https://source.example/feed"), { timeoutMs: 1000, maxBytes: 6 })).resolves.toBe("<rss/>");
  });
});
