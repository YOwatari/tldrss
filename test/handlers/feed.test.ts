import { createExecutionContext, env as providedEnv, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";
import { handleFeed } from "../../src/handlers/feed";
import type { DigestInput, Summarizer } from "../../src/llm/summarizer";

const FEED_ORIGIN = "https://source.example";
const FEED_URL = `${FEED_ORIGIN}/rss.xml`;
const WORKER_URL = `https://worker.example/feed?url=${FEED_URL}`;

/**
 * The handler takes a `Summarizer`, so these tests need no `AI` binding: the
 * model is the fake below.
 */
const bindings = providedEnv as unknown as Omit<Env, "AI">;

function fakeSummarizer(answer = "[1] It shipped."): Summarizer & {
  calls: DigestInput[];
} {
  const calls: DigestInput[] = [];

  return {
    calls,
    async summarize(input) {
      calls.push(input);
      return answer;
    },
  };
}

function stubFeedFetch(body: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(body)),
  );
}

function feedXml(pubDate: string): string {
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>Test Feed</title><item><title>Entry 1</title><link>${FEED_ORIGIN}/1</link><pubDate>${pubDate}</pubDate><description>Hello</description></item></channel></rss>`;
}

async function generate(summarizer: Summarizer, env = bindings): Promise<void> {
  const ctx = createExecutionContext();
  await handleFeed(new Request(WORKER_URL), env as Env, ctx, summarizer);
  await waitOnExecutionContext(ctx);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("handleFeed (summarizer injection)", () => {
  it("summarizes the day's entries with the summarizer it was given", async () => {
    stubFeedFetch(feedXml(new Date(Date.now() - 60 * 60 * 1000).toUTCString()));
    const summarizer = fakeSummarizer();

    await generate(summarizer);

    expect(summarizer.calls).toHaveLength(1);
    expect(summarizer.calls[0]).toMatchObject({
      feedTitle: "Test Feed",
      availableCount: 1,
      language: "en",
    });
    expect(summarizer.calls[0].entries.map((entry) => entry.title)).toEqual(["Entry 1"]);
  });

  it("passes the requested language on to the summarizer", async () => {
    stubFeedFetch(feedXml(new Date(Date.now() - 60 * 60 * 1000).toUTCString()));
    const summarizer = fakeSummarizer();
    const ctx = createExecutionContext();

    await handleFeed(new Request(`${WORKER_URL}&lang=ja`), bindings as Env, ctx, summarizer);
    await waitOnExecutionContext(ctx);

    expect(summarizer.calls[0].language).toBe("ja");
  });

  it("never asks the summarizer about a feed with nothing recent", async () => {
    stubFeedFetch(feedXml(new Date(Date.now() - 48 * 60 * 60 * 1000).toUTCString()));
    const summarizer = fakeSummarizer();

    await generate(summarizer);

    expect(summarizer.calls).toEqual([]);
  });
});
