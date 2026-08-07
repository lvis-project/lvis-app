/**
 * PINNED KNOWN DIVERGENCE — the reviewer classifies a different path than the
 * one the invocation pipeline resolves, inspects and writes.
 *
 * Both sides read the same `pathFields` declaration off the same finalized
 * input (shared selection: `shared/dotted-field-value.ts`). They then normalize
 * the selected values differently:
 *
 *   pipeline  `resolveToolPathForPermission` — expands a leading `~` to the
 *             home directory, resolves relative values against the INVOCATION
 *             cwd. This is the path Layer 1 scope-checks and the tool touches.
 *   reviewer  `canonicalizePathForMatch` — bare `path.resolve`, i.e. relative
 *             to `process.cwd()`, and a leading `~` survives as a literal
 *             directory segment.
 *
 * These tests assert the CURRENT behaviour, which is a bug of record, not a
 * design: aligning the two changes reviewer verdicts and needs an owner
 * decision. They exist so that change cannot happen silently — anyone who
 * "tidies up" either normalizer gets a red test and has to say what they meant.
 *
 * `process.cwd` is stubbed rather than read, so the divergence is demonstrated
 * from a chosen cwd instead of whatever the runner happens to sit in.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { homedir } from "node:os";
import { resolve as pathResolve } from "node:path";

import { RuleBasedRiskClassifier } from "../risk-classifier.js";
import type { ToolInvocationContext } from "../risk-classifier.js";
import {
  extractTargetFilePaths,
  resolveToolPathForPermission,
} from "../../../tools/pipeline/path-extraction.js";
import { canonicalizePathForMatch } from "../../sensitive-paths.js";
import type { Tool } from "../../../tools/base.js";

const classifier = new RuleBasedRiskClassifier();

function writeContext(input: {
  declaredValue: string;
  allowedDirectories: readonly string[];
}): ToolInvocationContext {
  return {
    toolName: "write",
    category: "write",
    source: "model",
    pathFields: ["path"],
    finalInput: { path: input.declaredValue },
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
  it("classifies a ~ write to an UNALLOWED location as if it were allowed", () => {
    // The invocation cwd and process cwd are the project; only the project is
    // an allowed directory. `~/secret.txt` therefore lands OUTSIDE the scope.
    const projectRoot = pathResolve("/work/project");
    vi.spyOn(process, "cwd").mockReturnValue(projectRoot);
    const allowed = [canonicalizePathForMatch(projectRoot).toLowerCase()];

    // What the pipeline resolves — the path Layer 1 checks and the tool writes.
    expect(resolveToolPathForPermission("~/secret.txt", projectRoot)).toBe(
      pathResolve(homedir(), "secret.txt"),
    );
    // Classified on THAT path, the write is correctly high.
    expect(
      classifier.classify(
        writeContext({
          declaredValue: pipelineTarget("~/secret.txt", projectRoot),
          allowedDirectories: allowed,
        }),
      ),
    ).toMatchObject({ level: "high", reason: "write outside allowed dirs" });

    // Classified on the RAW declared value — what the reviewer actually does —
    // `~` becomes a literal segment under the project, so the same call reads
    // as an in-scope leaf write. This is the divergence.
    expect(
      classifier.classify(
        writeContext({
          declaredValue: "~/secret.txt",
          allowedDirectories: allowed,
        }),
      ),
    ).toMatchObject({ level: "low" });
  });

  it("classifies a ~ write to an ALLOWED location as deeper than it is", () => {
    // Home is allowed and the process cwd sits well below it. `~/secret.txt` is
    // a direct leaf of the allowed root, but the literal `~` segment appended
    // to the cwd pushes it past the depth heuristic.
    const deepCwd = pathResolve(homedir(), "a", "b", "c");
    vi.spyOn(process, "cwd").mockReturnValue(deepCwd);
    const allowed = [canonicalizePathForMatch(homedir()).toLowerCase()];

    expect(
      classifier.classify(
        writeContext({
          declaredValue: pipelineTarget("~/secret.txt", deepCwd),
          allowedDirectories: allowed,
        }),
      ),
    ).toMatchObject({ level: "low", reason: "write at allowed-dir leaf" });

    expect(
      classifier.classify(
        writeContext({ declaredValue: "~/secret.txt", allowedDirectories: allowed }),
      ),
    ).toMatchObject({ level: "medium", reason: "write deep inside allowed" });
  });
});

describe("reviewer vs. pipeline: relative values", () => {
  it("resolves a relative value against process.cwd, not the invocation cwd", () => {
    const invocationCwd = pathResolve("/work/project");
    const processCwd = pathResolve("/somewhere/else");
    vi.spyOn(process, "cwd").mockReturnValue(processCwd);

    // Pipeline: invocation cwd.
    expect(resolveToolPathForPermission("notes/x.md", invocationCwd)).toBe(
      pathResolve(invocationCwd, "notes/x.md"),
    );
    // Reviewer: process cwd. Different absolute path for the same call.
    expect(canonicalizePathForMatch("notes/x.md").toLowerCase()).toBe(
      canonicalizePathForMatch(pathResolve(processCwd, "notes/x.md")).toLowerCase(),
    );
    expect(canonicalizePathForMatch("notes/x.md").toLowerCase()).not.toBe(
      canonicalizePathForMatch(pathResolve(invocationCwd, "notes/x.md")).toLowerCase(),
    );
  });
});
