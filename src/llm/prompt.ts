import type { DigestLanguage } from "../digest/language";
import { untitledEntryText } from "../digest/text";
import type { FeedEntry } from "../feed/parse";
import type { DigestInput } from "./summarizer";

/**
 * Every field of a feed is attacker-controlled, so each one is bounded before
 * it enters the prompt. The limit doubles as the excerpt length: a paragraph is
 * enough for the model to find what the title left out.
 */
export const MAX_EXCERPT_CHARS = 500;

/** Upper bound suggested to the model for a single bullet, in characters. */
export const MAX_BULLET_CHARS = 80;

type PromptCopy = {
  system: string;
  intro: (feedTitle: string) => string;
  /** Formatting rules, one instruction per line. */
  rules: string[];
  note: (included: number, available: number) => string;
};

const COPY: Record<DigestLanguage, PromptCopy> = {
  en: {
    system:
      "You are an editor who writes short, factual daily digests of RSS feeds. " +
      "Answer with the digest only, without preamble.",
    intro: (feedTitle) =>
      `Create a concise daily digest of the following RSS entries from "${feedTitle}".`,
    rules: [
      "Open with a 2-3 sentence lead saying what the day was about, on its own " +
        "line and without any number.",
      "Then write one bullet per entry: the 4-8 most notable ones, or every " +
        "entry listed when fewer than four are available. Never cover the same " +
        "entry twice.",
      "Write one line per bullet: the entry number in square brackets, then the " +
        'summary, e.g. "[3] Adds a Rust query and covers Kotlin frameworks." ' +
        "Use only the numbers listed below.",
      "The reader already sees each title, so a bullet must add what the title " +
        "leaves out — numbers, scope, or conditions taken from the excerpt. " +
        "Never restate the title.",
      `Keep each bullet under ${MAX_BULLET_CHARS} characters, factual and easy to scan.`,
      "Use only the entries listed below. Never add information they do not " +
        "carry, and never write a url of your own.",
    ],
    note: (included, available) =>
      `Summarizing the ${included} of ${available} most recent entries.`,
  },
  ja: {
    system:
      "あなたは RSS フィードの日次ダイジェストを簡潔かつ事実に忠実にまとめる編集者です。" +
      "前置きや後書きを付けず、ダイジェスト本文だけを日本語で出力してください。",
    intro: (feedTitle) =>
      `次の「${feedTitle}」の RSS エントリから、日次ダイジェストを作成してください。`,
    rules: [
      "最初に、その日の全体像を 2〜3 文でまとめたリード文を書いてください。" +
        "リード文は独立した行に書き、番号を付けないでください。",
      "続けて、エントリ 1 件につき 1 項目を書いてください。重要なものを 4〜8 件" +
        "選び、エントリが 4 件未満のときは挙がっているものをすべて扱ってください。" +
        "同じエントリを二度扱わないでください。",
      "各項目は 1 行で、エントリ番号を角かっこで囲んだあとに要約を続けてください。" +
        "例:「[3] Rust のクエリが追加され、Kotlin のフレームワークも対象になった。」。" +
        "番号は下のリストのものだけを使ってください。",
      "読者には見出しがそのまま表示されるので、各項目には見出しにない情報" +
        "（数値・対象範囲・条件など）を本文から必ず 1 つ入れてください。" +
        "見出しの言い換えにしないでください。",
      `各項目は ${MAX_BULLET_CHARS} 字以内で、事実に忠実に、ひと目で読める分量にしてください。`,
      "下に挙げたエントリの情報だけを使ってください。書かれていない情報を" +
        "補ったり、URL を自分で書いたりしないでください。",
      "エントリの原文が英語であっても、ダイジェストは日本語で書いてください。",
    ],
    note: (included, available) =>
      `全 ${available} 件のうち、新しい方から ${included} 件を対象とします。`,
  },
};

/** Instruction sent as the system message, ahead of the digest prompt. */
export function systemPromptFor(language: DigestLanguage): string {
  return COPY[language].system;
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
 * The user message: the rules, then the entries numbered as the digest has to
 * cite them. Nothing here is trusted output — the numbering is the only thing
 * the renderer takes from the model's answer.
 */
export function buildDigestPrompt(input: DigestInput): string {
  const copy = COPY[input.language];
  const feedTitle = truncate(input.feedTitle, MAX_EXCERPT_CHARS);
  const blocks = input.entries.map((entry, index) => entryBlock(entry, index, input.language));

  const note =
    input.entries.length < input.availableCount
      ? [copy.note(input.entries.length, input.availableCount)]
      : [];

  return [copy.intro(feedTitle), ...copy.rules, ...note, "", ...blocks].join("\n");
}
