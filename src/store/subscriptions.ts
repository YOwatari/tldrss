/**
 * The feeds the cron run pre-generates a digest for.
 *
 * One key per feed rather than one list under a single key: several feeds are
 * crawled at once, and a read-modify-write of a shared list would drop the
 * subscriptions written between one crawl's read and its write. Separate keys
 * cannot race each other, at the price of one read per feed when listing.
 */

/** Namespace of the subscription keys inside `DIGEST_CACHE`. */
export const SUBSCRIPTION_PREFIX = "sub:";

/** How many keys one `KV.list` call asks for. */
const DEFAULT_PAGE_SIZE = 100;

export type Subscription = {
  /** The normalized feed url, as `handlers/feed.ts` spells it. */
  url: string;
  /** ISO instant the feed was first crawled. */
  registeredAt: string;
  /**
   * ISO instant of the most recent crawl. A subscription nobody crawls any
   * more goes stale here, which is what lets it be dropped later.
   */
  lastSeenAt: string;
};

/** A stored subscription together with the feed hash it is keyed by. */
export type SubscriptionEntry = Subscription & {
  /** `sha256Hex` of `url`; the digest of this feed is keyed by it too. */
  hash: string;
};

export function subscriptionKey(hash: string): string {
  return `${SUBSCRIPTION_PREFIX}${hash}`;
}

/** Whether a value read back from KV is a record this module wrote. */
function isSubscription(value: unknown): value is Subscription {
  if (typeof value !== "object" || value === null) return false;

  const record = value as Record<string, unknown>;
  return (
    typeof record.url === "string" &&
    typeof record.registeredAt === "string" &&
    typeof record.lastSeenAt === "string"
  );
}

function parseSubscription(stored: string): Subscription | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return null;
  }

  return isSubscription(parsed) ? parsed : null;
}

export async function putSubscription(
  cache: KVNamespace,
  hash: string,
  subscription: Subscription,
): Promise<void> {
  await cache.put(subscriptionKey(hash), JSON.stringify(subscription));
}

/**
 * Every registered subscription, in whatever order KV lists them.
 *
 * A record that does not parse, or that is not this shape, is left out rather
 * than raised: it can only come from an older shape of the record, and one
 * unreadable subscription must not cost every other feed its digest.
 */
export async function listSubscriptions(
  cache: KVNamespace,
  options: { pageSize?: number } = {},
): Promise<SubscriptionEntry[]> {
  const entries: SubscriptionEntry[] = [];
  let cursor: string | undefined;

  // KV lists at most one page per call, so the cursor is followed to the end:
  // a subscription past the first page is still one the cron run owes a digest.
  do {
    const page = await cache.list({
      prefix: SUBSCRIPTION_PREFIX,
      limit: options.pageSize ?? DEFAULT_PAGE_SIZE,
      cursor,
    });

    for (const key of page.keys) {
      const stored = await cache.get(key.name);
      if (stored === null) continue;

      const subscription = parseSubscription(stored);
      if (!subscription) continue;

      entries.push({ hash: key.name.slice(SUBSCRIPTION_PREFIX.length), ...subscription });
    }

    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return entries;
}
