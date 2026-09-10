import {
  DEFAULT_LANGUAGE,
  DIGEST_LANGUAGES,
  type DigestLanguage,
  isDigestLanguage,
} from "../digest/language";
import { buildEmptyChannelXml } from "../digest/build";
import { digestLinksOf, generateDigest } from "../digest/generate";
import type { DigestLinks } from "../digest/types";
import type { Env } from "../env";
import type { Summarizer } from "../llm/summarizer";
import { sha256Hex } from "../hash";
import { getDigest } from "../store/digest-cache";
import type { DigestRef } from "../store/digest-ref";
import { jstDate, previousDate } from "../time";

/**
 * Slack polls every 15-30 minutes, so five minutes of edge caching cuts
 * repeated origin hits without delaying a digest by a noticeable amount.
 */
const XML_HEADERS = {
  "content-type": "application/xml; charset=utf-8",
  "cache-control": "public, max-age=300",
};

function xmlResponse(xml: string): Response {
  return new Response(xml, { headers: XML_HEADERS });
}

/**
 * The canonical form of a feed url. A fragment inside the `url` parameter does
 * reach us, but it identifies a place in the document rather than a different
 * feed, so it is dropped to keep both spellings on one cache entry.
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

/**
 * GET /feed?url=<feed>&lang=<en|ja>
 *
 * The summarizer is passed in rather than built here: which model answers is
 * a decision for the composition root (`index.ts`), and a test can summarize
 * without one.
 */
export async function handleFeed(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  summarizer: Summarizer,
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
  if (requestedLanguage !== null && !isDigestLanguage(requestedLanguage)) {
    return new Response(
      `Unsupported lang query parameter. Supported: ${DIGEST_LANGUAGES.join(", ")}`,
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

  const links = digestLinksOf(requestUrl.origin, ref);

  // Today's digest is missing, so generate it in the background: the crawler
  // gets an answer within its timeout either way.
  ctx.waitUntil(generateInBackground(env, summarizer, ref, feedUrl, links));

  // Yesterday's digest keeps the subscription populated when today's cron run
  // (or a previous background generation) has not produced one yet.
  const yesterday = await getDigest(env.DIGEST_CACHE, {
    ...ref,
    date: previousDate(ref.date),
  });
  if (yesterday) return xmlResponse(yesterday);

  return xmlResponse(
    buildEmptyChannelXml({ feedTitle: feedUrl.host, language: ref.language, links }),
  );
}

/**
 * Generation outside the response, where every failure is logged rather than
 * surfaced: the reader has already been served yesterday's digest or an empty
 * channel. Nothing may escape either — this promise is handed to `waitUntil`,
 * where a rejection would be an unhandled one.
 */
async function generateInBackground(
  env: Env,
  summarizer: Summarizer,
  ref: DigestRef,
  feedUrl: URL,
  links: DigestLinks,
): Promise<void> {
  try {
    await generateDigest({ env, summarizer, ref, feedUrl, links });
  } catch (error) {
    // Private feed URLs carry credentials in the query string, so only the
    // origin and the error class are logged.
    const kind = error instanceof Error ? error.name : typeof error;
    console.error(`Failed to build digest for ${feedUrl.origin} (${kind})`);
  }
}
