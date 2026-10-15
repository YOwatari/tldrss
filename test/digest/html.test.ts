import { describe, expect, it } from "vitest";
import { leadOf, renderDigestBodyHtml } from "../../src/digest/html";

const entries = [
  { title: "First article", link: "https://example.com/1" },
  { title: "Second & third", link: "https://example.com/2?a=1&b=2" },
  { title: "No link article" },
];

describe("renderDigestBodyHtml", () => {
  it("renders the lead, then every entry linked to its article", () => {
    const html = renderDigestBodyHtml({ lead: "A busy day.", entries, availableCount: 3 });

    expect(html).toBe(
      "<p>A busy day.</p>\n<ul>\n" +
        '  <li><a href="https://example.com/1">First article</a></li>\n' +
        '  <li><a href="https://example.com/2?a=1&amp;b=2">Second &amp; third</a></li>\n' +
        "  <li>No link article</li>\n</ul>",
    );
  });

  it("carries no per-entry summary", () => {
    const html = renderDigestBodyHtml({ lead: "Lead.", entries, availableCount: 3 });

    expect(html).not.toContain("<br");
  });

  it("escapes the lead", () => {
    const html = renderDigestBodyHtml({ lead: "a <script> & b", entries: [], availableCount: 0 });

    expect(html).toBe("<p>a &lt;script&gt; &amp; b</p>");
  });

  it("says how many entries MAX_ENTRIES left out, and that the newest are shown", () => {
    expect(renderDigestBodyHtml({ lead: "Lead.", entries, availableCount: 10 })).toContain(
      "<p>…and 7 more (only the newest 3 are listed)</p>",
    );
    expect(renderDigestBodyHtml({ lead: "Lead.", entries, availableCount: 10, language: "ja" })).toContain(
      "<p>ほか 7 件（新しい順に 3 件まで掲載）</p>",
    );
  });

  it("says nothing more when every entry is listed", () => {
    expect(renderDigestBodyHtml({ lead: "Lead.", entries, availableCount: 3 })).not.toMatch(/more|ほか/);
  });

  it("labels an entry the feed gave no title", () => {
    expect(renderDigestBodyHtml({ lead: "", entries: [{ link: "https://example.com/1" }], availableCount: 1 })).toContain("(untitled)");
    expect(renderDigestBodyHtml({ lead: "", entries: [{}], availableCount: 1, language: "ja" })).toContain("(タイトルなし)");
  });

  it("escapes a hostile title and refuses a hostile link", () => {
    const html = renderDigestBodyHtml({
      lead: "",
      entries: [{ title: "<script>alert(1)</script>", link: "javascript:alert(1)" }],
      availableCount: 1,
    });

    expect(html).not.toContain("<script>");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("&lt;script&gt;");
  });

  it("links only absolute http(s) urls", () => {
    for (const link of ["data:text/html,x", "/article/1", "not a url"]) {
      expect(renderDigestBodyHtml({ lead: "", entries: [{ title: "T", link }], availableCount: 1 })).toContain("<li>T</li>");
    }
    expect(
      renderDigestBodyHtml({ lead: "", entries: [{ title: "T", link: "http://example.com/1" }], availableCount: 1 }),
    ).toContain('<a href="http://example.com/1">T</a>');
  });

  it("renders the lead alone when there is nothing to list", () => {
    expect(renderDigestBodyHtml({ lead: "Quiet day.", entries: [], availableCount: 0 })).toBe("<p>Quiet day.</p>");
  });
});

describe("leadOf", () => {
  it("returns a plain answer as it is", () => {
    expect(leadOf("A busy day.")).toBe("A busy day.");
  });
  it("joins a multi-line lead with spaces", () => {
    expect(leadOf("First.\nSecond.\n\n")).toBe("First. Second.");
  });
  it("keeps only the text before bullets the model added anyway", () => {
    expect(leadOf("Lead.\n[1] It shipped.\nThanks for reading.")).toBe("Lead.");
    expect(leadOf("Lead.\n- [1] It shipped.")).toBe("Lead.");
  });
  it("is empty when the answer opens with a bullet", () => {
    expect(leadOf("[1] It shipped.")).toBe("");
  });
  it("is empty for a blank answer, or one that is only markup", () => {
    expect(leadOf("  \n ")).toBe("");
    expect(leadOf("<script>alert(1)</script>")).toBe("");
  });
  it("reduces markup to plain text", () => {
    expect(leadOf('<p>Big <b>day</b> at <a href="https://evil.example">x</a></p>')).toBe("Big day at x");
  });
  it("drops urls the model wrote", () => {
    expect(leadOf("See https://evil.example/pay now.")).toBe("See now.");
    expect(leadOf("詳細は https://evil.example/pay を参照。")).toBe("詳細は を参照。");
  });
});
