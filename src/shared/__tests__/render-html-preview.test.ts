import { describe, expect, it } from "vitest";
import {
  RENDER_HTML_PARTITION,
  wrapRenderHtmlDocument,
} from "../render-html-preview.js";

describe("render_html preview document wrapper", () => {
  it("exports the strict network-deny partition name", () => {
    expect(RENDER_HTML_PARTITION).toBe("lvis-render-html");
  });

  it("always emits the CSP meta as the first head child", () => {
    const wrapped = wrapRenderHtmlDocument(
      "<script>window.beforeCsp = true</script><head><title>Late head</title></head>",
      false,
    );

    expect(wrapped).toMatch(/^<!doctype html><html><head><meta http-equiv="Content-Security-Policy"/);
    expect(wrapped.indexOf("Content-Security-Policy")).toBeLessThan(wrapped.indexOf("window.beforeCsp"));
  });

  it("preserves normal body content inside the CSP-first shell", () => {
    const wrapped = wrapRenderHtmlDocument(
      "<!doctype html><html><head><title>Report</title></head><body><main>ok</main></body></html>",
      true,
    );

    expect(wrapped).toContain("<title>Report</title>");
    expect(wrapped).toContain("<body><main>ok</main></body>");
    expect(wrapped).toContain("script-src 'unsafe-inline' 'unsafe-eval'");
  });
});
