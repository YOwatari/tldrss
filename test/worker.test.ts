import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";

type MockKV = {
  get: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
};

function makeEnv(kv: MockKV) {
  return {
    DIGEST_CACHE: kv,
    GEMINI_API_KEY: "test-key",
    GEMINI_MODEL: "gemini-1.5-flash",
  };
}

describe("worker", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 400 when url parameter is missing", async () => {
    const response = await worker.fetch(new Request("https://worker.example/"), makeEnv({
      get: vi.fn(),
      put: vi.fn(),
    }) as never);

    expect(response.status).toBe(400);
  });

  it("returns cached rss when present", async () => {
    const kv = {
      get: vi.fn().mockResolvedValue("<rss>cached</rss>"),
      put: vi.fn(),
    };

    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const response = await worker.fetch(
      new Request("https://worker.example/?url=https://source.example/rss.xml"),
      makeEnv(kv as MockKV) as never,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<rss>cached</rss>");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("fetches feed, summarizes, and stores digest when cache misses", async () => {
    const recentDate = new Date(Date.now() - 60 * 60 * 1000).toUTCString();
    const feedXml = `<?xml version="1.0"?><rss version="2.0"><channel><title>Test Feed</title><item><title>Entry 1</title><link>https://source.example/1</link><pubDate>${recentDate}</pubDate><description>Hello</description></item></channel></rss>`;

    const kv = {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
    };

    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(new Response(feedXml, { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: "- summary" }] } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

    vi.stubGlobal("fetch", fetchSpy);

    const response = await worker.fetch(
      new Request("https://worker.example/?url=https://source.example/rss.xml"),
      makeEnv(kv as MockKV) as never,
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("<rss version=\"2.0\">");
    expect(body).toContain("- summary");
    expect(kv.put).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
