import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDigestPrompt, systemPromptFor } from "../../src/llm/prompt";
import type { DigestInput } from "../../src/llm/summarizer";
import {
  AI_ATTEMPT_BUDGET_MS,
  AI_TIMEOUT_MS,
  STORAGE_BUDGET_MS,
  DEFAULT_AI_MODEL,
  createWorkersAiSummarizer,
} from "../../src/llm/workers-ai";

const input: DigestInput = {
  feedTitle: "Example Feed",
  entries: [{ title: "Entry 1", link: "https://example.com/1", contentSnippet: "Snippet 1" }],
  availableCount: 1,
  language: "en",
};

function stubAi(...results: unknown[]) {
  const run = vi.fn();
  for (const result of results) {
    run.mockImplementationOnce(() =>
      result instanceof Error ? Promise.reject(result) : Promise.resolve(result),
    );
  }
  return { ai: { run } as unknown as Ai, run };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("attempt budget", () => {
  // Generation runs in `ctx.waitUntil`, which Cloudflare extends for at most
  // 30 seconds after the response. Every attempt has to fit inside that, with
  // room left for the feed fetch and the KV writes.
  it("keeps every attempt together inside the waitUntil budget", () => {
    expect(AI_ATTEMPT_BUDGET_MS).toBeLessThanOrEqual(20_000);
  });

  it("never lets one attempt outlast the budget they share", () => {
    expect(AI_TIMEOUT_MS).toBeLessThanOrEqual(AI_ATTEMPT_BUDGET_MS);
  });
});

describe("createWorkersAiSummarizer", () => {
  it("sends the system and digest prompts to the default model", async () => {
    const { ai, run } = stubAi({ response: "- summary\n" });

    const summary = await createWorkersAiSummarizer({ ai }).summarize(input);

    expect(summary).toBe("- summary");
    expect(run).toHaveBeenCalledTimes(1);
    const [model, inputs] = run.mock.calls[0];
    expect(model).toBe(DEFAULT_AI_MODEL);
    expect(inputs.messages).toEqual([
      { role: "system", content: systemPromptFor("en") },
      { role: "user", content: buildDigestPrompt(input) },
    ]);
  });

  it("honours the configured model", async () => {
    const { ai, run } = stubAi({ response: "ok" });

    await createWorkersAiSummarizer({
      ai,
      model: "@cf/meta/llama-3.1-8b-instruct-fp8",
    }).summarize(input);

    expect(run.mock.calls[0][0]).toBe("@cf/meta/llama-3.1-8b-instruct-fp8");
  });

  it("sends a Japanese system prompt for a Japanese digest", async () => {
    const { ai, run } = stubAi({ response: "ok" });

    await createWorkersAiSummarizer({ ai }).summarize({ ...input, language: "ja" });

    expect(run.mock.calls[0][1].messages[0].content).toBe(systemPromptFor("ja"));
  });

  it("retries once and keeps the second answer", async () => {
    const { ai, run } = stubAi(new Error("upstream blew up"), { response: "second try" });

    await expect(createWorkersAiSummarizer({ ai }).summarize(input)).resolves.toBe("second try");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("gives up after the retry and reports the last failure", async () => {
    const { ai, run } = stubAi(new Error("first"), new Error("second"));

    await expect(createWorkersAiSummarizer({ ai }).summarize(input)).rejects.toThrow("Workers AI provider");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("rejects an unexpected response shape", async () => {
    const { ai } = stubAi({ unexpected: true }, { unexpected: true });

    await expect(createWorkersAiSummarizer({ ai }).summarize(input)).rejects.toThrow(
      /Workers AI/,
    );
  });

  it("rejects a response with no usable text", async () => {
    const { ai } = stubAi({ response: "   " }, { response: "" });

    await expect(createWorkersAiSummarizer({ ai }).summarize(input)).rejects.toThrow(
      /Workers AI/,
    );
  });

  it("does not retain an unexpected response in the error", async () => {
    const secret = "model-secret-and-feed-token";
    const { ai } = stubAi({ response: secret }, { response: { secret } });

    await expect(createWorkersAiSummarizer({ ai }).summarize(input)).resolves.toBe(secret);
    const { ai: badAi } = stubAi({ unexpected: secret }, { unexpected: secret });
    await expect(createWorkersAiSummarizer({ ai: badAi }).summarize(input)).rejects.toThrow(
      new RegExp(`Workers AI invalid response`),
    );
  });

  it("gives up on a model that never answers", async () => {
    vi.useFakeTimers();
    const run = vi.fn().mockReturnValue(new Promise(() => {}));
    const ai = { run } as unknown as Ai;

    const summarizing = createWorkersAiSummarizer({ ai }).summarize(input);
    const assertion = expect(summarizing).rejects.toThrow(/timed out/);
    // Both attempts have to time out before the summarizer gives up.
    await vi.advanceTimersByTimeAsync(AI_ATTEMPT_BUDGET_MS + 1);

    await assertion;
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("reserves storage time and divides a shared deadline across retries", async () => {
    vi.useFakeTimers();
    const run = vi.fn().mockReturnValue(new Promise(() => {}));
    const summarizing = createWorkersAiSummarizer({ ai: { run } as unknown as Ai }).summarize(input, {
      deadlineAt: Date.now() + 6_000,
    });
    const assertion = expect(summarizing).rejects.toThrow(/timed out/);

    await vi.advanceTimersByTimeAsync(2_001);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_001);
    await assertion;
    expect(STORAGE_BUDGET_MS).toBe(2_000);
  });

  it("does not start an AI attempt after the shared deadline", async () => {
    const { ai, run } = stubAi({ response: "unused" });

    await expect(createWorkersAiSummarizer({ ai }).summarize(input, {
      deadlineAt: Date.now() - 1,
    })).rejects.toThrow(/deadline/);
    expect(run).not.toHaveBeenCalled();
  });
});
