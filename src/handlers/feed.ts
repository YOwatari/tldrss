import {
  DEFAULT_LANGUAGE,
  DIGEST_LANGUAGES,
  type DigestLanguage,
  isDigestLanguage,
} from "../digest/language";
import { renderDigestHtml, renderEntryListHtml } from "../digest/html";
import { buildEmptyChannelXml, buildRssXml } from "../digest/rss";
import { noRecentEntriesText } from "../digest/text";
import { type Env, maxEntriesOf } from "../env";
import { parseFeed } from "../feed/parse";
import { type EntrySelection, selectRecentEntries } from "../feed/select";
import type { Summarizer } from "../llm/summarizer";
import { createWorkersAiSummarizer } from "../llm/workers-ai";
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

  // Every link below travels to readers, so it is built from the path only:
  // the `url` query parameter can carry a token for a private feed. Step 3
  // replaces it with a per-digest page at /digest/{hash}/{date}.
  const publicUrl = `${requestUrl.origin}${requestUrl.pathname}`;

  // Today's digest is missing, so generate it in the background: the crawler
  // gets an answer within its timeout either way.
  ctx.waitUntil(generateDigest(env, ref, feedUrl, publicUrl));

  // Yesterday's digest keeps the subscription populated when today's cron run
  // (or a previous background generation) has not produced one yet.
  const yesterday = await getDigest(env.DIGEST_CACHE, {
    ...ref,
    date: previousDate(ref.date),
  });
  if (yesterday) return xmlResponse(yesterday);

  return xmlResponse(buildEmptyChannelXml({ publicUrl, feedTitle: feedUrl.host }));
}

/**
 * The digest body: the model's summary, or the day's entries as bare links
 * when summarizing failed.
 *
 * Only the summary is given up on. Titles and links are already in hand, and
 * a reader whose subscription goes silent on a model outage has no way to tell
 * that from a broken feed. The fallback is then cached like any other digest,
 * so a failure costs the day its summary rather than triggering a retry on
 * every crawl.
 */
async function summarizeOrList(
  env: Env,
  selection: EntrySelection,
  feedTitle: string,
  language: DigestLanguage,
): Promise<string> {
  const summarizer: Summarizer = createWorkersAiSummarizer({ ai: env.AI, model: env.AI_MODEL });

  try {
    const summary = await summarizer.summarize({
      feedTitle,
      entries: selection.entries,
      availableCount: selection.availableCount,
      language,
    });

    // Reference markers are numbered against the list the prompt used.
    const html = renderDigestHtml(summary, selection.entries, language);
    // An answer can be non-blank and still leave nothing behind — markup the
    // sanitizer drops whole, say. An empty body is worse for a reader than the
    // entry list, so it is treated as a failure to summarize.
    if (html.trim() === "") throw new Error("Digest body was empty after rendering");

    return html;
  } catch (error) {
    // Unlike the failure logged in `generateDigest`, this one comes from the
    // model rather than from the feed url, so it carries no credentials and is
    // logged whole: a timeout and an unusable answer need telling apart.
    console.error(`Failed to summarize ${selection.entries.length} entries`, error);

    return renderEntryListHtml(selection.entries, language);
  }
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
  publicUrl: string,
): Promise<void> {
  // Nothing may escape: this promise is handed to `waitUntil`, where a
  // rejection would be an unhandled one. KV itself can fail, so acquiring and
  // releasing the lock are inside the guard too.
  try {
    const lockToken = await acquireGenerationLock(env.DIGEST_CACHE, ref);
    if (!lockToken) return;

    try {
      const digestXml = await buildDigest(env, ref, feedUrl, publicUrl);
      await putDigest(env.DIGEST_CACHE, ref, digestXml);
    } finally {
      await releaseGenerationLock(env.DIGEST_CACHE, ref, lockToken);
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
  publicUrl: string,
): Promise<string> {
  const feedResponse = await fetch(feedUrl.toString());
  if (!feedResponse.ok) {
    throw new Error(`Feed responded with ${feedResponse.status}`);
  }

  const feed = parseFeed(await feedResponse.text());
  const feedTitle = feed.title ?? feedUrl.host;
  const selection = selectRecentEntries(feed.items, { maxEntries: maxEntriesOf(env) });

  const summaryHtml =
    selection.entries.length === 0
      ? renderDigestHtml(noRecentEntriesText(ref.language), [], ref.language)
      : await summarizeOrList(env, selection, feedTitle, ref.language);

  return buildRssXml({
    publicUrl,
    feedHash: ref.hash,
    digestDate: ref.date,
    feedTitle,
    summaryHtml,
    language: ref.language,
  });
}
