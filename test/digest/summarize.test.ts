import { describe, expect, it, vi } from "vitest";
import { DEFAULT_AI_MODEL, buildDigestPrompt, summarizeEntries } from "../../src/digest/summarize";

const entries = [
  { title: "Entry 1", link: "https://example.com/1", contentSnippet: "Snippet 1" },
  { link: "https://example.com/2", content: "Body 2" },
];

function stubAi(result: unknown) {
  const run = vi.fn().mockResolvedValue(result);
  return { ai: { run } as unknown as Ai, run };
}

describe("buildDigestPrompt", () => {
  it("lists every entry with title, url and excerpt", () => {
    const prompt = buildDigestPrompt("Example Feed", entries);

    expect(prompt).toContain("Example Feed");
    expect(prompt).toContain("1. Entry 1\nURL: https://example.com/1\nExcerpt: Snippet 1");
    expect(prompt).toContain("2. (untitled)\nURL: https://example.com/2\nExcerpt: Body 2");
  });
});

describe("summarizeEntries", () => {
  it("calls the default Workers AI model with the digest prompt", async () => {
    const { ai, run } = stubAi({ response: "- summary\n" });

    const summary = await summarizeEntries({ ai, feedTitle: "Example Feed", entries });

    expect(summary).toBe("- summary");
    expect(run).toHaveBeenCalledTimes(1);
    const [model, inputs] = run.mock.calls[0];
    expect(model).toBe(DEFAULT_AI_MODEL);
    expect(inputs.messages.at(-1).content).toBe(buildDigestPrompt("Example Feed", entries));
  });

  it("honours the configured model", async () => {
    const { ai, run } = stubAi({ response: "ok" });

    await summarizeEntries({
      ai,
      model: "@cf/meta/llama-3.1-8b-instruct-fp8",
      feedTitle: "Example Feed",
      entries,
    });

    expect(run.mock.calls[0][0]).toBe("@cf/meta/llama-3.1-8b-instruct-fp8");
  });

  it("falls back when the model returns no usable text", async () => {
    const { ai } = stubAi({ response: "   " });

    await expect(summarizeEntries({ ai, feedTitle: "Example Feed", entries })).resolves.toBe(
      "No summary generated.",
    );
  });

  it("throws when the model returns an unexpected shape", async () => {
    const { ai } = stubAi({ unexpected: true });

    await expect(
      summarizeEntries({ ai, feedTitle: "Example Feed", entries }),
    ).rejects.toThrow(/Workers AI/);
  });
});
