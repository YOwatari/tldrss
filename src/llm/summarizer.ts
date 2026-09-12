import type { DigestLanguage } from "../digest/language";
import type { DigestPeriod } from "../digest/period";
import type { FeedEntry } from "../feed/parse";

export type DigestInput = {
  feedTitle: string;
  /**
   * The entries to summarize, newest first; see `selectRecentEntries`. The
   * prompt numbers them by position, and reference links resolve those numbers
   * against this same list, so the order is part of the contract.
   */
  entries: FeedEntry[];
  /**
   * Dated entries the selected window held before the cap applied, so the
   * prompt can say when the model is seeing a subset. Never below
   * `entries.length`.
   */
  availableCount: number;
  language: DigestLanguage;
  period?: DigestPeriod;
};

/**
 * The whole of what the digest pipeline knows about an LLM: entries in, digest
 * text out. Keeping it this narrow is what lets the provider be swapped, and
 * lets tests summarize without a model.
 *
 * An implementation either returns usable text or throws; it never returns a
 * placeholder. The caller decides what a reader sees when summarizing fails.
 */
export interface Summarizer {
  summarize(input: DigestInput): Promise<string>;
}
