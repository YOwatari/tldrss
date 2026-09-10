import { buildRssXml } from "./digest/rss";
import { summarizeEntries } from "./digest/summarize";
import { filterEntriesFromLast24Hours } from "./feed/filter";
import { type ParsedFeed, parseFeed } from "./feed/parse";

export type Env = {
  DIGEST_CACHE: KVNamespace;
  AI: Ai;
  /** Workers AI model id; falls back to DEFAULT_AI_MODEL when unset. */
  AI_MODEL?: string;
};

const XML_HEADERS = { "content-type": "application/rss+xml; charset=utf-8" };

function cacheKey(feedUrl: string, now = new Date()): string {
  return `digest:${now.toISOString().slice(0, 10)}:${feedUrl}`;
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

    let feed: ParsedFeed;
    try {
      feed = parseFeed(await feedResponse.text());
    } catch (error) {
      // A malformed body is an upstream problem, so report it like a failed fetch.
      console.error("Failed to parse feed", parsedFeedUrl.toString(), error);
      return new Response("Failed to parse feed", { status: 502 });
    }

    const recentEntries = filterEntriesFromLast24Hours(feed.items);

    const feedTitle = feed.title ?? parsedFeedUrl.host;
    const summary =
      recentEntries.length === 0
        ? "No new entries were published in the last 24 hours."
        : await summarizeEntries({
            ai: env.AI,
            model: env.AI_MODEL,
            feedTitle,
            entries: recentEntries,
          });

    const digestXml = buildRssXml({
      requestUrl: request.url,
      feedUrl: parsedFeedUrl.toString(),
      feedTitle,
      summary,
    });

    await env.DIGEST_CACHE.put(key, digestXml, { expirationTtl: 60 * 60 });

    return new Response(digestXml, { headers: XML_HEADERS });
  },
} satisfies ExportedHandler<Env>;
