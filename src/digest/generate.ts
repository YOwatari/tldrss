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
import { feedTimeoutMsOf, generationTimeoutMsOf, maxEntriesOf, maxFeedBytesOf, type Env, shouldPostNoUpdates } from "../env";
import { fetchFeed } from "../feed/fetch";
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
  const deadlineAt = Date.now() + generationTimeoutMsOf(env);

  if ((await withinDeadline(getDigest(env.DIGEST_CACHE, ref), deadlineAt, "digest lookup")) !== null) return "cached";

  const lockPromise = acquireGenerationLock(env.DIGEST_CACHE, ref);
  let lockToken: string | null;
  try {
    lockToken = await withinDeadline(lockPromise, deadlineAt, "generation lock");
  } catch (error) {
    // The KV operation itself cannot be cancelled. If it acquires the lock
    // after our deadline, release that late token so it cannot strand a feed.
    void lockPromise.then((lateToken) => {
      if (lateToken) return releaseGenerationLock(env.DIGEST_CACHE, ref, lateToken);
    }).catch(() => undefined);
    throw error;
  }
  if (!lockToken) return "locked";

  const storage = { late: false, pending: [] as Promise<unknown>[] };
  try {
    const digest = await buildDigest(env, summarizer, ref, feedUrl, now, deadlineAt);
    if (Date.now() >= deadlineAt) throw new Error("Digest generation deadline exceeded before storage");
    await storeDigest(env, digest, links, deadlineAt, storage);
  } finally {
    let releasePromise: Promise<void> | undefined;
    const release = () => {
      releasePromise ??= releaseGenerationLock(env.DIGEST_CACHE, ref, lockToken);
      return releasePromise;
    };
    const cleanup = async () => {
      // A timed-out write may still publish. Keep the lock until it settles so
      // a newer generation cannot race it and leave page/XML from different
      // generations in KV.
      if (storage.late) await Promise.allSettled(storage.pending);
      await release();
    };

    if (storage.late || Date.now() >= deadlineAt) {
      // Cleanup must not extend the generation deadline. The lock module keeps
      // its in-isolate guard until the pending KV operation and release finish.
      void cleanup().catch((error) => logReleaseFailure(ref, error));
    } else {
      try {
        await withinDeadline(cleanup(), deadlineAt, "lock cleanup");
      } catch (error) {
        void releasePromise?.catch((releaseError) => logReleaseFailure(ref, releaseError));
        if (!releasePromise) logReleaseFailure(ref, error);
      }
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
  deadlineAt: number,
): Promise<string> {
  try {
    const summary = await withinDeadline(summarizer.summarize({
      feedTitle,
      entries: selection.entries,
      availableCount: selection.availableCount,
      language,
      period,
    }, { deadlineAt }), deadlineAt, "summarization");

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
async function storeDigest(
  env: Env,
  digest: Digest,
  links: DigestLinks,
  deadlineAt: number,
  storage: { late: boolean; pending: Promise<unknown>[] },
): Promise<void> {
  const ref: DigestRef = {
    hash: digest.hash,
    date: digest.date,
    language: digest.language,
    period: digest.period,
  };

  if (digest.entries.length === 0 && !shouldPostNoUpdates(env)) {
    if (Date.now() >= deadlineAt) throw new Error("Digest generation deadline exceeded before storage");
    await writeWithDeadline(putDigest(
      env.DIGEST_CACHE,
      ref,
      buildEmptyChannelXml({
        feedTitle: digest.feedTitle,
        language: digest.language,
        period: digest.period,
        links,
      }),
    ), deadlineAt, "empty digest storage", storage);
    if (Date.now() >= deadlineAt) throw new Error("Digest generation deadline exceeded after storage");
    return;
  }

  if (Date.now() >= deadlineAt) throw new Error("Digest generation deadline exceeded before storage");
  await writeWithDeadline(putDigestPage(env.DIGEST_CACHE, ref, {
    feedTitle: digest.feedTitle,
    html: digest.html,
  }), deadlineAt, "digest page storage", storage);
  if (Date.now() >= deadlineAt) throw new Error("Digest generation deadline exceeded before storage");
  await writeWithDeadline(putDigest(env.DIGEST_CACHE, ref, buildDigestXml({ digest, links })), deadlineAt, "digest storage", storage);
  if (Date.now() >= deadlineAt) throw new Error("Digest generation deadline exceeded after storage");
}

async function writeWithDeadline<T>(
  work: Promise<T>,
  deadlineAt: number,
  stage: string,
  storage: { late: boolean; pending: Promise<unknown>[] },
): Promise<T> {
  const settled = work.then(() => undefined, () => undefined);
  storage.pending.push(settled);
  try {
    return await withinDeadline(work, deadlineAt, stage);
  } catch (error) {
    storage.late = Date.now() >= deadlineAt || (error instanceof Error && error.message.includes("deadline"));
    throw error;
  }
}

function logReleaseFailure(ref: DigestRef, error: unknown): void {
  const kind = error instanceof Error ? error.name : typeof error;
  console.error(`Failed to release generation lock for ${ref.hash} (${kind})`);
}

/**
 * KV has no abort signal. Stop waiting at the generation deadline while the
 * underlying operation finishes in the background; callers must treat a late
 * successful write as untrusted and check the deadline after it.
 */
async function withinDeadline<T>(work: Promise<T>, deadlineAt: number, stage: string): Promise<T> {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new Error(`Digest generation deadline exceeded during ${stage}`);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Digest generation deadline exceeded during ${stage}`)), remaining);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function buildDigest(
  env: Env,
  summarizer: Summarizer,
  ref: DigestRef,
  feedUrl: URL,
  now: Date | undefined,
  deadlineAt: number,
): Promise<Digest> {
  const feed = parseFeed(await fetchFeed(feedUrl, {
    timeoutMs: feedTimeoutMsOf(env),
    maxBytes: maxFeedBytesOf(env),
    deadlineAt,
  }));
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
      : await summarizeOrList(summarizer, selection, feedTitle, ref.language, ref.period, deadlineAt);

  return { ...ref, feedTitle, html, entries: selection.entries };
}
