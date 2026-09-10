import { DEFAULT_MAX_ENTRIES } from "./feed/select";

export type Env = {
  DIGEST_CACHE: KVNamespace;
  AI: Ai;
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
