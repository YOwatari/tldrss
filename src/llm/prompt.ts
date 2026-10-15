import type { DigestLanguage } from "../digest/language";
import type { DigestPeriod } from "../digest/period";
import { untitledEntryText } from "../digest/text";
import type { FeedEntry } from "../feed/parse";
import type { DigestInput } from "./summarizer";

/**
 * Every field of a feed is attacker-controlled, so each one is bounded before
 * it enters the prompt. The limit doubles as the excerpt length: a paragraph is
 * enough for the model to find what the title left out.
 */
export const MAX_EXCERPT_CHARS = 500;

type PromptCopy = {
  system: string;
  intro: (feedTitle: string, period: DigestPeriod) => string;
  /** Formatting rules, one instruction per line. */
  rules: string[];
  note: (included: number, available: number) => string;
};

const COPY: Record<DigestLanguage, PromptCopy> = {
  en: {
    system:
      "You are an editor who writes short, factual daily digests of RSS feeds. " +
      "Answer with the lead only, without preamble.",
    intro: (feedTitle, period) =>
      `Write the lead of a ${period} digest of the following RSS entries from "${feedTitle}".`,
    rules: [
      "Write 2-3 sentences saying what the day was about, as one paragraph of " +
        "plain prose.",
      "Do not summarize the entries one by one: the reader sees every title " +
        "listed under the lead. Use no bullets, entry numbers, headings or markup.",
      "Use only the entries listed below. Never add information they do not " +
        "carry, and never write a url.",
    ],
    note: (included, available) =>
      `Covering the ${included} of ${available} most recent entries.`,
  },
  ja: {
    system:
      "あなたは RSS フィードの日次ダイジェストを簡潔かつ事実に忠実にまとめる編集者です。" +
      "前置きや後書きを付けず、リード文だけを日本語で出力してください。",
    intro: (feedTitle, period) =>
      `次の「${feedTitle}」の RSS エントリから、${period === "weekly" ? "週次" : "日次"}ダイジェストのリード文を書いてください。`,
    rules: [
      "その日の全体像を 2〜3 文でまとめ、1 段落の平文で書いてください。",
      "エントリを 1 件ずつ要約しないでください。読者にはリード文の下に全エントリの" +
        "見出しが表示されます。箇条書き、エントリ番号、見出し、マークアップは使わないでください。",
      "下に挙げたエントリの情報だけを使ってください。書かれていない情報を" +
        "補ったり、URL を書いたりしないでください。",
      "エントリの原文が英語であっても、リード文は日本語で書いてください。",
    ],
    note: (included, available) =>
      `全 ${available} 件のうち、新しい方から ${included} 件を対象とします。`,
  },
};

/** Instruction sent as the system message, ahead of the digest prompt. */
function periodCopy(text: string, period: DigestPeriod = "daily"): string {
  return period === "daily" ? text : text.replaceAll("daily", "weekly").replaceAll("the day", "the week").replaceAll("日次", "週次").replaceAll("その日", "その週");
}

export function systemPromptFor(language: DigestLanguage, period: DigestPeriod = "daily"): string {
  return periodCopy(COPY[language].system, period);
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function entryBlock(entry: FeedEntry, index: number, language: DigestLanguage): string {
  const title = truncate(entry.title ?? untitledEntryText(language), MAX_EXCERPT_CHARS);
  const link = truncate(entry.link ?? "", MAX_EXCERPT_CHARS);
  const excerpt = truncate(entry.contentSnippet ?? entry.content ?? "", MAX_EXCERPT_CHARS);

  return `${index + 1}. ${title}\nURL: ${link}\nExcerpt: ${excerpt}`;
}

/**
 * The user message: the rules, then the entries. Nothing here is trusted
 * output — the renderer takes only the lead's plain text from the answer.
 */
export function buildDigestPrompt(input: DigestInput): string {
  const copy = COPY[input.language];
  const feedTitle = truncate(input.feedTitle, MAX_EXCERPT_CHARS);
  const blocks = input.entries.map((entry, index) => entryBlock(entry, index, input.language));

  const note =
    input.entries.length < input.availableCount
      ? [copy.note(input.entries.length, input.availableCount)]
      : [];

  return [copy.intro(feedTitle, input.period ?? "daily"), ...copy.rules.map(rule => periodCopy(rule, input.period)), ...note, "", ...blocks].join("\n");
}
