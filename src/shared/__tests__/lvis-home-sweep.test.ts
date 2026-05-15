/**
 * Regression guard for issue #735 — every LVIS sub-path resolution must go
 * through `lvisHome()` so the `LVIS_HOME` env override (used by e2e
 * fixtures) is honored. Round 2 critic of PR #734 noted ~20 files were
 * bypassing the override; this test catches future regressions.
 *
 * The test uses a grep-style scan against the source tree rather than
 * importing modules and observing behavior, because some modules
 * resolve paths at module-load time (top-level constants), which would
 * already be evaluated by the time a test could set LVIS_HOME.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve as pathResolve } from "node:path";

const SRC_ROOT = pathResolve(__dirname, "../..");

// The single allowed location for direct homedir() + ".lvis" composition.
const ALLOWED_FILE = pathResolve(SRC_ROOT, "shared/lvis-home.ts");

// Patterns that flag violations:
// 1. Direct `(join|resolve|...)(homedir(), ".lvis", ...)` form
// 2. Template-literal `\`${homedir()}/.lvis...\`` form
// Plugin-side helpers that take a `home` parameter (e.g.
// `getDefaultAuditDir(home)` in permission-audit-runner) are intentionally
// NOT scanned here — they delegate the responsibility to the caller.
// Their callers must already use lvisHome().
const VIOLATION_PATTERNS: RegExp[] = [
  // join(homedir(), ".lvis", ...) / resolve / pathResolve / path.join / path.resolve
  /(?:join|resolve|pathResolve|path\.join|path\.resolve)\(\s*(?:os\.)?homedir\(\)\s*,\s*"\.lvis"/,
  // Template literal: `${homedir()}/.lvis...`
  /\$\{\s*(?:os\.)?homedir\(\)\s*\}\/\.lvis/,
];

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      // Skip test directories — temp dir patterns may legitimately compose
      // ~/.lvis paths for test scaffolding.
      if (entry === "__tests__" || entry === "node_modules") continue;
      walk(p, acc);
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      acc.push(p);
    }
  }
  return acc;
}

describe("issue #735 — homedir() + '.lvis' composition is centralized in lvisHome()", () => {
  it("no source file outside src/shared/lvis-home.ts composes ~/.lvis paths directly", () => {
    const files = walk(SRC_ROOT);
    const violations: Array<{ file: string; line: number; text: string }> = [];

    for (const file of files) {
      if (file === ALLOWED_FILE) continue;
      const content = readFileSync(file, "utf8");
      const lines = content.split("\n");
      lines.forEach((line, idx) => {
        if (VIOLATION_PATTERNS.some((rx) => rx.test(line))) {
          violations.push({ file, line: idx + 1, text: line.trim() });
        }
      });
    }

    if (violations.length > 0) {
      const msg = violations
        .map((v) => `  ${v.file}:${v.line}\n    ${v.text}`)
        .join("\n");
      throw new Error(
        `Found ${violations.length} files composing ~/.lvis paths directly via homedir(). ` +
          `Use lvisHome() from src/shared/lvis-home.ts instead so LVIS_HOME env override is honored.\n${msg}`,
      );
    }

    expect(violations).toEqual([]);
  });
});
