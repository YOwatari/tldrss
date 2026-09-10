import { DEFAULT_MAX_ENTRIES } from "./feed/select";

export type Env = {
  DIGEST_CACHE: KVNamespace;
  AI: Ai;
  ALLOWED_FEED_HOSTS?: string;
  FEED_TOKEN?: string;
  MAX_SUBSCRIPTIONS?: string | number;
  /** Workers AI model id; falls back to DEFAULT_AI_MODEL when unset. */
  AI_MODEL?: string;
  /**
   * Entries per digest. `wrangler.toml` vars arrive as strings, but a numeric
   * literal in the config would arrive as a number, so both are accepted.
   */
  MAX_ENTRIES?: string | number;
  /**
   * Whether a day with no new entries still gets a digest saying so. Off by
   * default: Slack posts one message per item, and a subscriber does not need
   * a daily reminder that a quiet feed was quiet.
   */
  POST_NO_UPDATES?: string | number | boolean;
  /**
   * The address readers reach this worker at, e.g. `https://tldrss.example`.
   *
   * A request carries its own origin, so only the cron run needs this: it has
   * no request to read one off, and every link in the digest it stores has to
   * be absolute. The workers.dev hostname is not available to the runtime,
   * hence a var rather than a default.
   */
  PUBLIC_ORIGIN?: string;
};

/**
 * Upper bound on `MAX_ENTRIES`. The prompt has to stay inside the model's
 * context window, so a mistyped var is clamped rather than honoured.
 */
export const MAX_ENTRIES_CEILING = 100;

/**
 * The configured entry cap, or `DEFAULT_MAX_ENTRIES`.
 *
 * A value that is not a positive integer is treated as absent: a broken var
 * should degrade to the default rather than take the digest down.
 */
export function maxEntriesOf(env: Env): number {
  const configured = Number(env.MAX_ENTRIES);
  if (!Number.isInteger(configured) || configured < 1) return DEFAULT_MAX_ENTRIES;

  return Math.min(configured, MAX_ENTRIES_CEILING);
}

/** Spellings that turn a boolean var on. Anything else leaves it off. */
const TRUTHY_VALUES = new Set(["true", "1"]);

/**
 * Whether to publish an item on a day the feed published nothing.
 *
 * An unreadable value is treated as off rather than as an error: a mistyped
 * var should not start posting messages nobody asked for.
 */
export function shouldPostNoUpdates(env: Env): boolean {
  return TRUTHY_VALUES.has(String(env.POST_NO_UPDATES).toLowerCase());
}

/**
 * The configured public origin, or null when it is unset or unusable.
 *
 * Null rather than a guess: a digest built on a wrong origin would carry links
 * to nowhere, and it is cached for two days. The caller decides what to do
 * with the absence — see `handlers/cron.ts`, which reports it and stops.
 */
export function publicOriginOf(env: Env): string | null {
  if (!env.PUBLIC_ORIGIN) return null;

  let url: URL;
  try {
    url = new URL(env.PUBLIC_ORIGIN);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  // `origin` alone, so a path or query someone left in the var cannot end up
  // in front of the digest path the links are built from.
  return url.origin;
}


export function maxSubscriptionsOf(env: Env): number {
  const value = Number(env.MAX_SUBSCRIPTIONS);
  return Number.isSafeInteger(value) && value > 0 ? value : 20;
}

/** Exact hostnames, with all configured restrictions required. Fail closed. */
export function isFeedAllowed(env: Env, feed: URL, token: string | null): boolean {
  const hosts = (env.ALLOWED_FEED_HOSTS ?? "").split(",").map(host => host.trim().toLowerCase()).filter(Boolean);
  if (!hosts.length && !env.FEED_TOKEN) return false;
  if (hosts.length && !hosts.includes(feed.hostname.toLowerCase())) return false;
  return !env.FEED_TOKEN || token === env.FEED_TOKEN;
}
