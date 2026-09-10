import { DEFAULT_LANGUAGE, type DigestLanguage } from "./language";

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
export function noRecentEntriesText(language: DigestLanguage = DEFAULT_LANGUAGE): string {
  return TEXT[language].noRecentEntries;
}

/** Lead paragraph of the digest served when the model could not be reached. */
export function summaryUnavailableText(language: DigestLanguage = DEFAULT_LANGUAGE): string {
  return TEXT[language].summaryUnavailable;
}
