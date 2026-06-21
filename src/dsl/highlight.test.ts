import { describe, it, expect } from "vitest";
import { highlightScript, formatScript } from "./highlight";

describe("highlightScript", () => {
  it("wraps currencies, flow/condition keywords, strings, numbers, comments", () => {
    const html = highlightScript('# note\nwhile not has 2 prefix "x" { exalt }');
    expect(html).toContain('<span class="tok-comment"># note</span>');
    expect(html).toContain('<span class="tok-flow">while</span>');
    expect(html).toContain('<span class="tok-cond">has</span>');
    expect(html).toContain('<span class="tok-currency">exalt</span>');
    expect(html).toContain('<span class="tok-string">"x"</span>');
    expect(html).toContain('<span class="tok-number">2</span>');
  });

  it("escapes html angle brackets", () => {
    expect(highlightScript("a < b")).toContain("&lt;");
    expect(highlightScript("has tier <= 2")).toContain("&lt;=");
  });
});

describe("formatScript", () => {
  it("re-indents by brace depth", () => {
    const messy = `compare full {
option "a" {
exalt
}
}`;
    expect(formatScript(messy)).toBe(
      ['compare full {', '  option "a" {', "    exalt", "  }", "}"].join("\n")
    );
  });

  it("leaves single-line blocks at one level and preserves blank lines", () => {
    const src = "alchemy\n\nwhile open prefix { exalt }";
    expect(formatScript(src)).toBe("alchemy\n\nwhile open prefix { exalt }");
  });

  it("dedents a closing brace that shares a line with an opener", () => {
    const src = "if x {\na\n} else {\nb\n}";
    expect(formatScript(src)).toBe(
      ["if x {", "  a", "} else {", "  b", "}"].join("\n")
    );
  });
});
