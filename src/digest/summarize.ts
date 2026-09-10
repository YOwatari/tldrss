import type { FeedEntry } from "../feed/parse";

/** Workers AI text-generation model used unless `AI_MODEL` overrides it. */
export const DEFAULT_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast" satisfies keyof AiModels;

const SYSTEM_PROMPT =
  "You are an editor who writes short, factual daily digests of RSS feeds. " +
  "Answer with the digest only, without preamble.";

const MAX_TOKENS = 1024;

/**
 * The prompt has to stay well inside the model's context window, so both the
 * number of entries and the length of each excerpt are bounded.
 */
export const MAX_PROMPT_ENTRIES = 30;
export const MAX_EXCERPT_CHARS = 400;

export const NO_SUMMARY_FALLBACK = "No summary generated.";

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function publishedAt(entry: FeedEntry): number {
  const timestamp = Date.parse(entry.isoDate ?? entry.pubDate ?? "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function buildDigestPrompt(feedTitle: string, entries: FeedEntry[]): string {
  // Feeds are not required to be newest-first, so order before capping.
  const included = [...entries]
    .sort((left, right) => publishedAt(right) - publishedAt(left))
    .slice(0, MAX_PROMPT_ENTRIES);
  const lines = included.map((entry, index) => {
    const title = truncate(entry.title ?? "(untitled)", MAX_EXCERPT_CHARS);
    const link = entry.link ?? "";
    const snippet = truncate(entry.contentSnippet ?? entry.content ?? "", MAX_EXCERPT_CHARS);
    return `${index + 1}. ${title}\nURL: ${link}\nExcerpt: ${snippet}`;
  });

  const note =
    included.length < entries.length
      ? [`Summarizing the ${included.length} of ${entries.length} most recent entries.`]
      : [];

  return [
    `Create a concise daily digest of the following RSS entries from "${feedTitle}".`,
    "Keep it brief (4-8 bullet points), factual, and easy to scan.",
    ...note,
    "",
    ...lines,
  ].join("\n");
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
}): Promise<string> {
  const model = (params.model ?? DEFAULT_AI_MODEL) as keyof AiModels;
  const result = await params.ai.run(model, {
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildDigestPrompt(params.feedTitle, params.entries) },
    ],
    max_tokens: MAX_TOKENS,
  });

  return extractResponseText(result) || NO_SUMMARY_FALLBACK;
}
