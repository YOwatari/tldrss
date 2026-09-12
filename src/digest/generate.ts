/**
 * Generating one digest: fetch the feed, select the day's entries, summarize
 * them, and store the xml and the page a reader lands on.
 *
 * Both paths that produce a digest run this: the background generation a crawl
 * triggers on a cache miss (`handlers/feed.ts`) and the morning cron run
 * (`handlers/cron.ts`). They differ only in what they do with the outcome —
 * one serves a reader either way, the other counts it — so the flow itself
 * lives here rather than in either handler.
 */
import { buildDigestXml, buildEmptyChannelXml } from "./build";
import { renderDigestHtml, renderEntryListHtml } from "./html";
import type { DigestLanguage } from "./language";
import { periodDays, type DigestPeriod } from "./period";
import { noRecentEntriesText } from "./text";
import type { Digest, DigestLinks } from "./types";
import { type Env, maxEntriesOf, shouldPostNoUpdates } from "../env";
import { parseFeed } from "../feed/parse";
import { type EntrySelection, selectRecentEntries } from "../feed/select";
import type { Summarizer } from "../llm/summarizer";
import { getDigest, putDigest } from "../store/digest-cache";
import { putDigestPage } from "../store/digest-page";
import type { DigestRef } from "../store/digest-ref";
import { acquireGenerationLock, releaseGenerationLock } from "../store/generation-lock";

/** What a generation did, for a caller that reports on it. */
export type GenerationOutcome =
  /** The feed was fetched, summarized and stored. */
  | "generated"
  /** The digest was already in KV, so nothing was fetched or summarized. */
  | "cached"
  /** Someone else is generating this digest right now. */
  | "locked";

export type GenerateDigestParams = {
  env: Env;
  summarizer: Summarizer;
  /** Which digest to produce: feed, JST day, language. */
  ref: DigestRef;
  feedUrl: URL;
  links: DigestLinks;
  /**
   * The instant the day's entries are selected against. The cron run passes
   * its scheduled time, so a run that starts late still covers the window its
   * schedule named; a crawl leaves it at the current time.
   */
  now?: Date;
};

/**
 * The reader-facing addresses of the digest `ref` names, under `origin`.
 *
 * Neither carries the feed url: it is user-supplied and may hold a token,
 * while the xml it would end up in is stored in KV and handed to every
 * subscriber. That rules out a `rel="self"` address too; see `channelHead` in
 * `digest/build.ts`.
 */
export function digestLinksOf(origin: string, ref: DigestRef): DigestLinks {
  return {
    siteUrl: `${origin}/`,
    // The language is spelled out even when it is the default one, so the link
    // keeps pointing at this digest if the default ever changes.
    pageUrl: `${origin}/digest/${ref.hash}/${ref.date}?lang=${ref.language}${ref.period === "weekly" ? "&period=weekly" : ""}`,
  };
}

/**
 * Produces the digest `ref` names, unless it exists already or someone else is
 * producing it.
 *
 * The existing digest is what makes a second run cheap: a cron run re-executed
 * by hand, or a crawl arriving while the morning run is still working, must not
 * pay for the same model call twice.
 *
 * Build and storage failures are raised rather than logged: what a failed
 * digest means differs per caller, and both of them have somewhere to put it.
 */
export async function generateDigest(params: GenerateDigestParams): Promise<GenerationOutcome> {
  const { env, summarizer, ref, feedUrl, links, now } = params;

  if ((await getDigest(env.DIGEST_CACHE, ref)) !== null) return "cached";

  const lockToken = await acquireGenerationLock(env.DIGEST_CACHE, ref);
  if (!lockToken) return "locked";

  try {
    const digest = await buildDigest(env, summarizer, ref, feedUrl, now);
    await storeDigest(env, digest, links);
  } finally {
    try {
      await releaseGenerationLock(env.DIGEST_CACHE, ref, lockToken);
    } catch (error) {
      const kind = error instanceof Error ? error.name : typeof error;
      console.error(`Failed to release generation lock for ${ref.hash} (${kind})`);
    }
  }

  return "generated";
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
  period: DigestPeriod = "daily",
): Promise<string> {
  try {
    const summary = await summarizer.summarize({
      feedTitle,
      entries: selection.entries,
      availableCount: selection.availableCount,
      language,
      period,
    });

    // Reference markers are numbered against the list the prompt used.
    const html = renderDigestHtml(summary, selection.entries, language);
    // An answer can be non-blank and still leave nothing behind — markup the
    // sanitizer drops whole, say. An empty body is worse for a reader than the
    // entry list, so it is treated as a failure to summarize.
    if (html.trim() === "") throw new Error("Digest body was empty after rendering");

    return html;
  } catch (error) {
    // Keep the provider error for operational triage. The summarizer receives
    // feed content, but provider errors do not contain the original prompt.
    console.error(`Failed to summarize ${selection.entries.length} entries`, error);

    return renderEntryListHtml(selection.entries, language, period);
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
    period: digest.period,
  };

  if (digest.entries.length === 0 && !shouldPostNoUpdates(env)) {
    await putDigest(
      env.DIGEST_CACHE,
      ref,
      buildEmptyChannelXml({
        feedTitle: digest.feedTitle,
        language: digest.language,
        period: digest.period,
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
  now: Date | undefined,
): Promise<Digest> {
  const feedResponse = await fetch(feedUrl.toString());
  if (!feedResponse.ok) {
    throw new Error(`Feed responded with ${feedResponse.status}`);
  }

  const feed = parseFeed(await feedResponse.text());
  const feedTitle = feed.title ?? feedUrl.host;
  const selection = selectRecentEntries(feed.items, {
    now: ref.period === "weekly" ? new Date(`${ref.date}T00:00:00+09:00`) : now,
    maxEntries: maxEntriesOf(env),
    windowMs: periodDays(ref.period) * 86_400_000,
    exclusiveEnd: ref.period === "weekly",
  });

  const html =
    selection.entries.length === 0
      ? renderDigestHtml(noRecentEntriesText(ref.language, ref.period), [], ref.language)
      : await summarizeOrList(summarizer, selection, feedTitle, ref.language, ref.period);

  return { ...ref, feedTitle, html, entries: selection.entries };
}
