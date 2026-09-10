import type { FeedEntry } from "../feed/parse";

/** Workers AI text-generation model used unless `AI_MODEL` overrides it. */
export const DEFAULT_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast" satisfies keyof AiModels;

const SYSTEM_PROMPT =
  "You are an editor who writes short, factual daily digests of RSS feeds. " +
  "Answer with the digest only, without preamble.";

const MAX_TOKENS = 1024;

export const NO_SUMMARY_FALLBACK = "No summary generated.";

export function buildDigestPrompt(feedTitle: string, entries: FeedEntry[]): string {
  const lines = entries.map((entry, index) => {
    const title = entry.title ?? "(untitled)";
    const link = entry.link ?? "";
    const snippet = entry.contentSnippet ?? entry.content ?? "";
    return `${index + 1}. ${title}\nURL: ${link}\nExcerpt: ${snippet}`;
  });

  return [
    `Create a concise daily digest of the following RSS entries from "${feedTitle}".`,
    "Keep it brief (4-8 bullet points), factual, and easy to scan.",
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
