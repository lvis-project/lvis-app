/**
 * Regression guard — `app.whenReady().then(() => void main())` MUST live
 * inside the `if (gotSingleInstanceLock)` else-branch of `src/main.ts`.
 *
 * Failure mode this catches (issue surfaced during marketplace plugin
 * install): a second LVIS instance launched via the `lvis://` protocol fails
 * `requestSingleInstanceLock()`, calls `app.quit()`, but if `whenReady` is
 * unconditional the doomed process still runs `main()` → `bootstrap()` →
 * `log.info("boot: starting...")`. The `pino-pretty` transport spawned a
 * thread-stream worker that exits with the process, and the still-pending
 * write throws "the worker has exited" — Electron surfaces an
 * uncaught-exception dialog to the user even though the install itself
 * succeeded via the primary instance's `second-instance` handler.
 *
 * The fix is structural: do not run `main()` in the second-instance branch.
 * We assert that property by source inspection rather than runtime simulation
 * because `main.ts` is the entry point — it registers electron event
 * listeners at module load and cannot be imported in a unit test context.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("main.ts — single-instance gate on app.whenReady", () => {
  const source = readFileSync("src/main.ts", "utf-8").replace(/\r\n/g, "\n");

  /** Slice `if (...) { ... } else { ... }` body for the single-instance branch. */
  function extractSingleInstanceElseBlock(text: string): string | null {
    const m = text.match(/if\s*\(\s*!gotSingleInstanceLock\s*\)\s*\{[\s\S]*?\}\s*else\s*\{/);
    if (!m || m.index === undefined) return null;
    const elseOpen = m.index + m[0].length - 1; // position of '{'
    let depth = 1;
    let i = elseOpen + 1;
    while (i < text.length && depth > 0) {
      const ch = text[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      i++;
    }
    return depth === 0 ? text.slice(elseOpen + 1, i - 1) : null;
  }

  it("exactly one `app.whenReady().then` call exists in the file", () => {
    const matches = source.match(/app\.whenReady\s*\(\s*\)\s*\.\s*then\s*\(/g) ?? [];
    expect(matches.length, "main.ts must register whenReady().then exactly once").toBe(1);
  });

  it("`app.whenReady().then` runs inside the primary-instance else block", () => {
    const elseBlock = extractSingleInstanceElseBlock(source);
    expect(elseBlock, "could not locate the `else` block following `if (!gotSingleInstanceLock)`").not.toBeNull();
    expect(elseBlock!).toMatch(/app\.whenReady\s*\(\s*\)\s*\.\s*then\s*\(/);
  });

  it("`app.quit()` runs immediately in the second-instance branch (no main() call)", () => {
    // The negative-branch body (between `if (!gotSingleInstanceLock) {` and
    // its closing `}`) must contain `app.quit()` and must NOT bootstrap.
    // Strip line + block comments first so explanatory prose mentioning
    // `main()` or `whenReady` does not produce false positives.
    const m = source.match(/if\s*\(\s*!gotSingleInstanceLock\s*\)\s*\{([\s\S]*?)\}\s*else\s*\{/);
    expect(m, "single-instance lock check missing").not.toBeNull();
    const negBranchCode = m![1]!
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    expect(negBranchCode).toMatch(/app\.quit\s*\(\s*\)/);
    expect(negBranchCode, "second-instance must not bootstrap").not.toMatch(/\bmain\s*\(\s*\)/);
    expect(negBranchCode, "second-instance must not call whenReady").not.toMatch(/whenReady/);
  });
});
