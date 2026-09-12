/**
 * The morning run that pre-generates the day's digests.
 *
 * Feed readers time out long before a digest can be built, so the schedule is
 * what makes the 09:00 crawl cheap: by the time Slack arrives, every
 * subscribed feed already has its xml in KV. Generation from a crawl
 * (`handlers/feed.ts`) stays as the fallback for a feed this run missed.
 */
import { digestLinksOf, generateDigest, type GenerationOutcome } from "../digest/generate";
import { DEFAULT_LANGUAGE } from "../digest/language";
import { type Env, publicOriginOf } from "../env";
import type { Summarizer } from "../llm/summarizer";
import type { DigestRef } from "../store/digest-ref";
import { putCronStatus, type CronRunSummary } from "../store/cron-status";
import { getSubscription, listSubscriptions, remove, SUBSCRIPTION_TTL_SECONDS, type SubscriptionEntry } from "../store/subscriptions";
import { jstDate } from "../time";

/**
 * How many feeds are generated at once.
 *
 * Each one holds a model call, and a `scheduled` invocation has the same CPU
 * and subrequest budget as a request: a whole subscription list at once would
 * spend it on whichever feeds happen to answer first. Five keeps the run well
 * inside the budget while finishing a realistic list in a couple of rounds.
 */
export const CRON_CONCURRENCY = 5;

/**
 * What the runtime hands `scheduled`, narrowed to what this run reads. Keeping
 * it structural lets a test name a time and a schedule without building a
 * `ScheduledController`.
 */
export type CronTrigger = {
  /** Epoch ms the run was scheduled for, not when it actually started. */
  scheduledTime: number;
  /** The cron expression that fired, as configured in `wrangler.toml`. */
  cron: string;
};

export type { CronRunSummary } from "../store/cron-status";

/**
 * Generates today's digest for every subscription.
 *
 * The scheduled time, not the current one, is the base: a run the platform
 * starts late still covers the window its schedule named, and dates the digest
 * by the JST day that window ends on — 23:50 UTC is already tomorrow in Tokyo.
 *
 * Only `DEFAULT_LANGUAGE` is pre-generated. A subscription is keyed by feed
 * url alone, so nothing here says which language a reader crawls in, and
 * generating every language would multiply the model cost of the run by the
 * number of them. A crawl in another language still gets its digest built in
 * the background, one day behind on the first morning.
 */
export async function handleScheduled(
  trigger: CronTrigger,
  env: Env,
  summarizer: Summarizer,
): Promise<CronRunSummary> {
  const startedAt = Date.now();
  const scheduledAt = new Date(trigger.scheduledTime);
  const date = jstDate(scheduledAt);

  const tally = { generated: 0, skipped: 0, failed: 0 };

  const origin = publicOriginOf(env);
  if (!origin) {
    // Without it every link in the digest would point at nowhere, and the
    // digest is cached for two days: a run that cannot build them does nothing.
    console.error("Skipped the scheduled run: PUBLIC_ORIGIN is unset or not an http url");

    return recordRun(env, trigger, { date, total: 0, ...tally, error: "invalid_public_origin", durationMs: Date.now() - startedAt });
  }

  // TTL handles new records; legacy records without expiration also need
  // lastSeenAt-based cleanup. Use the scheduled instant consistently.
  let subscriptions: SubscriptionEntry[];
  try {
    subscriptions = await listSubscriptions(env.DIGEST_CACHE);
  } catch (error) {
    await recordRun(env, trigger, { date, total: 0, ...tally, error: "subscription_read_failed", durationMs: Date.now() - startedAt });
    throw error;
  }

  await forEachConcurrently(subscriptions, CRON_CONCURRENCY, async (subscription) => {
    // Nothing may escape: one feed's failure — an unreachable origin, a KV
    // write, an unparseable stored url — must not cost the rest of the list
    // its digest.
    try {
      if (isStale(subscription, scheduledAt)) {
        // A crawl may have refreshed the record since listing. KV has no
        // atomic conditional delete, but re-reading narrows that race.
        const latest = await getSubscription(env.DIGEST_CACHE, subscription.hash);
        if (!latest || isStale(latest, scheduledAt)) {
          if (latest) await remove(env.DIGEST_CACHE, subscription.hash);
          tally.skipped += 1;
          return;
        }
        subscription = { ...latest, hash: subscription.hash };
      }
      const outcome = await generateFor(env, summarizer, subscription, {
        date,
        origin,
        now: scheduledAt,
      });

      if (outcome === "generated") tally.generated += 1;
      else tally.skipped += 1;
    } catch (error) {
      tally.failed += 1;
      // The feed url may carry a token, so the feed is named by its hash: it
      // is what the digest keys use anyway.
      const kind = error instanceof Error ? error.name : typeof error;
      console.error(`Failed to generate digest for ${subscription.hash} (${kind})`);
    }
  });

  return recordRun(env, trigger, {
    date,
    total: subscriptions.length,
    ...tally,
    durationMs: Date.now() - startedAt,
  });
}

function isStale(subscription: { lastSeenAt: string }, now: Date): boolean {
  return now.getTime() - Date.parse(subscription.lastSeenAt) >= SUBSCRIPTION_TTL_SECONDS * 1000;
}

function generateFor(
  env: Env,
  summarizer: Summarizer,
  subscription: SubscriptionEntry,
  run: { date: string; origin: string; now: Date },
): Promise<GenerationOutcome> {
  const ref: DigestRef = {
    hash: subscription.hash,
    date: run.date,
    language: DEFAULT_LANGUAGE,
  };

  return generateDigest({
    env,
    summarizer,
    ref,
    feedUrl: new URL(subscription.url),
    links: digestLinksOf(run.origin, ref),
    now: run.now,
  });
}

/**
 * Runs `task` for every item, `limit` of them at a time.
 *
 * The workers share one cursor rather than taking a slice each, so a slow feed
 * delays only itself: whoever finishes first picks up the next item.
 */
async function forEachConcurrently<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      await task(items[next++]);
    }
  });

  // `task` handles its own failures, but a rejection here would abandon the
  // items the other workers have not reached yet.
  await Promise.allSettled(workers);
}

/**
 * Logs the run as one JSON line, so Workers Logs can filter and aggregate it,
 * and hands the summary back for a caller to assert on.
 */
async function recordRun(env: Env, trigger: CronTrigger, summary: CronRunSummary): Promise<CronRunSummary> {
  console.log(JSON.stringify({ event: "cron.digest", cron: trigger.cron, ...summary }));
  try {
    await putCronStatus(env.DIGEST_CACHE, { scheduledTime: trigger.scheduledTime, completedAt: Date.now(), summary });
  } catch (error) {
    console.error("Failed to persist Cron health status");
    throw error;
  }
  return summary;
}
