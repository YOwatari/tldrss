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

  it("ignores a number pointing outside the entry list", () => {
    const html = renderDigestHtml("[1] It shipped.\n[9] Invented.", entries);

    expect(html).toContain("It shipped.");
    expect(html).not.toContain("Invented.");
  });

  it("falls back to the raw text when no bullet resolves to an entry", () => {
    // An empty digest would be worse than showing what the model wrote.
    expect(renderDigestHtml("[9] Invented.", entries)).toBe("[9] Invented.");
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

describe("renderDigestHtml (unsafe urls)", () => {
  it.each(["javascript:alert(1)", "data:text/html,<script>x</script>", "vbscript:x"])(
    "renders the title as plain text for a %s link",
    (link) => {
      const html = renderDigestHtml("[1] Summary.", [{ title: "Hostile", link }]);

      expect(html).not.toContain("<a href");
      expect(html).toContain("<li>Hostile<br />Summary.</li>");
    },
  );

  it("renders the title as plain text when the link is a guid, not a url", () => {
    // parse.ts falls back to <guid>/<id> when an entry carries no link.
    const html = renderDigestHtml("[1] Summary.", [
      { title: "Guid only", link: "urn:uuid:8f1b0c62-0000-4000-8000-000000000000" },
    ]);

    expect(html).not.toContain("<a href");
    expect(html).toContain("<li>Guid only<br />Summary.</li>");
  });

  it("renders the title as plain text for a relative link", () => {
    const html = renderDigestHtml("[1] Summary.", [{ title: "Relative", link: "/article/1" }]);

    expect(html).not.toContain("<a href");
  });

  it("keeps linking absolute http and https urls", () => {
    for (const link of ["http://example.com/1", "https://example.com/1"]) {
      expect(renderDigestHtml("[1] Summary.", [{ title: "Fine", link }])).toContain(
        `<a href="${link}">Fine</a>`,
      );
    }
  });
});

describe("renderDigestHtml (lead)", () => {
  it("puts the text before the bullets into a lead paragraph", () => {
    const html = renderDigestHtml("Security was the theme today.\n[1] It shipped.", entries);

    expect(html).toBe(
      "<p>Security was the theme today.</p>\n" +
        '<ul>\n  <li><a href="https://example.com/1">First article</a><br />It shipped.</li>\n</ul>',
    );
  });

  it("joins a multi-line lead", () => {
    const html = renderDigestHtml("First sentence.\nSecond sentence.\n[1] It shipped.", entries);

    expect(html).toContain("<p>First sentence.<br />Second sentence.</p>");
  });

  it("omits the paragraph when the model wrote no lead", () => {
    expect(renderDigestHtml("[1] It shipped.", entries)).not.toContain("<p>");
  });

  it("ignores anything the model added after the bullets", () => {
    const html = renderDigestHtml("[1] It shipped.\nThat is all for today.", entries);

    expect(html).not.toContain("That is all for today.");
  });

  it("escapes html in the lead", () => {
    const html = renderDigestHtml("<script>x</script>\n[1] It shipped.", entries);

    expect(html).not.toContain("<script>");
    expect(html).toContain("<p>&lt;script&gt;x&lt;/script&gt;</p>");
  });
});
