/**
 * render_html unit tests — guards for security-sensitive sanitize + wrap
 * behavior so regressions in the CSP / strip list fail loudly.
 */
import { describe, it, expect } from "vitest";
import {
  createRenderHtmlTool,
  sanitizeHtml,
  wrapWithCsp,
  MAX_HTML_BYTES,
  DEFAULT_HEIGHT,
  MAX_HEIGHT,
  MIN_HEIGHT,
} from "../render-html.js";
import type { RenderHtmlResult } from "../render-html.js";

const emptyCtx = {} as never;

async function runRenderHtml(input: unknown): Promise<{
  output: string;
  isError?: boolean;
}> {
  const tool = createRenderHtmlTool();
  return tool.execute(input, emptyCtx);
}

function parseOk(output: string): RenderHtmlResult {
  const parsed = JSON.parse(output);
  expect(parsed.kind).toBe("lvis.render_html");
  return parsed as RenderHtmlResult;
}

describe("sanitizeHtml", () => {
  it("strips <iframe>, <object>, <embed>, <frame>, <frameset>", () => {
    const src =
      `<div>ok</div>` +
      `<iframe src="x"></iframe>` +
      `<object data="x"></object>` +
      `<embed src="x">` +
      `<frame src="x">` +
      `<frameset><frame></frameset>`;
    const { sanitized, warnings } = sanitizeHtml(src);
    expect(sanitized).not.toMatch(/<iframe/i);
    expect(sanitized).not.toMatch(/<object/i);
    expect(sanitized).not.toMatch(/<embed/i);
    expect(sanitized).not.toMatch(/<frame/i);
    expect(sanitized).not.toMatch(/<frameset/i);
    expect(sanitized).toContain("<div>ok</div>");
    expect(warnings).toEqual(
      expect.arrayContaining([
        "removed <iframe>",
        "removed <object>",
        "removed <embed>",
        "removed <frame>",
      ]),
    );
  });

  it("strips <meta http-equiv=refresh>", () => {
    const { sanitized, warnings } = sanitizeHtml(
      `<meta http-equiv="refresh" content="0;url=https://x"><p>body</p>`,
    );
    expect(sanitized).not.toMatch(/refresh/i);
    expect(sanitized).toContain("<p>body</p>");
    expect(warnings).toContain("removed <meta refresh>");
  });

  it("strips src= from <script> but preserves the tag body", () => {
    const { sanitized, warnings } = sanitizeHtml(
      `<script src="https://cdn.example.com/lib.js">console.log("keep me")</script>`,
    );
    expect(sanitized).not.toMatch(/src\s*=/);
    expect(sanitized).toContain("<script");
    expect(sanitized).toContain('console.log("keep me")');
    expect(warnings).toContain("removed <script src>");
  });

  it("preserves inline <script> and on* event handlers", () => {
    const src =
      `<button onclick="doThing()">click</button>` +
      `<script>function doThing(){ alert(1); }</script>`;
    const { sanitized, warnings } = sanitizeHtml(src);
    expect(sanitized).toContain(`onclick="doThing()"`);
    expect(sanitized).toContain("<script>function doThing()");
    expect(warnings).toEqual([]);
  });

  it("strips <a href> pointing to external / relative URLs but keeps fragment links", () => {
    const src =
      `<a href="https://evil.example.com">click</a>` +
      `<a href="/abs">abs</a>` +
      `<a href="rel.html">rel</a>` +
      `<a href="javascript:alert(1)">js</a>` +
      `<a href="#top">top</a>`;
    const { sanitized, warnings } = sanitizeHtml(src);
    expect(sanitized).not.toMatch(/href="https:/);
    expect(sanitized).not.toMatch(/href="\/abs/);
    expect(sanitized).not.toMatch(/href="rel\.html/);
    expect(sanitized).not.toMatch(/href="javascript:/);
    // Fragment-only href is allowed.
    expect(sanitized).toContain(`href="#top"`);
    expect(warnings).toContain("removed <a href>");
  });

  it("returns empty warnings for benign HTML", () => {
    const { sanitized, warnings } = sanitizeHtml(
      `<h1>hi</h1><p style="color:red">hello</p>`,
    );
    expect(sanitized).toContain("<h1>hi</h1>");
    expect(warnings).toEqual([]);
  });
});

describe("wrapWithCsp", () => {
  it("emits a <!doctype html> wrapper with a strict CSP meta tag", () => {
    const out = wrapWithCsp(`<p>hi</p>`);
    expect(out.toLowerCase()).toContain("<!doctype html>");
    expect(out).toMatch(
      /<meta\s+http-equiv="Content-Security-Policy"\s+content="[^"]*default-src 'none'/,
    );
    expect(out).toContain("script-src 'unsafe-inline' 'unsafe-eval'");
    expect(out).toContain("form-action 'none'");
    expect(out).toContain("<p>hi</p>");
  });

  it("html-escapes the title", () => {
    const out = wrapWithCsp("<p>body</p>", `<script>`);
    expect(out).toContain("<title>&lt;script&gt;</title>");
  });
});

describe("createRenderHtmlTool.execute", () => {
  it("describes LVIS theme-token usage for generated pages", () => {
    const tool = createRenderHtmlTool();

    expect(tool.description).toContain("현재 LVIS 앱 테마 색상");
    expect(tool.description).toContain("hsl(var(--primary))");
    expect(JSON.stringify(tool.toJsonSchema())).toContain("--background");
  });

  it("returns an isError result when html is empty/whitespace", async () => {
    const r = await runRenderHtml({ html: "   " });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.output).error).toMatch(/html is required/);
  });

  it("rejects html larger than MAX_HTML_BYTES", async () => {
    const big = "a".repeat(MAX_HTML_BYTES + 1);
    const r = await runRenderHtml({ html: big });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.output).error).toMatch(/html too large/);
  });

  it("clamps height to [MIN_HEIGHT, MAX_HEIGHT] and falls back to DEFAULT on non-finite input", async () => {
    const tiny = parseOk((await runRenderHtml({ html: "<p>x</p>", height: 1 })).output);
    expect(tiny.height).toBe(MIN_HEIGHT);

    const huge = parseOk((await runRenderHtml({ html: "<p>x</p>", height: 999999 })).output);
    expect(huge.height).toBe(MAX_HEIGHT);

    const nan = parseOk((await runRenderHtml({ html: "<p>x</p>", height: Number.NaN })).output);
    expect(nan.height).toBe(DEFAULT_HEIGHT);

    const inf = parseOk((await runRenderHtml({ html: "<p>x</p>", height: Infinity })).output);
    expect(inf.height).toBe(DEFAULT_HEIGHT);

    const missing = parseOk((await runRenderHtml({ html: "<p>x</p>" })).output);
    expect(missing.height).toBe(DEFAULT_HEIGHT);
  });

  it("truncates title to 60 chars", async () => {
    const long = "가".repeat(120);
    const r = parseOk((await runRenderHtml({ html: "<p>x</p>", title: long })).output);
    expect(r.title?.length).toBe(60);
  });

  it("surfaces sanitizer warnings in the payload", async () => {
    const r = parseOk(
      (await runRenderHtml({
        html: `<iframe src="x"></iframe><a href="https://x">k</a><p>keep</p>`,
      })).output,
    );
    expect(r.warnings).toEqual(
      expect.arrayContaining(["removed <iframe>", "removed <a href>"]),
    );
    expect(r.html).toContain("<p>keep</p>");
    expect(r.html).not.toMatch(/<iframe/i);
  });

  it("wraps sanitized body with CSP and marks kind = lvis.render_html", async () => {
    const r = parseOk((await runRenderHtml({ html: "<p>hi</p>" })).output);
    expect(r.kind).toBe("lvis.render_html");
    expect(r.html).toContain("Content-Security-Policy");
    expect(r.html).toContain("<p>hi</p>");
    // inline scripts + event handlers are preserved end-to-end
    const scripted = parseOk(
      (await runRenderHtml({
        html: `<button onclick="doThing()">go</button><script>function doThing(){}</script>`,
      })).output,
    );
    expect(scripted.html).toContain(`onclick="doThing()"`);
    expect(scripted.html).toContain("<script>function doThing(){}</script>");
  });
});
