/**
 * PINNED AGREEMENT — the reviewer classifies the SAME path the invocation
 * pipeline resolves, inspects and writes.
 *
 * This file used to pin the opposite: a bug of record in which both sides read
 * the same `pathFields` declaration off the same finalized input (shared
 * selection: `shared/dotted-field-value.ts`) and then normalized the selected
 * values differently —
 *
 *   pipeline  `resolveToolPathForPermission` — expands a leading `~` to the
 *             home directory, resolves relative values against the INVOCATION
 *             cwd. This is the path Layer 1 scope-checks and the tool touches.
 *   reviewer  `canonicalizePathForMatch` — bare `path.resolve`, i.e. relative
 *             to `process.cwd()`, and a leading `~` surviving as a literal
 *             directory segment.
 *
 * The owner decision to align them has landed: `extractDeclaredPaths` now runs
 * the argument through `resolveToolPathForPermission` (moved to
 * `shared/tool-path-resolution.ts` so `permissions/` and `tools/pipeline/` can
 * share one authority) with a REQUIRED
 * `ToolInvocationContext.executionCwd`. Reviewer verdicts moved in BOTH
 * directions; which ones, and why that is intended, is pinned in
 * `permissions/__tests__/reviewer-path-resolution-alignment.test.ts`.
 *
 * These tests now assert AGREEMENT, and they still exist for the same reason:
 * anyone who "tidies up" either normalizer gets a red test and has to say what
 * they meant.
 *
 * `process.cwd` is stubbed rather than read, so agreement is demonstrated from
 * a chosen cwd instead of whatever the runner happens to sit in — and, more
 * importantly, so a reviewer that silently fell back to the ambient cwd would
 * be caught rather than accidentally matching.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { homedir } from "node:os";
import { resolve as pathResolve } from "node:path";

import { RuleBasedRiskClassifier } from "../risk-classifier.js";
import type { ToolInvocationContext } from "../risk-classifier.js";
import { extractTargetFilePaths } from "../../../tools/pipeline/path-extraction.js";
import { resolveToolPathForPermission } from "../../../shared/tool-path-resolution.js";
import { canonicalizePathForMatch } from "../../sensitive-paths.js";
import type { Tool } from "../../../tools/base.js";

const classifier = new RuleBasedRiskClassifier();

function writeContext(input: {
  declaredValue: string;
  executionCwd: string;
  allowedDirectories: readonly string[];
}): ToolInvocationContext {
  return {
    toolName: "write",
    category: "write",
    source: "model",
    pathFields: ["path"],
    finalInput: { path: input.declaredValue },
    executionCwd: input.executionCwd,
    allowedDirectories: [...input.allowedDirectories],
  } as unknown as ToolInvocationContext;
}

/** The path the pipeline hands to Layer 1 for this call, canonicalized. */
function pipelineTarget(declaredValue: string, invocationCwd: string): string {
  const [resolved] = extractTargetFilePaths(
    { pathFields: ["path"] } as unknown as Tool,
    { path: declaredValue },
    invocationCwd,
  );
  return canonicalizePathForMatch(resolved).toLowerCase();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("reviewer vs. pipeline: leading ~", () => {
  it("a ~ write to an UNALLOWED location classifies as out-of-scope, like Layer 1 sees it", () => {
    // The invocation cwd and process cwd are the project; only the project is
    // an allowed directory. `~/secret.txt` therefore lands OUTSIDE the scope.
    const projectRoot = pathResolve("/work/project");
    vi.spyOn(process, "cwd").mockReturnValue(projectRoot);
    const allowed = [canonicalizePathForMatch(projectRoot).toLowerCase()];

    // What the pipeline resolves — the path Layer 1 checks and the tool writes.
    expect(resolveToolPathForPermission("~/secret.txt", projectRoot)).toBe(
      pathResolve(homedir(), "secret.txt"),
    );
    // Classified on THAT path, the write is high.
    expect(
      classifier.classify(
        writeContext({
          declaredValue: pipelineTarget("~/secret.txt", projectRoot),
          executionCwd: projectRoot,
          allowedDirectories: allowed,
        }),
      ),
    ).toMatchObject({ level: "high", reason: "write outside allowed dirs" });

    // Classified on the RAW declared value — what the reviewer actually gets —
    // the verdict is now the SAME. Pre-alignment the literal `~` segment landed
    // under the project and this read `low` "write at allowed-dir leaf".
    expect(
      classifier.classify(
        writeContext({
          declaredValue: "~/secret.txt",
          executionCwd: projectRoot,
          allowedDirectories: allowed,
        }),
      ),
    ).toMatchObject({ level: "high", reason: "write outside allowed dirs" });
  });

  it("a ~ write to an ALLOWED location classifies at its true depth", () => {
    // Home is allowed and the invocation cwd sits well below it. `~/secret.txt`
    // is a direct leaf of the allowed root. Pre-alignment the literal `~`
    // segment appended to the cwd pushed it past the depth heuristic and it
    // read `medium` "write deep inside allowed".
    const deepCwd = pathResolve(homedir(), "a", "b", "c");
    vi.spyOn(process, "cwd").mockReturnValue(deepCwd);
    const allowed = [canonicalizePathForMatch(homedir()).toLowerCase()];

    expect(
      classifier.classify(
        writeContext({
          declaredValue: pipelineTarget("~/secret.txt", deepCwd),
          executionCwd: deepCwd,
          allowedDirectories: allowed,
        }),
      ),
    ).toMatchObject({ level: "low", reason: "write at allowed-dir leaf" });

    expect(
      classifier.classify(
        writeContext({
          declaredValue: "~/secret.txt",
          executionCwd: deepCwd,
          allowedDirectories: allowed,
        }),
      ),
    ).toMatchObject({ level: "low", reason: "write at allowed-dir leaf" });
  });
});

describe("reviewer vs. pipeline: relative values", () => {
  it("resolves a relative value against the invocation cwd, not process.cwd", () => {
    const invocationCwd = pathResolve("/work/project");
    const processCwd = pathResolve("/somewhere/else");
    vi.spyOn(process, "cwd").mockReturnValue(processCwd);

    // Pipeline: invocation cwd.
    expect(resolveToolPathForPermission("notes/x.md", invocationCwd)).toBe(
      pathResolve(invocationCwd, "notes/x.md"),
    );

    // Reviewer: same. Only the invocation cwd is allowed, so a
    // process.cwd-based resolution would read as out of scope.
    const allowed = [canonicalizePathForMatch(invocationCwd).toLowerCase()];
    expect(
      classifier.classify(
        writeContext({
          declaredValue: "notes/x.md",
          executionCwd: invocationCwd,
          allowedDirectories: allowed,
        }),
      ),
    ).toMatchObject({ level: "low" });

    // …and the process-cwd form really is outside that scope, so the assertion
    // above is capable of failing rather than passing for a trivial reason.
    expect(
      canonicalizePathForMatch(pathResolve(processCwd, "notes/x.md"))
        .toLowerCase()
        .startsWith(allowed[0]),
    ).toBe(false);
  });
});
