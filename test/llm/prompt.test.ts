import { describe, expect, it } from "vitest";
import {
  MAX_EXCERPT_CHARS,
  buildDigestPrompt,
  systemPromptFor,
} from "../../src/llm/prompt";
import type { DigestInput } from "../../src/llm/summarizer";

const entries = [
  { title: "Entry 1", link: "https://example.com/1", contentSnippet: "Snippet 1" },
  { link: "https://example.com/2", content: "Body 2" },
];

function inputWith(overrides: Partial<DigestInput> = {}): DigestInput {
  return {
    feedTitle: "Example Feed",
    entries,
    availableCount: entries.length,
    language: "en",
    ...overrides,
  };
}

describe("buildDigestPrompt", () => {
  it("lists every entry with title, url and excerpt", () => {
    const prompt = buildDigestPrompt(inputWith());

    expect(prompt).toContain("Example Feed");
    expect(prompt).toContain("1. Entry 1\nURL: https://example.com/1\nExcerpt: Snippet 1");
    expect(prompt).toContain("2. (untitled)\nURL: https://example.com/2\nExcerpt: Body 2");
  });

  it("numbers the entries in the order they were given", () => {
    const prompt = buildDigestPrompt(
      inputWith({
        entries: [
          { title: "Newest", link: "https://example.com/n" },
          { title: "Older", link: "https://example.com/o" },
        ],
        availableCount: 2,
      }),
    );

    expect(prompt).toContain("1. Newest");
    expect(prompt).toContain("2. Older");
  });

  it("says how many entries were dropped by the cap", () => {
    const prompt = buildDigestPrompt(inputWith({ availableCount: 40 }));

    expect(prompt).toContain("2 of 40");
  });

  it("stays silent about the count when every entry is included", () => {
    expect(buildDigestPrompt(inputWith())).not.toContain("of 2");
  });

  it("truncates long excerpts", () => {
    const prompt = buildDigestPrompt(
      inputWith({
        entries: [
          { title: "Long", link: "https://example.com/1", content: "x".repeat(MAX_EXCERPT_CHARS * 2) },
        ],
        availableCount: 1,
      }),
    );

    expect(prompt).toContain(`${"x".repeat(MAX_EXCERPT_CHARS)}…`);
    expect(prompt).not.toContain("x".repeat(MAX_EXCERPT_CHARS + 1));
  });

  it("truncates feed-controlled titles and urls", () => {
    const prompt = buildDigestPrompt(
      inputWith({
        feedTitle: "F".repeat(MAX_EXCERPT_CHARS * 2),
        entries: [{ title: "Entry", link: `https://example.com/${"u".repeat(MAX_EXCERPT_CHARS * 2)}` }],
        availableCount: 1,
      }),
    );

    expect(prompt).not.toContain("F".repeat(MAX_EXCERPT_CHARS + 1));
    expect(prompt).not.toContain("u".repeat(MAX_EXCERPT_CHARS + 1));
  });

  it("asks for the lead alone, not a summary per entry", () => {
    for (const language of ["en", "ja"] as const) {
      const prompt = buildDigestPrompt(inputWith({ language }));
      expect(prompt).not.toMatch(/square brackets|角かっこ|one bullet per entry|1 件につき 1 項目/);
    }
    expect(buildDigestPrompt(inputWith())).toContain("Do not summarize the entries one by one");
    expect(buildDigestPrompt(inputWith({ language: "ja" }))).toContain("エントリを 1 件ずつ要約しないでください");
  });
});

describe("buildDigestPrompt (language)", () => {
  it("prompts in English by default", () => {
    const prompt = buildDigestPrompt(inputWith());

    expect(prompt).toContain("Write the lead of a daily digest");
    expect(prompt).not.toContain("日本語");
  });

  it("instructs the model to write the digest in Japanese when asked", () => {
    expect(buildDigestPrompt(inputWith({ language: "ja" }))).toContain("日本語");
  });
});

describe("systemPromptFor", () => {
  it("tells the model to answer with the digest only", () => {
    expect(systemPromptFor("en")).toContain("without preamble");
  });

  it("answers in Japanese for a Japanese digest", () => {
    expect(systemPromptFor("ja")).toContain("日本語");
  });
});

describe("prompt snapshots", () => {
  it("matches the English prompt", () => {
    expect(buildDigestPrompt(inputWith({ availableCount: 5 }))).toMatchSnapshot();
  });

  it("matches the Japanese prompt", () => {
    expect(
      buildDigestPrompt(inputWith({ language: "ja", availableCount: 5 })),
    ).toMatchSnapshot();
  });

  it("matches the system prompts", () => {
    expect({ en: systemPromptFor("en"), ja: systemPromptFor("ja") }).toMatchSnapshot();
  });
});
