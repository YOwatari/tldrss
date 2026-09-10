import { renderDigestHtml } from "./digest/references";
import { buildRssXml } from "./digest/rss";
import {
  DEFAULT_LANGUAGE,
  type DigestLanguage,
  selectPromptEntries,
  summarizeEntries,
} from "./digest/summarize";
import { filterEntriesFromLast24Hours } from "./feed/filter";
import { type ParsedFeed, parseFeed } from "./feed/parse";

export type Env = {
  DIGEST_CACHE: KVNamespace;
  AI: Ai;
  /** Workers AI model id; falls back to DEFAULT_AI_MODEL when unset. */
  AI_MODEL?: string;
};

const XML_HEADERS = { "content-type": "application/rss+xml; charset=utf-8" };

/**
 * Languages accepted in the `lang` query parameter. Omitting it keeps the
 * default, so only the non-default languages have to be listed here.
 */
const REQUESTABLE_LANGUAGES = ["ja"] as const satisfies readonly DigestLanguage[];

function isRequestableLanguage(value: string): value is (typeof REQUESTABLE_LANGUAGES)[number] {
  return (REQUESTABLE_LANGUAGES as readonly string[]).includes(value);
}

// Digests of the same feed differ per language, so the language is part of the key.
function cacheKey(feedUrl: string, language: DigestLanguage, now = new Date()): string {
  return `digest:${now.toISOString().slice(0, 10)}:${language}:${feedUrl}`;
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

    const requestedLanguage = requestUrl.searchParams.get("lang");
    if (requestedLanguage !== null && !isRequestableLanguage(requestedLanguage)) {
      return new Response(
        `Unsupported lang query parameter. Supported: ${REQUESTABLE_LANGUAGES.join(", ")}`,
        { status: 400 },
      );
    }
    const language: DigestLanguage = requestedLanguage ?? DEFAULT_LANGUAGE;

    const key = cacheKey(parsedFeedUrl.toString(), language);
    const cached = await env.DIGEST_CACHE.get(key);
    if (cached) {
      return new Response(cached, { headers: XML_HEADERS });
    }

    // Everything that can go wrong upstream — DNS, connection, redirects, a
    // malformed body — is reported as 502 rather than escaping as a 500.
    let feed: ParsedFeed;
    try {
      const feedResponse = await fetch(parsedFeedUrl.toString());
      if (!feedResponse.ok) {
        return new Response(`Failed to fetch feed: ${feedResponse.status}`, { status: 502 });
      }
      feed = parseFeed(await feedResponse.text());
    } catch (error) {
      // Private feed URLs carry credentials in the query string, so only the
      // origin and the error class are logged.
      const kind = error instanceof Error ? error.name : typeof error;
      console.error(`Failed to read feed from ${parsedFeedUrl.origin} (${kind})`);
      return new Response("Failed to read feed", { status: 502 });
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
            language,
          });

    const digestXml = buildRssXml({
      requestUrl: request.url,
      feedUrl: parsedFeedUrl.toString(),
      feedTitle,
      // Reference markers are numbered against the same list the prompt used.
      summaryHtml: renderDigestHtml(summary, selectPromptEntries(recentEntries)),
    });

    await env.DIGEST_CACHE.put(key, digestXml, { expirationTtl: 60 * 60 });

    return new Response(digestXml, { headers: XML_HEADERS });
  },
} satisfies ExportedHandler<Env>;
