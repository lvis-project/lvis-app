import { describe, expect, it } from "vitest";

import { escapeHtml } from "../escape-html.js";

describe("escapeHtml", () => {
  it("escapes all four entities, so one function is safe in text and in a double-quoted attribute", () => {
    expect(escapeHtml('a & b <c> "d"')).toBe("a &amp; b &lt;c&gt; &quot;d&quot;");
  });

  it("escapes the ampersand first so already-escaped input is not double-decoded", () => {
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });

  it("closes an attribute-context escape with `>` too", () => {
    expect(escapeHtml('x"><script>')).toBe("x&quot;&gt;&lt;script&gt;");
  });
});
