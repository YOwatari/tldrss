import { renderDigestHtml } from "../digest/references";
import { buildEmptyChannelXml, buildRssXml } from "../digest/rss";
import {
  DEFAULT_LANGUAGE,
  type DigestLanguage,
  noRecentEntriesText,
  selectPromptEntries,
  summarizeEntries,
} from "../digest/summarize";
import type { Env } from "../env";
import { filterEntriesFromLast24Hours } from "../feed/filter";
import { parseFeed } from "../feed/parse";
import { sha256Hex } from "../hash";
import { getDigest, putDigest } from "../store/digest-cache";
import type { DigestRef } from "../store/digest-ref";
import { acquireGenerationLock, releaseGenerationLock } from "../store/generation-lock";
import { jstDate, previousDate } from "../time";

/**
 * Slack polls every 15-30 minutes, so five minutes of edge caching cuts
 * repeated origin hits without delaying a digest by a noticeable amount.
 */
const XML_HEADERS = {
  "content-type": "application/xml; charset=utf-8",
  "cache-control": "public, max-age=300",
};

/**
 * Languages accepted in the `lang` query parameter. The default is listed too,
 * so a reader can pin the language explicitly instead of relying on the default.
 */
const REQUESTABLE_LANGUAGES = ["en", "ja"] as const satisfies readonly DigestLanguage[];

function isRequestableLanguage(value: string): value is (typeof REQUESTABLE_LANGUAGES)[number] {
  return (REQUESTABLE_LANGUAGES as readonly string[]).includes(value);
}

function xmlResponse(xml: string): Response {
  return new Response(xml, { headers: XML_HEADERS });
}

/**
 * The canonical form of a feed url: fragments never reach the server, so two
 * urls that differ only by one must not become two cache entries.
 */
function normalizeFeedUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  url.hash = "";
  return url;
}

/** GET /feed?url=<feed>&lang=<en|ja> */
export async function handleFeed(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const requestUrl = new URL(request.url);

  const rawFeedUrl = requestUrl.searchParams.get("url");
  if (!rawFeedUrl) {
    return new Response("Missing required query parameter: url", { status: 400 });
  }

  const feedUrl = normalizeFeedUrl(rawFeedUrl);
  if (!feedUrl) {
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

  const ref: DigestRef = {
    hash: await sha256Hex(feedUrl.toString()),
    date: jstDate(),
    language,
  };

  const today = await getDigest(env.DIGEST_CACHE, ref);
  if (today) return xmlResponse(today);

  // Today's digest is missing, so generate it in the background: the crawler
  // gets an answer within its timeout either way.
  ctx.waitUntil(generateDigest(env, ref, feedUrl, request.url));

  // Yesterday's digest keeps the subscription populated when today's cron run
  // (or a previous background generation) has not produced one yet.
  const yesterday = await getDigest(env.DIGEST_CACHE, {
    ...ref,
    date: previousDate(ref.date),
  });
  if (yesterday) return xmlResponse(yesterday);

  return xmlResponse(
    buildEmptyChannelXml({ requestUrl: request.url, feedTitle: feedUrl.host }),
  );
}

/**
 * Fetches, summarizes and stores one digest. Runs outside the response, so
 * every failure is logged rather than surfaced: the reader has already been
 * served yesterday's digest or an empty channel.
 */
async function generateDigest(
  env: Env,
  ref: DigestRef,
  feedUrl: URL,
  requestUrl: string,
): Promise<void> {
  // Nothing may escape: this promise is handed to `waitUntil`, where a
  // rejection would be an unhandled one. KV itself can fail, so acquiring and
  // releasing the lock are inside the guard too.
  try {
    if (!(await acquireGenerationLock(env.DIGEST_CACHE, ref))) return;

    try {
      const digestXml = await buildDigest(env, ref, feedUrl, requestUrl);
      await putDigest(env.DIGEST_CACHE, ref, digestXml);
    } finally {
      await releaseGenerationLock(env.DIGEST_CACHE, ref);
    }
  } catch (error) {
    // Private feed URLs carry credentials in the query string, so only the
    // origin and the error class are logged.
    const kind = error instanceof Error ? error.name : typeof error;
    console.error(`Failed to build digest for ${feedUrl.origin} (${kind})`);
  }
}

async function buildDigest(
  env: Env,
  ref: DigestRef,
  feedUrl: URL,
  requestUrl: string,
): Promise<string> {
  const feedResponse = await fetch(feedUrl.toString());
  if (!feedResponse.ok) {
    throw new Error(`Feed responded with ${feedResponse.status}`);
  }

  const feed = parseFeed(await feedResponse.text());
  const recentEntries = filterEntriesFromLast24Hours(feed.items);
  const feedTitle = feed.title ?? feedUrl.host;

  const summary =
    recentEntries.length === 0
      ? noRecentEntriesText(ref.language)
      : await summarizeEntries({
          ai: env.AI,
          model: env.AI_MODEL,
          feedTitle,
          entries: recentEntries,
          language: ref.language,
        });

  return buildRssXml({
    requestUrl,
    feedUrl: feedUrl.toString(),
    feedTitle,
    // Reference markers are numbered against the same list the prompt used.
    summaryHtml: renderDigestHtml(summary, selectPromptEntries(recentEntries), ref.language),
    language: ref.language,
  });
}
