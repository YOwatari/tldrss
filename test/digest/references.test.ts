import { describe, expect, it } from "vitest";
import { renderDigestHtml } from "../../src/digest/references";

const entries = [
  { title: "First article", link: "https://example.com/1" },
  { title: "Second & third", link: "https://example.com/2?a=1&b=2" },
  { title: "No link article" },
];

describe("renderDigestHtml", () => {
  it("builds a list whose headings link to the article", () => {
    const html = renderDigestHtml("[1] It shipped.", entries);

    expect(html).toBe(
      '<ul>\n  <li><a href="https://example.com/1">First article</a><br />It shipped.</li>\n</ul>',
    );
  });

  it("keeps the entry order rather than the order the model listed them", () => {
    const html = renderDigestHtml("[2] Second summary.\n[1] First summary.", entries);

    expect(html.indexOf("First article")).toBeLessThan(html.indexOf("Second &amp; third"));
  });

  it("accepts bullets the model prefixed with a list marker", () => {
    expect(renderDigestHtml("* [1] It shipped.", entries)).toContain("It shipped.");
    expect(renderDigestHtml("• [1] It shipped.", entries)).toContain("It shipped.");
    expect(renderDigestHtml("- [1] It shipped.", entries)).toContain("It shipped.");
  });

  it("renders a heading without a link when the entry carries none", () => {
    const html = renderDigestHtml("[3] No link here.", entries);

    expect(html).toContain("<li>No link article<br />No link here.</li>");
    expect(html).not.toContain("<a href");
  });

  it("ignores numbers pointing outside the entry list", () => {
    expect(renderDigestHtml("[9] Invented.", entries)).not.toContain("Invented.");
  });

  it("keeps only the first bullet when the model repeats an entry", () => {
    const html = renderDigestHtml("[1] First take.\n[1] Second take.", entries);

    expect(html).toContain("First take.");
    expect(html).not.toContain("Second take.");
  });

  it("falls back to the raw text when the model ignores the format", () => {
    const html = renderDigestHtml("No new entries were published.", entries);

    expect(html).toBe("No new entries were published.");
  });

  it("escapes html from the model and from the feed", () => {
    const hostile = [{ title: "<b>t</b>", link: 'https://example.com/"><script>x</script>' }];

    const html = renderDigestHtml("[1] <script>alert(1)</script>", hostile);

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;b&gt;t&lt;/b&gt;");
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
  });

  it("escapes ampersands in the article url", () => {
    expect(renderDigestHtml("[2] Summary.", entries)).toContain(
      'href="https://example.com/2?a=1&amp;b=2"',
    );
  });
});
