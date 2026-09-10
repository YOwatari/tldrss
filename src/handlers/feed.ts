import {
  DEFAULT_LANGUAGE,
  DIGEST_LANGUAGES,
  type DigestLanguage,
  isDigestLanguage,
} from "../digest/language";
import { renderDigestHtml, renderEntryListHtml } from "../digest/html";
import { buildDigestXml, buildEmptyChannelXml } from "../digest/build";
import { noRecentEntriesText } from "../digest/text";
import type { Digest, DigestLinks } from "../digest/types";
import { type Env, maxEntriesOf, shouldPostNoUpdates } from "../env";
import { parseFeed } from "../feed/parse";
import { type EntrySelection, selectRecentEntries } from "../feed/select";
import type { Summarizer } from "../llm/summarizer";
import { sha256Hex } from "../hash";
import { getDigest, putDigest } from "../store/digest-cache";
import { putDigestPage } from "../store/digest-page";
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

  const links = digestLinksOf(requestUrl, ref);

  // Today's digest is missing, so generate it in the background: the crawler
  // gets an answer within its timeout either way.
  ctx.waitUntil(generateDigest(env, summarizer, ref, feedUrl, links));

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
 * The addresses that travel to readers. Both are built from the path only: the
 * `url` query parameter can carry a token for a private feed, and the xml they
 * end up in is handed to every subscriber.
 */
function digestLinksOf(requestUrl: URL, ref: DigestRef): DigestLinks {
  return {
    feedUrl: `${requestUrl.origin}${requestUrl.pathname}`,
    // The language is spelled out even when it is the default one, so the link
    // keeps pointing at this digest if the default ever changes.
    pageUrl: `${requestUrl.origin}/digest/${ref.hash}/${ref.date}?lang=${ref.language}`,
  };
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
  summarizer: Summarizer,
  selection: EntrySelection,
  feedTitle: string,
  language: DigestLanguage,
): Promise<string> {
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
  summarizer: Summarizer,
  ref: DigestRef,
  feedUrl: URL,
  links: DigestLinks,
): Promise<void> {
  // Nothing may escape: this promise is handed to `waitUntil`, where a
  // rejection would be an unhandled one. KV itself can fail, so acquiring and
  // releasing the lock are inside the guard too.
  try {
    const lockToken = await acquireGenerationLock(env.DIGEST_CACHE, ref);
    if (!lockToken) return;

    try {
      const digest = await buildDigest(env, summarizer, ref, feedUrl);
      await storeDigest(env, digest, links);
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

/**
 * Stores the day's feed, and the page its item links to.
 *
 * A feed with nothing new gets an item-less channel, so Slack posts nothing:
 * one message a day is the point of the digest, and a message saying there is
 * nothing to read is worse than silence. `POST_NO_UPDATES` turns it back on
 * for anyone who would rather see the feed report in every day.
 *
 * The page is written before the xml. Both land in the same KV namespace, so
 * a reader that sees the item already finds the page behind its link.
 */
async function storeDigest(env: Env, digest: Digest, links: DigestLinks): Promise<void> {
  const ref: DigestRef = {
    hash: digest.hash,
    date: digest.date,
    language: digest.language,
  };

  if (digest.entries.length === 0 && !shouldPostNoUpdates(env)) {
    await putDigest(
      env.DIGEST_CACHE,
      ref,
      buildEmptyChannelXml({
        feedTitle: digest.feedTitle,
        language: digest.language,
        links,
      }),
    );
    return;
  }

  await putDigestPage(env.DIGEST_CACHE, ref, {
    feedTitle: digest.feedTitle,
    html: digest.html,
  });
  await putDigest(env.DIGEST_CACHE, ref, buildDigestXml({ digest, links }));
}

async function buildDigest(
  env: Env,
  summarizer: Summarizer,
  ref: DigestRef,
  feedUrl: URL,
): Promise<Digest> {
  const feedResponse = await fetch(feedUrl.toString());
  if (!feedResponse.ok) {
    throw new Error(`Feed responded with ${feedResponse.status}`);
  }

  const feed = parseFeed(await feedResponse.text());
  const feedTitle = feed.title ?? feedUrl.host;
  const selection = selectRecentEntries(feed.items, { maxEntries: maxEntriesOf(env) });

  const html =
    selection.entries.length === 0
      ? renderDigestHtml(noRecentEntriesText(ref.language), [], ref.language)
      : await summarizeOrList(summarizer, selection, feedTitle, ref.language);

  return { ...ref, feedTitle, html, entries: selection.entries };
}
