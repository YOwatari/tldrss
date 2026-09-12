import { DEFAULT_LANGUAGE, type DigestLanguage } from "./language";
import type { DigestPeriod } from "./period";

/**
 * Wording the worker writes itself. Everything here reaches the reader without
 * passing through the model, so it lives apart from the prompt copy.
 */
const TEXT = {
  en: {
    untitledEntry: "(untitled)",
    noRecentEntries: "No new entries were published in the last 24 hours.",
    summaryUnavailable: "A summary could not be generated, so today's entries are listed below.",
  },
  ja: {
    untitledEntry: "(タイトルなし)",
    noRecentEntries: "24 時間以内に公開された新しいエントリはありません。",
    summaryUnavailable: "要約を生成できませんでした。本日のエントリを一覧で掲載します。",
  },
} satisfies Record<DigestLanguage, Record<string, string>>;

/** Heading used when the feed gave an entry no title. */
export function untitledEntryText(language: DigestLanguage = DEFAULT_LANGUAGE): string {
  return TEXT[language].untitledEntry;
}

/** Digest body for a feed with nothing recent enough to summarize. */
export function noRecentEntriesText(language: DigestLanguage = DEFAULT_LANGUAGE, period: DigestPeriod = "daily"): string {
  if (period === "weekly") return language === "ja" ? "対象の週に公開された新しいエントリはありません。" : "No new entries were published in the covered week.";
  return TEXT[language].noRecentEntries;
}

/** Lead paragraph of the digest served when the model could not be reached. */
export function summaryUnavailableText(language: DigestLanguage = DEFAULT_LANGUAGE, period: DigestPeriod = "daily"): string {
  if (period === "weekly") return language === "ja" ? "要約を生成できませんでした。対象の週のエントリを一覧で掲載します。" : "A summary could not be generated, so the week's entries are listed below.";
  return TEXT[language].summaryUnavailable;
}

/**
 * Name of the digest feed itself. Undated: the channel outlives any one day,
 * and only the item title tells the reader which day it covers.
 */
export function channelTitleText(
  feedTitle: string,
  language: DigestLanguage = DEFAULT_LANGUAGE,
  period: DigestPeriod = "daily",
): string {
  if (period === "weekly") return language === "ja" ? `【週刊要約】${feedTitle}` : `Weekly Digest: ${feedTitle}`;
  return language === "ja" ? `【日刊要約】${feedTitle}` : `Daily Digest: ${feedTitle}`;
}

/** `<description>` of the channel: what the feed is, in one line. */
export function channelDescriptionText(
  feedTitle: string,
  language: DigestLanguage = DEFAULT_LANGUAGE,
  period: DigestPeriod = "daily",
): string {
  if (period === "weekly") return language === "ja" ? `${feedTitle} の週刊要約` : `Weekly digest for ${feedTitle}`;
  return language === "ja"
    ? `${feedTitle} の日刊要約`
    : `Daily digest for ${feedTitle}`;
}

/**
 * Title of the digest item, and with it the text Slack posts. It carries the
 * day so that a reader listing several digests can tell them apart.
 */
export function itemTitleText(
  feedTitle: string,
  date: string,
  language: DigestLanguage = DEFAULT_LANGUAGE,
  period: DigestPeriod = "daily",
): string {
  return `${channelTitleText(feedTitle, language, period)} (${date})`;
}
