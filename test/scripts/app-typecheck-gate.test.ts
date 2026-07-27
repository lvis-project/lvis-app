import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  APP_TYPECHECK_GATE_SCRIPTS,
  APP_TYPECHECK_TEST_RATCHET_SCRIPTS,
  getMissingPackageScripts,
} from "../../scripts/hooks/app-typecheck-gate.mjs";

function functionSegment(source: string, start: string, end: string) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe("app typecheck pre-push gate", () => {
  it("runs the test-typecheck self-test and ratchet immediately after typecheck", () => {
    expect(APP_TYPECHECK_TEST_RATCHET_SCRIPTS).toEqual([
      "check:typecheck-tests:self-test",
      "check:typecheck-tests",
    ]);
    expect(APP_TYPECHECK_GATE_SCRIPTS).toEqual([
      "typecheck",
      ...APP_TYPECHECK_TEST_RATCHET_SCRIPTS,
    ]);
  });

  it("reports every missing required gate script instead of skipping it", () => {
    expect(
      getMissingPackageScripts(APP_TYPECHECK_GATE_SCRIPTS, (scriptName) => (
        scriptName === "typecheck"
      )),
    ).toEqual(APP_TYPECHECK_TEST_RATCHET_SCRIPTS);
    expect(
      getMissingPackageScripts(APP_TYPECHECK_GATE_SCRIPTS, () => true),
    ).toEqual([]);
  });

  it("uses the shared gate in full, targeted-test, and comment-only paths", () => {
    const runner = readFileSync(
      resolve("scripts/hooks/run-local-checks.mjs"),
      "utf8",
    );
    expect(runner).toContain('from "./app-typecheck-gate.mjs"');

    expect(
      functionSegment(
        runner,
        "function runAppChecks(dir) {",
        "function runAppTargetedVitestChecks",
      ),
    ).toContain("runAppTypecheckGate(dir,");
    expect(
      functionSegment(
        runner,
        "function runAppTargetedVitestChecks",
        "function runAppCommentOnlyChecks",
      ),
    ).toContain("runAppTypecheckGate(dir,");
    expect(
      functionSegment(
        runner,
        "function runAppCommentOnlyChecks",
        "// Dispatch",
      ),
    ).toContain("runAppTypecheckGate(dir,");
  });
});
