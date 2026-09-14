import { DEFAULT_MAX_ENTRIES } from "./feed/select";
import { isFeedRequestAuthorized } from "./feed/policy";

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
  /** Maximum time spent fetching one upstream feed, including its body. */
  FEED_TIMEOUT_MS?: string | number;
  /** Maximum received body bytes accepted from one upstream feed. */
  MAX_FEED_BYTES?: string | number;
  /** End-to-end budget for one digest generation. */
  GENERATION_TIMEOUT_MS?: string | number;
};

export const DEFAULT_FEED_TIMEOUT_MS = 5_000;
export const DEFAULT_MAX_FEED_BYTES = 1_000_000;
export const DEFAULT_GENERATION_TIMEOUT_MS = 25_000;
/** Keep the generation deadline inside the 30-second HTTP waitUntil window. */
export const GENERATION_TIMEOUT_MS_CEILING = 25_000;

function positiveInteger(value: string | number | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function feedTimeoutMsOf(env: Env): number {
  return positiveInteger(env.FEED_TIMEOUT_MS, DEFAULT_FEED_TIMEOUT_MS);
}

export function maxFeedBytesOf(env: Env): number {
  return positiveInteger(env.MAX_FEED_BYTES, DEFAULT_MAX_FEED_BYTES);
}

export function generationTimeoutMsOf(env: Env): number {
  return Math.min(
    positiveInteger(env.GENERATION_TIMEOUT_MS, DEFAULT_GENERATION_TIMEOUT_MS),
    GENERATION_TIMEOUT_MS_CEILING,
  );
}

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

/** @deprecated Kept for callers of the old combined auth/policy helper. */
export function isFeedAllowed(env: Env, feed: URL, token: string | null): boolean {
  return isFeedRequestAuthorized(env, feed, token);
}
