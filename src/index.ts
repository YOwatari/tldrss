import { buildDigestPrompt, buildRssXml } from "./digest/rss";
import { filterEntriesFromLast24Hours } from "./feed/filter";
import { parseFeed } from "./feed/parse";

export type Env = {
  DIGEST_CACHE: KVNamespace;
  GEMINI_API_KEY: string;
  GEMINI_MODEL?: string;
};

const XML_HEADERS = { "content-type": "application/rss+xml; charset=utf-8" };

function cacheKey(feedUrl: string, now = new Date()): string {
  return `digest:${now.toISOString().slice(0, 10)}:${feedUrl}`;
}

async function summarizeWithGemini(prompt: string, env: Env): Promise<string> {
  const model = env.GEMINI_MODEL ?? "gemini-2.5-flash";
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`Gemini request failed: ${response.status}`);
  }

  const data = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };

  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "No summary generated.";
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const requestUrl = new URL(request.url);
    const feedUrl = requestUrl.searchParams.get("url");

    if (!feedUrl) {
      return new Response("Missing required query parameter: url", { status: 400 });
    }

    let parsedFeedUrl: URL;
    try {
      parsedFeedUrl = new URL(feedUrl);
      if (!/^https?:$/.test(parsedFeedUrl.protocol)) {
        throw new Error("Unsupported protocol");
      }
    } catch {
      return new Response("Invalid url query parameter", { status: 400 });
    }

    const key = cacheKey(parsedFeedUrl.toString());
    const cached = await env.DIGEST_CACHE.get(key);
    if (cached) {
      return new Response(cached, { headers: XML_HEADERS });
    }

    const feedResponse = await fetch(parsedFeedUrl.toString());
    if (!feedResponse.ok) {
      return new Response(`Failed to fetch feed: ${feedResponse.status}`, { status: 502 });
    }

    const xml = await feedResponse.text();
    const feed = parseFeed(xml);
    const recentEntries = filterEntriesFromLast24Hours(feed.items);

    const summary =
      recentEntries.length === 0
        ? "No new entries were published in the last 24 hours."
        : await summarizeWithGemini(buildDigestPrompt(feed.title ?? parsedFeedUrl.host, recentEntries), env);

    const digestXml = buildRssXml({
      requestUrl: request.url,
      feedUrl: parsedFeedUrl.toString(),
      feedTitle: feed.title ?? parsedFeedUrl.host,
      summary,
    });

    await env.DIGEST_CACHE.put(key, digestXml, { expirationTtl: 60 * 60 });

    return new Response(digestXml, { headers: XML_HEADERS });
  },
} satisfies ExportedHandler<Env>;
