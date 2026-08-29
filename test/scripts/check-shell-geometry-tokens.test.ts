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
 *
 * The commented-out cases are regressions, not hypotheticals: the first
 * version of this gate matched inside `/* … *\/`, so commenting a token out
 * read as OK and a historical value in a docstring read as a mismatch.
 */
const SCRIPT = resolve(process.cwd(), "scripts/check-shell-geometry-tokens.mjs");
const roots: string[] = [];

function write(root: string, rel: string, source: string): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source, "utf-8");
}

function css(gap: string, gapTight: string, cardInset = "var(--chrome-gap)"): string {
  return `@layer base {\n  :root {\n    --chrome-band-height: 36px;\n    --chrome-gap: ${gap};\n    --chrome-gap-tight: ${gapTight};\n  }\n  :root {\n    --shell-card-inset: ${cardInset};\n    --shell-collapsed-rail-reserve: 64px;\n  }\n}\n`;
}

function ts(gutter: string, gapTight: string): string {
  return `export const CHROME_GAP_TIGHT = ${gapTight};\nexport const SHELL_GUTTER = ${gutter};\nexport const COLLAPSED_RAIL_RESERVE = 64;\n`;
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
    const result = runGateScript(SCRIPT, createRoot(css("8px", "4px"), ts("8", "4")));

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[shell-geometry-tokens] OK pairs=4");
  });

  it("rejects a token the module no longer matches", () => {
    const result = runGateScript(SCRIPT, createRoot(css("10px", "4px"), ts("8", "4")));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--chrome-gap is 10px");
    expect(result.stderr).toContain("SHELL_GUTTER is 8");
  });

  it("rejects a constant the stylesheet no longer matches", () => {
    const result = runGateScript(SCRIPT, createRoot(css("8px", "4px"), ts("8", "6")));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--chrome-gap-tight is 4px");
    expect(result.stderr).toContain("CHROME_GAP_TIGHT is 6");
  });

  it("fails closed when the CSS token is gone rather than reporting nothing to compare", () => {
    const result = runGateScript(SCRIPT, createRoot("@layer base {\n  :root {\n    --chrome-gap-tight: 4px;\n  }\n}\n", ts("8", "4")));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--chrome-gap: not declared");
  });

  it("fails closed when the TypeScript mirror is gone", () => {
    const result = runGateScript(SCRIPT, createRoot(css("8px", "4px"), "export const CHROME_GAP_TIGHT = 4;\n"));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("SHELL_GUTTER: no numeric `export const` found");
  });

  it("rejects a token declared twice with two different values", () => {
    const twice = css("8px", "4px").replace("--chrome-band-height: 36px;", "--chrome-gap: 12px;");
    const result = runGateScript(SCRIPT, createRoot(twice, ts("8", "4")));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("declared more than once with different values");
  });

  it("rejects a constant defined twice", () => {
    const result = runGateScript(SCRIPT, createRoot(css("8px", "4px"), `${ts("8", "4")}export const SHELL_GUTTER = 9;\n`));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("SHELL_GUTTER: defined 2 times");
  });

  it("fails when a mirror file is missing entirely", () => {
    const root = mkdtempSync(join(tmpdir(), "lvis-shell-geometry-"));
    roots.push(root);
    write(root, "src/styles.css", css("8px", "4px"));

    const result = runGateScript(SCRIPT, root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cannot read a mirror side");
  });

  // ── comments are not declarations ────────────────────────────────────────
  it("does not accept a commented-out token as a live declaration", () => {
    const commented = css("8px", "4px").replace("--chrome-gap: 8px;", "/* --chrome-gap: 8px; */");
    const result = runGateScript(SCRIPT, createRoot(commented, ts("8", "4")));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--chrome-gap: not declared");
    expect(result.stderr).toContain("a commented-out declaration does not count");
  });

  it("ignores a historical value quoted in a docstring above the real constant", () => {
    const withHistory = `/** was: export const SHELL_GUTTER = 99; */\n${ts("8", "4")}`;
    const result = runGateScript(SCRIPT, createRoot(css("8px", "4px"), withHistory));

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[shell-geometry-tokens] OK pairs=4");
  });

  it("ignores a commented-out constant above the real one", () => {
    const withDeadCode = `// export const SHELL_GUTTER = 99;\n${ts("8", "4")}`;
    const result = runGateScript(SCRIPT, createRoot(css("8px", "4px"), withDeadCode));

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[shell-geometry-tokens] OK pairs=4");
  });

  // ── one level of var() alias ─────────────────────────────────────────────
  it("resolves a token written as a var() alias", () => {
    const result = runGateScript(SCRIPT, createRoot(css("8px", "4px", "var(--chrome-gap)"), ts("8", "4")));

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("OK pairs=4");
  });

  it("rejects an alias redefined as a literal that disagrees with the constant", () => {
    const result = runGateScript(SCRIPT, createRoot(css("8px", "4px", "9px"), ts("8", "4")));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--shell-card-inset is 9px");
    expect(result.stderr).toContain("SHELL_GUTTER is 8");
  });

  it("fails closed on an alias pointing at a token that does not exist", () => {
    const result = runGateScript(SCRIPT, createRoot(css("8px", "4px", "var(--nope)"), ts("8", "4")));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("aliases --nope, which does not resolve");
  });

  // ── value shapes ─────────────────────────────────────────────────────────
  it("reads through !important and a missing final semicolon", () => {
    const awkward = ":root{\n  --chrome-gap-tight: 4px;\n  --shell-card-inset: var(--chrome-gap);\n  --shell-collapsed-rail-reserve: 64px;\n  --chrome-gap: 8px !important\n}\n";
    const result = runGateScript(SCRIPT, createRoot(awkward, ts("8", "4")));

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("OK pairs=4");
  });

  it("fails on a mirrored token whose value is a calc() it cannot reduce", () => {
    const result = runGateScript(SCRIPT, createRoot(css("calc(4px * 2)", "4px"), ts("8", "4")));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("neither a px literal nor a single-level var() alias");
  });

  it("rejects `--root` with no directory after it", () => {
    const result = runGateScript(SCRIPT, "--other-flag");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("`--root` needs a directory");
  });
});
