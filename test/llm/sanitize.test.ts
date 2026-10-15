import { describe, expect, it } from "vitest";
import { plainTextOf, withoutUrls } from "../../src/llm/sanitize";

describe("plainTextOf", () => {
  it("returns a plain line as it is", () => {
    expect(plainTextOf("Something shipped.")).toBe("Something shipped.");
  });
  it("separates the words of adjacent blocks and line breaks", () => {
    expect(plainTextOf("<p>New SDK</p><p>Security fixes</p>")).toBe("New SDK Security fixes");
    expect(plainTextOf("One<br>Two<br/>Three")).toBe("One Two Three");
  });
  it("drops tags but keeps the text they wrapped", () => {
    expect(plainTextOf("<p>Hello <strong>world</strong></p>")).toBe("Hello world");
  });
  it("removes a script element along with its content", () => {
    expect(plainTextOf("a<script>alert(1)</script>b")).toBe("ab");
  });
  it("removes comments and code fences", () => {
    expect(plainTextOf("```html\n<!-- x -->Done\n```")).toBe("Done");
  });
  it("decodes entities so the renderer escapes them only once", () => {
    expect(plainTextOf("AT&amp;T &lt;3")).toBe("AT&T <3");
  });
  it("joins lines and collapses whitespace into single spaces", () => {
    expect(plainTextOf("  First.\n\n  Second.  ")).toBe("First. Second.");
  });
});

describe("withoutUrls", () => {
  it("drops http(s) urls and collapses the space they leave", () => {
    expect(withoutUrls("a https://example.com/x b http://example.com c")).toBe("a b c");
  });
  it("stops a url at the first non-ASCII character", () => {
    expect(withoutUrls("https://example.com/x参照")).toBe("参照");
  });
});
