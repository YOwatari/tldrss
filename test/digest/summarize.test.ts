import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_AI_MODEL,
  MAX_BULLET_CHARS,
  MAX_EXCERPT_CHARS,
  MAX_PROMPT_ENTRIES,
  buildDigestPrompt,
  selectPromptEntries,
  summarizeEntries,
} from "../../src/digest/summarize";

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

describe("buildDigestPrompt (bounds)", () => {
  it("truncates long excerpts", () => {
    const prompt = buildDigestPrompt("Example Feed", [
      { title: "Long", link: "https://example.com/1", content: "x".repeat(MAX_EXCERPT_CHARS * 2) },
    ]);

    expect(prompt).toContain(`${"x".repeat(MAX_EXCERPT_CHARS)}…`);
    expect(prompt).not.toContain("x".repeat(MAX_EXCERPT_CHARS + 1));
  });

  it("keeps the newest entries when the feed is oldest-first", () => {
    const oldestFirst = Array.from({ length: MAX_PROMPT_ENTRIES + 3 }, (_, index) => ({
      title: `Entry ${index + 1}`,
      link: `https://example.com/${index + 1}`,
      isoDate: new Date(Date.UTC(2026, 8, 1, index)).toISOString(),
    }));

    const prompt = buildDigestPrompt("Example Feed", oldestFirst);

    expect(prompt).toContain(`1. Entry ${oldestFirst.length}`);
    expect(prompt).not.toContain("Entry 1\n");
    expect(prompt).not.toContain("Entry 2\n");
  });

  it("truncates feed-controlled titles and urls", () => {
    const prompt = buildDigestPrompt("F".repeat(MAX_EXCERPT_CHARS * 2), [
      { title: "Entry", link: `https://example.com/${"u".repeat(MAX_EXCERPT_CHARS * 2)}` },
    ]);

    expect(prompt).not.toContain("F".repeat(MAX_EXCERPT_CHARS + 1));
    expect(prompt).not.toContain("u".repeat(MAX_EXCERPT_CHARS + 1));
  });

  it("caps the number of entries and says how many were dropped", () => {
    const many = Array.from({ length: MAX_PROMPT_ENTRIES + 5 }, (_, index) => ({
      title: `Entry ${index + 1}`,
      link: `https://example.com/${index + 1}`,
    }));

    const prompt = buildDigestPrompt("Example Feed", many);

    expect(prompt).toContain(`${MAX_PROMPT_ENTRIES}. Entry ${MAX_PROMPT_ENTRIES}`);
    expect(prompt).not.toContain(`Entry ${MAX_PROMPT_ENTRIES + 1}`);
    expect(prompt).toContain(`${MAX_PROMPT_ENTRIES} of ${many.length}`);
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

  it("falls back in Japanese for a Japanese digest", async () => {
    const { ai } = stubAi({ response: "   " });

    await expect(
      summarizeEntries({ ai, feedTitle: "Example Feed", entries, language: "ja" }),
    ).resolves.toBe("要約を生成できませんでした。");
  });

  it("throws when the model returns an unexpected shape", async () => {
    const { ai } = stubAi({ unexpected: true });

    await expect(
      summarizeEntries({ ai, feedTitle: "Example Feed", entries }),
    ).rejects.toThrow(/Workers AI/);
  });
});

describe("digest language", () => {
  it("prompts in English by default", () => {
    const prompt = buildDigestPrompt("Example Feed", entries);

    expect(prompt).toContain("Create a concise daily digest");
    expect(prompt).not.toContain("日本語");
  });

  it("instructs the model to write the digest in Japanese when asked", () => {
    const prompt = buildDigestPrompt("Example Feed", entries, "ja");

    expect(prompt).toContain("日本語");
  });

  it("sends an English system prompt by default", async () => {
    const { ai, run } = stubAi({ response: "ok" });

    await summarizeEntries({ ai, feedTitle: "Example Feed", entries });

    expect(run.mock.calls[0][1].messages[0].content).toContain("without preamble");
  });

  it("sends a Japanese system prompt for the ja language", async () => {
    const { ai, run } = stubAi({ response: "ok" });

    await summarizeEntries({ ai, feedTitle: "Example Feed", entries, language: "ja" });

    expect(run.mock.calls[0][1].messages[0].content).toContain("日本語");
  });
});

describe("digest brevity", () => {
  it("caps how long each bullet may be", () => {
    const prompt = buildDigestPrompt("Example Feed", entries);

    expect(prompt).toContain(`${MAX_BULLET_CHARS}`);
  });
});

describe("selectPromptEntries", () => {
  it("returns the newest entries in the order the prompt numbers them", () => {
    const oldestFirst = Array.from({ length: MAX_PROMPT_ENTRIES + 2 }, (_, index) => ({
      title: `Entry ${index + 1}`,
      link: `https://example.com/${index + 1}`,
      isoDate: new Date(Date.UTC(2026, 8, 1, index)).toISOString(),
    }));

    const selected = selectPromptEntries(oldestFirst);
    const prompt = buildDigestPrompt("Example Feed", oldestFirst);

    expect(selected).toHaveLength(MAX_PROMPT_ENTRIES);
    // The numbering in the prompt has to match the position in this list, or
    // the reference links would point at the wrong article.
    selected.forEach((entry, index) => {
      expect(prompt).toContain(`${index + 1}. ${entry.title}`);
    });
  });
});

describe("reference markers", () => {
  it("asks the model to cite entry numbers in English", () => {
    expect(buildDigestPrompt("Example Feed", entries)).toContain("square brackets");
  });

  it("asks the model to cite entry numbers in Japanese", () => {
    expect(buildDigestPrompt("Example Feed", entries, "ja")).toContain("角かっこ");
  });
});

describe("prompt for a short feed", () => {
  const two = [
    { title: "One", link: "https://example.com/1" },
    { title: "Two", link: "https://example.com/2" },
  ];

  // Asking for 4-8 bullets while forbidding repeats and invented numbers is
  // impossible for a feed this small, and pushes the model to make numbers up.
  it("allows covering every entry in English", () => {
    expect(buildDigestPrompt("Example Feed", two)).toContain("fewer than four");
  });

  it("allows covering every entry in Japanese", () => {
    expect(buildDigestPrompt("Example Feed", two, "ja")).toContain("4 件未満");
  });
});
