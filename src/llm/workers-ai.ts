import { buildDigestPrompt, systemPromptFor } from "./prompt";
import type { DigestInput, Summarizer } from "./summarizer";

/** Workers AI text-generation model used unless `AI_MODEL` overrides it. */
export const DEFAULT_AI_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct" satisfies keyof AiModels;

/** Bounds the answer, and with it the cost of one digest. */
const MAX_TOKENS = 1024;

/**
 * How long one attempt may take. Generation runs in `waitUntil`, outside any
 * response, so nothing else would ever cut a stalled call short.
 */
export const AI_TIMEOUT_MS = 20_000;

/** One retry: enough for a transient upstream failure, without doubling cost twice. */
const MAX_ATTEMPTS = 2;

function extractResponseText(result: unknown): string {
  if (typeof result === "object" && result !== null && "response" in result) {
    const { response } = result as { response?: unknown };
    if (typeof response === "string" && response.trim() !== "") return response.trim();
  }

  throw new Error(`Unexpected Workers AI response: ${JSON.stringify(result)}`);
}

/**
 * `ai.run` takes no abort signal, so the timeout can only bound how long we
 * wait, not the call itself. The abandoned call is harmless: its answer is
 * dropped and nothing downstream depends on it.
 */
async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Workers AI timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A `Summarizer` backed by the account's own Workers AI binding, so no API key
 * travels with a request.
 */
export function createWorkersAiSummarizer(params: { ai: Ai; model?: string }): Summarizer {
  const model = (params.model ?? DEFAULT_AI_MODEL) as keyof AiModels;

  async function attempt(input: DigestInput): Promise<string> {
    const result = await withTimeout(
      params.ai.run(model, {
        messages: [
          { role: "system", content: systemPromptFor(input.language) },
          { role: "user", content: buildDigestPrompt(input) },
        ],
        max_tokens: MAX_TOKENS,
      }),
      AI_TIMEOUT_MS,
    );

    return extractResponseText(result);
  }

  return {
    async summarize(input: DigestInput): Promise<string> {
      let lastError: unknown;

      for (let remaining = MAX_ATTEMPTS; remaining > 0; remaining--) {
        try {
          return await attempt(input);
        } catch (error) {
          lastError = error;
        }
      }

      throw lastError;
    },
  };
}
