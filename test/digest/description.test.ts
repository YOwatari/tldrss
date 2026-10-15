import { describe, expect, it } from "vitest";
import { renderDescriptionHtml } from "../../src/digest/description";
import { moreEntriesText } from "../../src/digest/text";

const entry = (title?: string, link = "https://source.example/1") => ({ title, link });
const liTexts = (html: string) => [...html.matchAll(/<li>(.*?)<\/li>/g)].map((m) => m[1]);

describe("moreEntriesText", () => {
  it("words the remainder in Japanese", () => {
    expect(moreEntriesText(3, "ja")).toBe("…ほか 3 件");
  });
  it("words the remainder in English", () => {
    expect(moreEntriesText(3, "en")).toBe("…and 3 more");
  });
});

describe("renderDescriptionHtml", () => {
  it("renders the lead and every title when they fit", () => {
    expect(renderDescriptionHtml({ lead: "A busy day.", entries: [entry("A"), entry("B")], availableCount: 2, language: "en", maxChars: 450 }))
      .toBe("<p>A busy day.</p><ul><li>A</li><li>B</li></ul>");
  });
  it("counts the entries MAX_ENTRIES left out", () => {
    // 2 件を載せ、上限前は 5 件
    expect(renderDescriptionHtml({ lead: "L", entries: [entry("A"), entry("B")], availableCount: 5, language: "ja", maxChars: 450 }))
      .toBe("<p>L</p><ul><li>A</li><li>B</li></ul><p>…ほか 3 件</p>");
  });
  it("words the remainder in English for an English digest", () => {
    expect(renderDescriptionHtml({ lead: "L", entries: [entry("A")], availableCount: 3, language: "en", maxChars: 450 }))
      .toContain("<p>…and 2 more</p>");
  });
  it("lists whole titles only and counts the rest when they do not all fit", () => {
    const entries = Array.from({ length: 30 }, (_, i) => entry(`Entry number ${i + 1} with a longer title`));
    const html = renderDescriptionHtml({ lead: "L", entries, availableCount: 40, language: "ja", maxChars: 450 });
    const listed = liTexts(html);
    expect(html.length).toBeLessThanOrEqual(450);
    expect(listed).toEqual(entries.slice(0, listed.length).map((e) => e.title));
    expect(html).toContain(`<p>…ほか ${40 - listed.length} 件</p>`);
  });
  it("stops at the first title that does not fit rather than skipping to a shorter one", () => {
    const entries = [entry("x".repeat(150)), entry("y".repeat(300)), entry("short")];
    expect(liTexts(renderDescriptionHtml({ lead: "L", entries, availableCount: 3, language: "en", maxChars: 450 })))
      .toEqual(["x".repeat(150)]);
  });
  it("cuts a long lead at a sentence boundary and keeps room for a title and the remainder", () => {
    const lead = "これは長いリード文の一文です。".repeat(40);
    const html = renderDescriptionHtml({ lead, entries: [entry("記事A"), entry("記事B")], availableCount: 2, language: "ja", maxChars: 450 });
    expect(html.length).toBeLessThanOrEqual(450);
    expect(html).toMatch(/^<p>(これは長いリード文の一文です。)+…<\/p>/);
    expect(liTexts(html)[0]).toBe("記事A");
  });
  it("lists a first title longer than 40 characters whole when it fits beside a long lead", () => {
    const lead = "今日は多くの更新がありました。".repeat(30);
    const title = "大規模言語モデルの推論コストを半分にする新しい量子化手法と、その実運用で分かった五つの課題について解説";
    const html = renderDescriptionHtml({ lead, entries: [entry(title)], availableCount: 5, language: "ja", maxChars: 450 });
    expect(html.length).toBeLessThanOrEqual(450);
    expect(liTexts(html)).toEqual([title]);
    expect(html).toContain("<p>…ほか 4 件</p>");
  });
  it("hard-cuts a lead that has no sentence boundary", () => {
    const html = renderDescriptionHtml({ lead: "あ".repeat(1000), entries: [entry("A")], availableCount: 1, language: "ja", maxChars: 450 });
    expect(html.length).toBeLessThanOrEqual(450);
    expect(html).toMatch(/^<p>あ+…<\/p><ul><li>A<\/li><\/ul>$/);
  });
  it("truncates a single title that exceeds the budget on its own", () => {
    const html = renderDescriptionHtml({ lead: "L", entries: [entry("t".repeat(1000)), entry("B")], availableCount: 2, language: "en", maxChars: 450 });
    expect(html.length).toBeLessThanOrEqual(450);
    expect(liTexts(html)).toHaveLength(1);
    expect(liTexts(html)[0]).toMatch(/^t+…$/);
    expect(html).toContain("<p>…and 1 more</p>");
  });
  it("carries no link and no url, even when the lead and titles contain them", () => {
    const html = renderDescriptionHtml({ lead: "See https://evil.example/x now.", entries: [entry("Read HTTP://a.example/b"), entry("https://only.example/url")], availableCount: 2, language: "en", maxChars: 450 });
    expect(html).not.toMatch(/<a\b/i);
    expect(html).not.toMatch(/https?:\/\//i);
    expect(liTexts(html)[1]).toBe("(untitled)");
  });
  it("removes only the url when Japanese text follows it without a space", () => {
    const html = renderDescriptionHtml({ lead: "詳細はhttps://x/aを参照。次の文", entries: [], availableCount: 0, language: "ja", maxChars: 450 });
    expect(html).toBe("<p>詳細はを参照。次の文</p>");
  });
  it("escapes markup and measures the escaped length", () => {
    const html = renderDescriptionHtml({ lead: "<b>x</b>", entries: Array.from({ length: 20 }, () => entry("&".repeat(30))), availableCount: 20, language: "en", maxChars: 450 });
    expect(html).toContain("<p>&lt;b&gt;x&lt;/b&gt;</p>");
    expect(html.length).toBeLessThanOrEqual(450);
    expect(html).not.toMatch(/&(?!amp;|lt;|gt;|quot;)/); // エンティティを割っていない
  });
  it("never leaves half of a surrogate pair when cutting", () => {
    const html = renderDescriptionHtml({ lead: "😀".repeat(500), entries: [entry("🎉".repeat(500))], availableCount: 1, language: "ja", maxChars: 450 });
    expect(html).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });
  it("renders the lead alone when there are no entries", () => {
    expect(renderDescriptionHtml({ lead: "Nothing new.", entries: [], availableCount: 0, language: "en", maxChars: 450 })).toBe("<p>Nothing new.</p>");
  });
  it("omits the lead paragraph when the lead is empty", () => {
    expect(renderDescriptionHtml({ lead: "", entries: [entry("A")], availableCount: 1, language: "en", maxChars: 450 })).toBe("<ul><li>A</li></ul>");
  });
  it.each([100, 150, 200, 300, 450, 600])("stays within %i characters for any mix of inputs", (maxChars) => {
    for (const language of ["en", "ja"] as const)
      for (const lead of ["", "短い。", "長い文です。".repeat(200)])
        for (const count of [0, 1, 30, 100]) {
          const entries = Array.from({ length: count }, (_, i) => entry(`記事 ${i} `.repeat(i % 7 + 1)));
          const html = renderDescriptionHtml({ lead, entries, availableCount: count * 2 + 50, language, maxChars });
          expect(html.length).toBeLessThanOrEqual(maxChars);
          expect(html).not.toMatch(/https?:\/\//i);
        }
  });
});
