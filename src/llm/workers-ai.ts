import { buildDigestPrompt, systemPromptFor } from "./prompt";
import type { DigestInput, Summarizer } from "./summarizer";

/** Workers AI text-generation model used unless `AI_MODEL` overrides it. */
export const DEFAULT_AI_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct" satisfies keyof AiModels;

/** Bounds the answer, and with it the cost of one digest. */
const MAX_TOKENS = 1024;

/** One retry: enough for a transient upstream failure, without doubling cost twice. */
const MAX_ATTEMPTS = 2;

/**
 * What all attempts together may take. Generation runs in `ctx.waitUntil`,
 * which Cloudflare extends for at most 30 seconds after the response, and the
 * feed fetch and the KV writes come out of the same 30 seconds. A budget of 20
 * leaves room for those: an isolate torn down mid-generation would take the
 * fallback digest with it, so nothing would be cached at all.
 */
export const AI_ATTEMPT_BUDGET_MS = 20_000;

/**
 * How long one attempt may take. Nothing else would ever cut a stalled call
 * short — no response is waiting on it.
 */
export const AI_TIMEOUT_MS = AI_ATTEMPT_BUDGET_MS / MAX_ATTEMPTS;

/** Time reserved for the page and XML KV writes after model inference. */
export const STORAGE_BUDGET_MS = 2_000;

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

  async function attempt(input: DigestInput, timeoutMs: number): Promise<string> {
    const result = await withTimeout(
      params.ai.run(model, {
        messages: [
          { role: "system", content: systemPromptFor(input.language, input.period) },
          { role: "user", content: buildDigestPrompt(input) },
        ],
        max_tokens: MAX_TOKENS,
      }),
      timeoutMs,
    );

    return extractResponseText(result);
  }

  return {
    async summarize(input: DigestInput, options = {}): Promise<string> {
      let lastError: unknown = new Error("Workers AI was never called");

      for (let tries = 0; tries < MAX_ATTEMPTS; tries++) {
        try {
          const remaining = options.deadlineAt === undefined
            ? AI_TIMEOUT_MS * (MAX_ATTEMPTS - tries)
            : options.deadlineAt - Date.now() - STORAGE_BUDGET_MS;
          const timeoutMs = Math.floor(remaining / (MAX_ATTEMPTS - tries));
          if (timeoutMs <= 0) throw new Error("Generation deadline exceeded before Workers AI");
          return await attempt(input, Math.min(AI_TIMEOUT_MS, timeoutMs));
        } catch (error) {
          lastError = error;
        }
      }

      throw lastError;
    },
  };
}
