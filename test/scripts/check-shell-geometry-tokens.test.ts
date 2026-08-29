import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runGateScript } from "./gate-script-runner.js";

/**
 * The gate exists to catch drift between the `:root` pixel tokens in
 * styles.css and their TypeScript mirrors in shared/shell-geometry.ts. A gate
 * that cannot fail is worse than no gate — it reports OK forever — so each
 * test here drives a fixture tree that is wrong in one specific way and
 * asserts the script says so.
 */
const SCRIPT = resolve(process.cwd(), "scripts/check-shell-geometry-tokens.mjs");
const roots: string[] = [];

function write(root: string, rel: string, source: string): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source, "utf-8");
}

function css(gap: string, gapTight: string): string {
  return `@layer base {\n  :root {\n    --chrome-band-height: 36px;\n    --chrome-gap: ${gap};\n    --chrome-gap-tight: ${gapTight};\n  }\n  :root {\n    --shell-card-inset: var(--chrome-gap);\n  }\n}\n`;
}

function ts(gutter: string, gapTight: string): string {
  return `export const CHROME_GAP_TIGHT = ${gapTight};\nexport const SHELL_GUTTER = ${gutter};\n`;
}

function runGate(root: string) {
  return runGateScript(SCRIPT, root);
}

function createRoot(cssSource: string, tsSource: string): string {
  const root = mkdtempSync(join(tmpdir(), "lvis-shell-geometry-"));
  roots.push(root);
  write(root, "src/styles.css", cssSource);
  write(root, "src/shared/shell-geometry.ts", tsSource);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("check-shell-geometry-tokens", () => {
  it("accepts a stylesheet and a module that agree", () => {
    const result = runGate(createRoot(css("8px", "4px"), ts("8", "4")));

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[shell-geometry-tokens] OK pairs=2");
  });

  it("rejects a token the module no longer matches", () => {
    const result = runGate(createRoot(css("10px", "4px"), ts("8", "4")));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--chrome-gap is 10px");
    expect(result.stderr).toContain("SHELL_GUTTER is 8");
  });

  it("rejects a constant the stylesheet no longer matches", () => {
    const result = runGate(createRoot(css("8px", "4px"), ts("8", "6")));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--chrome-gap-tight is 4px");
    expect(result.stderr).toContain("CHROME_GAP_TIGHT is 6");
  });

  it("fails closed when the CSS token is gone rather than reporting nothing to compare", () => {
    const result = runGate(createRoot("@layer base {\n  :root {\n    --chrome-gap-tight: 4px;\n  }\n}\n", ts("8", "4")));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--chrome-gap: no px declaration found");
  });

  it("fails closed when the TypeScript mirror is gone", () => {
    const result = runGate(createRoot(css("8px", "4px"), "export const CHROME_GAP_TIGHT = 4;\n"));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("SHELL_GUTTER: no numeric `export const` found");
  });

  it("rejects a token declared twice with two different values", () => {
    const twice = css("8px", "4px").replace("--shell-card-inset: var(--chrome-gap);", "--chrome-gap: 12px;");
    const result = runGate(createRoot(twice, ts("8", "4")));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("declared more than once with different values");
  });

  it("fails when a mirror file is missing entirely", () => {
    const root = mkdtempSync(join(tmpdir(), "lvis-shell-geometry-"));
    roots.push(root);
    write(root, "src/styles.css", css("8px", "4px"));

    const result = runGate(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cannot read a mirror side");
  });
});
