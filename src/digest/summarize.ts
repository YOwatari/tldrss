import type { FeedEntry } from "../feed/parse";

/** Workers AI text-generation model used unless `AI_MODEL` overrides it. */
export const DEFAULT_AI_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct" satisfies keyof AiModels;

/** Output languages the digest can be written in. */
export type DigestLanguage = "en" | "ja";

export const DEFAULT_LANGUAGE: DigestLanguage = "en";

const MAX_TOKENS = 1024;

/**
 * The prompt has to stay well inside the model's context window, so both the
 * number of entries and the length of each excerpt are bounded.
 */
export const MAX_PROMPT_ENTRIES = 30;
export const MAX_EXCERPT_CHARS = 400;

/** Upper bound suggested to the model for a single bullet, in characters. */
export const MAX_BULLET_CHARS = 80;

type PromptCopy = {
  system: string;
  intro: (feedTitle: string) => string;
  /** Formatting rules, one instruction per line. */
  rules: string[];
  note: (included: number, total: number) => string;
  /** Shown when the model answers with nothing usable. */
  noSummary: string;
  /** Shown when the feed published nothing worth summarizing. */
  noRecentEntries: string;
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
    ],
    note: (included, total) => `Summarizing the ${included} of ${total} most recent entries.`,
    noSummary: "No summary generated.",
    noRecentEntries: "No new entries were published in the last 24 hours.",
  },
  ja: {
    system:
      "あなたは RSS フィードの日次ダイジェストを簡潔かつ事実に忠実にまとめる編集者です。" +
      "前置きや後書きを付けず、ダイジェスト本文だけを日本語で出力してください。",
    intro: (feedTitle) => `次の「${feedTitle}」の RSS エントリから、日次ダイジェストを作成してください。`,
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
      "エントリの原文が英語であっても、ダイジェストは日本語で書いてください。",
    ],
    note: (included, total) =>
      `全 ${total} 件のうち、新しい方から ${included} 件を対象とします。`,
    noSummary: "要約を生成できませんでした。",
    noRecentEntries: "24 時間以内に公開された新しいエントリはありません。",
  },
};

/** Digest body for a feed with nothing recent enough to summarize. */
export function noRecentEntriesText(language: DigestLanguage = DEFAULT_LANGUAGE): string {
  return COPY[language].noRecentEntries;
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function publishedAt(entry: FeedEntry): number {
  const timestamp = Date.parse(entry.isoDate ?? entry.pubDate ?? "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

/**
 * The entries the prompt will number, newest first. Reference links resolve a
 * marker by position in this list, so both sides have to derive it the same way.
 */
export function selectPromptEntries(entries: FeedEntry[]): FeedEntry[] {
  // Feeds are not required to be newest-first, so order before capping.
  return [...entries]
    .sort((left, right) => publishedAt(right) - publishedAt(left))
    .slice(0, MAX_PROMPT_ENTRIES);
}

export function buildDigestPrompt(
  rawFeedTitle: string,
  entries: FeedEntry[],
  language: DigestLanguage = DEFAULT_LANGUAGE,
): string {
  const copy = COPY[language];
  // Every field below is feed-controlled, so all of them are bounded.
  const feedTitle = truncate(rawFeedTitle, MAX_EXCERPT_CHARS);
  const included = selectPromptEntries(entries);
  const lines = included.map((entry, index) => {
    const title = truncate(entry.title ?? "(untitled)", MAX_EXCERPT_CHARS);
    const link = truncate(entry.link ?? "", MAX_EXCERPT_CHARS);
    const snippet = truncate(entry.contentSnippet ?? entry.content ?? "", MAX_EXCERPT_CHARS);
    return `${index + 1}. ${title}\nURL: ${link}\nExcerpt: ${snippet}`;
  });

  const note =
    included.length < entries.length ? [copy.note(included.length, entries.length)] : [];

  return [copy.intro(feedTitle), ...copy.rules, ...note, "", ...lines].join("\n");
}

function extractResponseText(result: unknown): string {
  if (typeof result === "object" && result !== null && "response" in result) {
    const { response } = result as { response?: unknown };
    if (typeof response === "string") return response.trim();
  }

  throw new Error(`Unexpected Workers AI response: ${JSON.stringify(result)}`);
}

export async function summarizeEntries(params: {
  ai: Ai;
  model?: string;
  feedTitle: string;
  entries: FeedEntry[];
  language?: DigestLanguage;
}): Promise<string> {
  const language = params.language ?? DEFAULT_LANGUAGE;
  const model = (params.model ?? DEFAULT_AI_MODEL) as keyof AiModels;
  const result = await params.ai.run(model, {
    messages: [
      { role: "system", content: COPY[language].system },
      { role: "user", content: buildDigestPrompt(params.feedTitle, params.entries, language) },
    ],
    max_tokens: MAX_TOKENS,
  });

  return extractResponseText(result) || COPY[language].noSummary;
}
