import { describe, expect, it } from "vitest";
import { sanitizeLlmHtml } from "../../src/llm/sanitize";

describe("sanitizeLlmHtml (allowed markup)", () => {
  it("keeps the tags the prompt asks for", () => {
    const html =
      "<p>Lead.</p><h3>Articles</h3><ul><li><a href=\"https://example.com/1\">One</a> — summary</li></ul>";

    expect(sanitizeLlmHtml(html, { allowedHrefs: ["https://example.com/1"] })).toBe(html);
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

  it("removes an unterminated script element, content and all", () => {
    expect(sanitizeLlmHtml("<p>Safe</p><script>alert('xss')")).toBe("<p>Safe</p>");
  });

  it("removes a self-closed script element without dropping what follows", () => {
    expect(sanitizeLlmHtml("<p>Before</p><script/><p>After</p>")).toBe(
      "<p>Before</p><p>After</p>",
    );
  });

  it("removes a self-closed style element with attributes", () => {
    expect(sanitizeLlmHtml('<style type="text/css" /><p>After</p>')).toBe("<p>After</p>");
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
      sanitizeLlmHtml('<a href="https://example.com/1" onclick="steal()">One</a>', {
        allowedHrefs: ["https://example.com/1"],
      }),
    ).toBe('<a href="https://example.com/1">One</a>');
  });
});

describe("sanitizeLlmHtml (links)", () => {
  it("keeps an href the caller listed", () => {
    expect(
      sanitizeLlmHtml('<a href="http://example.com/1">One</a>', {
        allowedHrefs: ["http://example.com/1"],
      }),
    ).toBe('<a href="http://example.com/1">One</a>');
  });

  it("keeps an href the caller listed in a different but equivalent spelling", () => {
    expect(
      sanitizeLlmHtml('<a href="https://example.com">One</a>', {
        allowedHrefs: ["https://example.com/"],
      }),
    ).toBe('<a href="https://example.com/">One</a>');
  });

  // The feed text the model was prompted with is attacker-controlled, so a url
  // the model wrote is not evidence that the url exists in the feed.
  it("drops an href the caller did not list", () => {
    expect(
      sanitizeLlmHtml('<a href="https://phishing.example/pay">Click</a>', {
        allowedHrefs: ["https://example.com/1"],
      }),
    ).toBe("<a>Click</a>");
  });

  it("drops every href when the caller listed none", () => {
    expect(sanitizeLlmHtml('<a href="https://example.com/1">One</a>')).toBe("<a>One</a>");
  });

  it("ignores a listed url that is not http(s)", () => {
    expect(
      sanitizeLlmHtml('<a href="javascript:alert(1)">Click</a>', {
        allowedHrefs: ["javascript:alert(1)"],
      }),
    ).toBe("<a>Click</a>");
  });

  it("drops a javascript: href but keeps the link text", () => {
    expect(sanitizeLlmHtml('<a href="javascript:alert(1)">Click</a>')).toBe("<a>Click</a>");
  });

  it("drops a javascript: href even when the entry list is non-empty", () => {
    expect(
      sanitizeLlmHtml('<a href="javascript:alert(1)">Click</a>', {
        allowedHrefs: ["https://example.com/1"],
      }),
    ).toBe("<a>Click</a>");
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
    expect(
      sanitizeLlmHtml('<a href=\'https://example.com/?q="x\'>One</a>', {
        allowedHrefs: ['https://example.com/?q="x'],
      }),
    ).toBe('<a href="https://example.com/?q=%22x">One</a>');
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
