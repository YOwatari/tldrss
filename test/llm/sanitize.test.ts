import { describe, expect, it } from "vitest";
import { sanitizeLlmHtml } from "../../src/llm/sanitize";

describe("sanitizeLlmHtml (allowed markup)", () => {
  it("keeps the tags the prompt asks for", () => {
    const html =
      "<p>Lead.</p><h3>Articles</h3><ul><li><a href=\"https://example.com/1\">One</a> — summary</li></ul>";

    expect(sanitizeLlmHtml(html)).toBe(html);
  });

  it("keeps strong and normalizes a void break", () => {
    expect(sanitizeLlmHtml("<p><strong>Bold</strong><br>text</p>")).toBe(
      "<p><strong>Bold</strong><br />text</p>",
    );
  });

  it("lowercases tag names", () => {
    expect(sanitizeLlmHtml("<P>Lead.</P>")).toBe("<p>Lead.</p>");
  });
});

describe("sanitizeLlmHtml (disallowed markup)", () => {
  it("drops a disallowed tag but keeps the text it wrapped", () => {
    expect(sanitizeLlmHtml("<div><b>Hello</b> world</div>")).toBe("Hello world");
  });

  it("removes a script element along with its content", () => {
    expect(sanitizeLlmHtml("<p>Safe</p><script>alert('xss')</script>")).toBe("<p>Safe</p>");
  });

  it("removes an unterminated script element", () => {
    expect(sanitizeLlmHtml("<p>Safe</p><script>alert('xss')")).toBe("<p>Safe</p>");
  });

  it("removes a style element along with its content", () => {
    expect(sanitizeLlmHtml("<style>p{display:none}</style><p>Safe</p>")).toBe("<p>Safe</p>");
  });

  it("removes html comments", () => {
    expect(sanitizeLlmHtml("<p>Safe<!-- <script>alert(1)</script> --></p>")).toBe("<p>Safe</p>");
  });

  it("strips every attribute of an allowed tag", () => {
    expect(sanitizeLlmHtml('<p onclick="steal()" class="x">Safe</p>')).toBe("<p>Safe</p>");
  });

  it("strips event handlers from an anchor", () => {
    expect(
      sanitizeLlmHtml('<a href="https://example.com/1" onclick="steal()">One</a>'),
    ).toBe('<a href="https://example.com/1">One</a>');
  });
});

describe("sanitizeLlmHtml (links)", () => {
  it("keeps an http(s) href", () => {
    expect(sanitizeLlmHtml('<a href="http://example.com/1">One</a>')).toBe(
      '<a href="http://example.com/1">One</a>',
    );
  });

  it("drops a javascript: href but keeps the link text", () => {
    expect(sanitizeLlmHtml('<a href="javascript:alert(1)">Click</a>')).toBe("<a>Click</a>");
  });

  it("drops a javascript: href hidden behind an entity", () => {
    expect(sanitizeLlmHtml('<a href="java&#115;cript:alert(1)">Click</a>')).toBe(
      "<a>Click</a>",
    );
  });

  it("drops a data: href", () => {
    expect(sanitizeLlmHtml('<a href="data:text/html,<script>alert(1)</script>">Click</a>')).toBe(
      "<a>Click</a>",
    );
  });

  it("drops a relative href, which would resolve against the reader", () => {
    expect(sanitizeLlmHtml('<a href="/relative">Click</a>')).toBe("<a>Click</a>");
  });

  it("escapes a quote inside an href", () => {
    expect(sanitizeLlmHtml('<a href=\'https://example.com/?q="x\'>One</a>')).toBe(
      '<a href="https://example.com/?q=%22x">One</a>',
    );
  });
});

describe("sanitizeLlmHtml (code fences)", () => {
  it("removes an html code fence around the answer", () => {
    expect(sanitizeLlmHtml("```html\n<p>Lead.</p>\n```")).toBe("<p>Lead.</p>");
  });

  it("removes a bare code fence", () => {
    expect(sanitizeLlmHtml("```\n<p>Lead.</p>\n```")).toBe("<p>Lead.</p>");
  });
});

describe("sanitizeLlmHtml (text)", () => {
  it("escapes markup characters in text", () => {
    expect(sanitizeLlmHtml("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d");
  });

  it("leaves an existing entity alone rather than escaping it twice", () => {
    expect(sanitizeLlmHtml("Fish &amp; Chips &#39;n more")).toBe("Fish &amp; Chips &#39;n more");
  });

  it("keeps line breaks of a plain-text answer visible", () => {
    expect(sanitizeLlmHtml("first line\nsecond line")).toBe("first line<br />second line");
  });

  it("does not turn the whitespace between tags into breaks", () => {
    expect(sanitizeLlmHtml("<p>Lead.</p>\n<ul>\n<li>One</li>\n</ul>")).toBe(
      "<p>Lead.</p><ul><li>One</li></ul>",
    );
  });

  it("keeps the space around an inline tag", () => {
    expect(sanitizeLlmHtml("<p>a <strong>b</strong> c</p>")).toBe(
      "<p>a <strong>b</strong> c</p>",
    );
  });

  it("returns nothing for an answer with no content", () => {
    expect(sanitizeLlmHtml("   \n  ")).toBe("");
  });
});

describe("sanitizeLlmHtml (well-formedness)", () => {
  it("closes a tag the model left open", () => {
    expect(sanitizeLlmHtml("<p>Lead.")).toBe("<p>Lead.</p>");
  });

  it("closes nested tags in order", () => {
    expect(sanitizeLlmHtml("<ul><li>One")).toBe("<ul><li>One</li></ul>");
  });

  it("drops a closing tag that never opened", () => {
    expect(sanitizeLlmHtml("Lead.</p>")).toBe("Lead.");
  });

  it("closes the tags left open inside one the model did close", () => {
    expect(sanitizeLlmHtml("<ul><li>One</ul>")).toBe("<ul><li>One</li></ul>");
  });
});
