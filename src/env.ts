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
