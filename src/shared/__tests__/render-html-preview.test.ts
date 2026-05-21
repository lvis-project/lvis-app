import { describe, expect, it } from "vitest";
import {
  buildRenderHtmlPreviewShell,
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

  it("injects LVIS theme tokens before user head content", () => {
    const wrapped = wrapRenderHtmlDocument(
      "<head><style>main{color:hsl(var(--primary));}</style></head><body><main>ok</main></body>",
      false,
      { primary: "340 80% 70%", background: "0 0% 98%" },
    );

    expect(wrapped.indexOf("Content-Security-Policy")).toBeLessThan(wrapped.indexOf("lvis-render-html-theme"));
    expect(wrapped.indexOf("lvis-render-html-theme")).toBeLessThan(wrapped.indexOf("main{color"));
    expect(wrapped).toContain("--primary:340 80% 70%;");
    expect(wrapped).toContain("--background:0 0% 98%;");
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

  it("builds a host-owned preview shell with an in-window JavaScript toggle", () => {
    const shell = buildRenderHtmlPreviewShell({
      html: "<script>window.beforeCsp = true</script><main>ok</main>",
      title: "Scripted report",
      allowScripts: false,
      requiresScripts: true,
      warnings: ["removed <iframe>"],
      themeTokens: { primary: "340 80% 70%" },
    });

    expect(shell).toMatch(/^<!doctype html><html><head><meta http-equiv="Content-Security-Policy"/);
    expect(shell).toContain("data-render-html-frame");
    expect(shell).toContain("data-render-html-script-toggle");
    expect(shell).toContain("JavaScript");
    expect(shell).toContain("removed &lt;iframe&gt;");
    expect(shell).toContain("--primary:340 80% 70%;");
    expect(shell).not.toContain("<script>window.beforeCsp = true</script>");
  });
});
