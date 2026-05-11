/**
 * Theme system v2 — visual snapshot for migrated shared components.
 *
 * Asserts that components emit the SAME markup regardless of active bundle —
 * they consume semantic tokens (bg-background, text-foreground) and the actual
 * color comes from CSS variable swap on <html data-theme-bundle>.
 */
import "../../../../test/renderer/setup.js";
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Button } from "../../../components/ui/button.js";
import { Input } from "../../../components/ui/input.js";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/card.js";
import { ThemeProvider } from "../theme/ThemeProvider.js";

function renderInBundle(bundleId: string, node: JSX.Element) {
  document.documentElement.removeAttribute("data-theme-bundle");
  document.documentElement.removeAttribute("data-shell");
  const result = render(<ThemeProvider initialBundleId={bundleId}>{node}</ThemeProvider>);
  return {
    html: result.container.innerHTML,
    rootBundle: document.documentElement.getAttribute("data-theme-bundle"),
    cleanup: () => result.unmount(),
  };
}

describe("Theme snapshots — semantic-token components are bundle-invariant", () => {
  it("Button (primary) renders identical markup in tokyo-night vs forest", () => {
    const dark = renderInBundle("tokyo-night", <Button>Click</Button>);
    expect(dark.rootBundle).toBe("tokyo-night");
    dark.cleanup();
    const light = renderInBundle("forest", <Button>Click</Button>);
    expect(light.rootBundle).toBe("forest");
    expect(light.html).toBe(dark.html);
    light.cleanup();
  });

  it("Button variants still emit bundle-agnostic class strings", () => {
    for (const variant of ["default", "destructive", "outline", "secondary", "ghost"] as const) {
      const dark = renderInBundle("tokyo-night", <Button variant={variant}>x</Button>);
      dark.cleanup();
      const light = renderInBundle("forest", <Button variant={variant}>x</Button>);
      expect(light.html, `variant=${variant} differs between bundles`).toBe(dark.html);
      light.cleanup();
    }
  });

  it("Input is bundle-invariant", () => {
    const dark = renderInBundle("tokyo-night", <Input placeholder="search" />);
    dark.cleanup();
    const light = renderInBundle("forest", <Input placeholder="search" />);
    expect(light.html).toBe(dark.html);
    light.cleanup();
  });

  it("Card composition is bundle-invariant", () => {
    const tree = (
      <Card>
        <CardHeader><CardTitle>Title</CardTitle></CardHeader>
        <CardContent>Body</CardContent>
      </Card>
    );
    const dark = renderInBundle("tokyo-night", tree);
    dark.cleanup();
    const light = renderInBundle("forest", tree);
    expect(light.html).toBe(dark.html);
    light.cleanup();
  });

  it("Button does NOT include any theme-literal Tailwind palette utilities", () => {
    const { html, cleanup } = renderInBundle("tokyo-night", <Button>x</Button>);
    expect(html).not.toMatch(/\bbg-slate-\d+\b/);
    expect(html).not.toMatch(/\bbg-zinc-\d+\b/);
    expect(html).not.toMatch(/\bbg-gray-\d+\b/);
    expect(html).not.toMatch(/\btext-white\b/);
    expect(html).not.toMatch(/\btext-black\b/);
    /* Opacity-variant black/white classes — caught the original modal backdrop
       regression where `bg-black/50` looked correct in tokyo-night but became
       invisible in forest/lge-light. The base rule (bare bg-white/bg-black)
       was already covered; this extends it to include /N variants. */
    expect(html).not.toMatch(/\bbg-(black|white)\/\d+\b/);
    expect(html).not.toMatch(/\bhover:bg-(black|white)\/\d+\b/);
    cleanup();
  });
});

/* Source-level forbidden-pattern audit — scans every renderer .tsx/.ts file
   for raw Tailwind palette utilities, opacity-variant black/white, and inline
   raw color literals. Acts as a tripwire for new violations introduced by
   future feature work — much faster than a Playwright per-bundle screenshot
   sweep and catches the problem before it reaches a theme. */
describe("Renderer source has no hardcoded color escapes", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const { join, resolve } = await import("node:path");

  /** Files where palette literals are intentional (theme definitions, brand SVG). */
  const ALLOW = [
    "theme/bundles/",
    "__tests__/",
    "components/LvisLogo.tsx",   /* brand gradient — not theme-bound */
    "test/",
  ];

  async function walk(dir: string): Promise<string[]> {
    const out: string[] = [];
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".git") continue;
        out.push(...await walk(p));
      } else if (e.isFile() && (p.endsWith(".tsx") || p.endsWith(".ts"))) {
        out.push(p);
      }
    }
    return out;
  }

  /* vitest is invoked from the project root via package.json scripts —
     `process.cwd()` is the contract. */
  const RENDERER_ROOT = resolve(process.cwd(), "src/ui/renderer");
  const FORBIDDEN_TAILWIND_PALETTE =
    /\b(?:text|bg|fill|border|ring|stroke|hover:bg|hover:text|hover:border|dark:text|dark:bg)-(?:red|green|yellow|blue|purple|pink|amber|emerald|rose|orange|indigo|violet|fuchsia|cyan|teal|sky|lime|stone|gray|slate|zinc|neutral)-(?:50|100|200|300|400|500|600|700|800|900|950)\b/;
  const FORBIDDEN_BLACK_WHITE = /\b(?:bg|text|border|ring|fill|hover:bg|hover:text|hover:border)-(?:black|white)(?:\/\d+)?\b/;
  const FORBIDDEN_HEX_LITERAL = /["'`]#[0-9a-fA-F]{3,8}["'`]/;

  it("no Tailwind palette utilities outside bundle TS / tests", async () => {
    const files = await walk(RENDERER_ROOT);
    const violations: string[] = [];
    for (const file of files) {
      if (ALLOW.some((a) => file.includes(a))) continue;
      const content = await readFile(file, "utf8");
      // Strip line/block comments before scanning so issue refs like
      // "#260" inside `// Issue #260` don't false-positive. We strip /* … */
      // first, then // comments, conservatively (string literals
      // containing "//" are rare in this codebase and excluded by the file
      // walker for now).
      const stripped = content
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
      const lines = stripped.split("\n");
      lines.forEach((line, i) => {
        if (FORBIDDEN_TAILWIND_PALETTE.test(line)) {
          violations.push(`${file}:${i + 1} palette → ${line.trim().slice(0, 100)}`);
        }
        if (FORBIDDEN_BLACK_WHITE.test(line)) {
          violations.push(`${file}:${i + 1} black/white → ${line.trim().slice(0, 100)}`);
        }
      });
    }
    expect(violations, violations.slice(0, 10).join("\n")).toEqual([]);
  });

  it("no inline hex color literals in renderer .tsx files (excluding brand SVG)", async () => {
    const files = (await walk(RENDERER_ROOT)).filter((f) => f.endsWith(".tsx"));
    const violations: string[] = [];
    for (const file of files) {
      if (ALLOW.some((a) => file.includes(a))) continue;
      const content = await readFile(file, "utf8");
      const stripped = content
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
      const lines = stripped.split("\n");
      lines.forEach((line, i) => {
        if (FORBIDDEN_HEX_LITERAL.test(line)) {
          violations.push(`${file}:${i + 1} hex → ${line.trim().slice(0, 100)}`);
        }
      });
    }
    expect(violations, violations.slice(0, 10).join("\n")).toEqual([]);
  });
});
