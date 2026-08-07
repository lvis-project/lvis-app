/**
 * The reviewer (Layer 5) and the enforcer (Layer 0/1) must resolve a tool's
 * path ARGUMENT to the same absolute path.
 *
 * Before this alignment `extractDeclaredPaths` used a bare `path.resolve`, so
 * a leading `~` survived as a literal directory segment and a relative
 * argument resolved against `process.cwd()` rather than the invocation cwd.
 * `{ path: "~/secret.txt" }` therefore rated LOW ("write at allowed-dir leaf",
 * because `<process.cwd()>/~/secret.txt` sits under an allowed project root)
 * while Layer 1 checked `<home>/secret.txt` and rated it outside scope.
 *
 * Layer 1 enforcement never depended on the reviewer, so nothing was
 * executable that should not have been — what moved is the Layer-5 verdict
 * that drives auto-approval routing and the approval-memory escalation guard.
 *
 * Every case below is parameterized on an EXPLICIT cwd. `process.cwd()` is
 * deliberately never the cwd under test: an agreement assertion in which both
 * sides read the same real global cannot catch re-divergence.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname, resolve as pathResolve } from "node:path";
import { RuleBasedRiskClassifier } from "../reviewer/risk-classifier.js";
import { PermissionManager } from "../permission-manager.js";
import { VerdictCache } from "../reviewer/verdict-cache.js";
import { DeferredQueue } from "../reviewer/deferred-queue.js";
import { canonicalizePathForMatch, caseFoldForMatch } from "../sensitive-paths.js";
import { resolveToolPathForPermission } from "../../shared/tool-path-resolution.js";
import { extractTargetFilePaths } from "../../tools/pipeline/path-extraction.js";
import { buildPermissionEvaluationContext } from "../evaluation-context.js";
import { dispatchReviewerForHeadless } from "../../tools/pipeline/reviewer-dispatch.js";
import type { Tool } from "../../tools/base.js";
import type { ToolPermissionContext } from "../../tools/executor.js";
import { makeRiskClassifierContext } from "./test-helpers.js";

const rb = new RuleBasedRiskClassifier();

function canon(p: string): string {
  return caseFoldForMatch(canonicalizePathForMatch(p));
}

/** What the ENFORCER will hand to Layer 0/1 for this argument. */
function enforcerPath(tool: Tool, arg: string, cwd: string): string {
  const [only, ...rest] = extractTargetFilePaths(tool, { path: arg }, cwd);
  expect(rest).toHaveLength(0);
  return canon(only);
}

const writeTool = {
  name: "write_probe",
  source: "builtin",
  pathFields: ["path"],
} as unknown as Tool;

let roots: string[] = [];

function makeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "lvis-path-align-"));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  roots = [];
});

describe("reviewer ↔ enforcer path resolution — agreement", () => {
  // `arg` is built from the per-test cwd. `movedVerdict` records whether the
  // OLD bare-`path.resolve` form differed for this shape — i.e. whether this
  // row is one of the verdicts that actually moved.
  const CASES: Array<{ label: string; arg: (cwd: string) => string; movedVerdict: boolean }> = [
    // Tilde: bare resolve keeps `~` as a literal segment → the reviewer used
    // to judge `<cwd>/~/secret.txt`. STRICTER after alignment.
    { label: "tilde home write", arg: () => "~/secret.txt", movedVerdict: true },
    // Relative: bare resolve used `process.cwd()`; the enforcer uses the
    // invocation cwd. Direction depends on which of the two is allowed.
    { label: "relative path", arg: () => "notes/todo.md", movedVerdict: true },
    { label: "single dot relative", arg: () => "./out.txt", movedVerdict: true },
    // Absolute arguments were already identical — pinned so the alignment
    // cannot be "achieved" by breaking the majority case.
    { label: "absolute path", arg: (cwd) => pathResolve(cwd, "abs.txt"), movedVerdict: false },
  ];

  for (const c of CASES) {
    it(`${c.label}: the reviewer judges the path the enforcer checks`, () => {
      const cwd = makeRoot();
      const arg = c.arg(cwd);
      const enforced = enforcerPath(writeTool, arg, cwd);
      const bareResolve = canon(arg);
      expect(bareResolve === enforced).toBe(!c.movedVerdict);

      // Allowing exactly the enforcer's parent directory must make the
      // reviewer agree the write is in scope.
      const inScope = rb.classify(makeRiskClassifierContext({
        category: "write",
        pathFields: ["path"],
        finalInput: { path: arg },
        executionCwd: cwd,
        allowedDirectories: [dirname(enforced)],
      }));
      expect(inScope.reason).not.toMatch(/outside allowed/);

      // Allowing only the OLD (bare-resolve) parent must now read as
      // out-of-scope for the rows where the two forms differ.
      if (c.movedVerdict) {
        const outOfScope = rb.classify(makeRiskClassifierContext({
          category: "write",
          pathFields: ["path"],
          finalInput: { path: arg },
          executionCwd: cwd,
          allowedDirectories: [dirname(bareResolve)],
        }));
        expect(outOfScope).toEqual({ level: "high", reason: "write outside allowed dirs" });
      }
    });
  }

  it("resolution is a function of executionCwd, not of process.cwd()", () => {
    const a = makeRoot();
    const b = makeRoot();
    const argument = "sub/file.txt";
    const underA = rb.classify(makeRiskClassifierContext({
      category: "write",
      pathFields: ["path"],
      finalInput: { path: argument },
      executionCwd: a,
      allowedDirectories: [canon(a)],
    }));
    const underB = rb.classify(makeRiskClassifierContext({
      category: "write",
      pathFields: ["path"],
      finalInput: { path: argument },
      executionCwd: b,
      allowedDirectories: [canon(a)],
    }));
    expect(underA.reason).not.toMatch(/outside allowed/);
    expect(underB).toEqual({ level: "high", reason: "write outside allowed dirs" });
  });
});

describe("reviewer path resolution — the verdicts that moved", () => {
  it("STRICTER: `~/secret.txt` with only the project root allowed is now HIGH", () => {
    // This is the reproduced divergence, restated as the post-alignment
    // expectation. Pre-alignment this returned
    // { level: "low", reason: "write at allowed-dir leaf" } because the
    // reviewer resolved the argument to `<projectRoot>/~/secret.txt`.
    const projectRoot = makeRoot();
    const v = rb.classify(makeRiskClassifierContext({
      category: "write",
      pathFields: ["path"],
      finalInput: { path: "~/secret.txt" },
      executionCwd: projectRoot,
      allowedDirectories: [canon(projectRoot)],
    }));
    expect(v).toEqual({ level: "high", reason: "write outside allowed dirs" });
    // …and the path Layer 1 checks is the home-relative one, as asserted.
    expect(enforcerPath(writeTool, "~/secret.txt", projectRoot))
      .toBe(canon(join(homedir(), "secret.txt")));
  });

  it("LOOSER: a relative write under the invocation cwd is no longer judged against process.cwd()", () => {
    // Pre-alignment the reviewer resolved `out.txt` against `process.cwd()`
    // — a directory that has nothing to do with this invocation — and rated
    // it HIGH "write outside allowed dirs" even though Layer 1 was checking
    // `<invocationCwd>/out.txt`, which IS inside the allowed scope.
    const invocationCwd = makeRoot();
    const v = rb.classify(makeRiskClassifierContext({
      category: "write",
      pathFields: ["path"],
      finalInput: { path: "out.txt" },
      executionCwd: invocationCwd,
      allowedDirectories: [canon(invocationCwd)],
    }));
    expect(v).toEqual({ level: "low", reason: "write at allowed-dir leaf" });
    // Confirm the pre-alignment form really was out of scope, so this row
    // records a genuine loosening rather than a no-op.
    expect(canon("out.txt").startsWith(canon(invocationCwd))).toBe(false);
  });

  it("STRICTER: a sandbox-write auto-LOW cannot be won with a literal `~` segment", () => {
    const sandboxRoot = makeRoot();
    const pluginDir = join(sandboxRoot, "plugins", "p1");
    mkdirSync(pluginDir, { recursive: true });
    const v = rb.classify(makeRiskClassifierContext({
      category: "write",
      source: "plugin",
      pathFields: ["path"],
      finalInput: { path: "~/token.json" },
      executionCwd: pluginDir,
      // The literal-`~` form used to land under the sandbox root and win the
      // auto-LOW containment proof.
      ownerPluginSandboxRoot: canon(pluginDir),
      allowedDirectories: [canon(pluginDir)],
    }));
    expect(v.reason).not.toMatch(/inside owner plugin sandbox/);
    expect(v.level).toBe("high");
  });
});

describe("producer wiring — the dispatch lanes thread the invocation cwd", () => {
  let pm: PermissionManager;
  let captured: Array<{ executionCwd: string; finalInput: Record<string, unknown> }>;

  beforeEach(() => {
    const dir = makeRoot();
    pm = new PermissionManager(join(dir, "permissions.json"));
    captured = [];
    pm.setReviewer({
      classifier: {
        classify: (input) => {
          captured.push({ executionCwd: input.executionCwd, finalInput: input.finalInput });
          return { level: "low", reason: "capture" };
        },
      },
      cache: new VerdictCache(join(dir, "cache.jsonl")),
      deferredQueue: new DeferredQueue(join(dir, "queue.jsonl")),
    });
  });

  it("dispatchReviewerForHeadless hands the classifier the evaluation context's executionCwd", async () => {
    const invocationCwd = makeRoot();
    const evaluationContext = buildPermissionEvaluationContext({
      policyMode: "unmanaged",
      headless: true,
      source: "builtin",
      category: "write",
      trustOrigin: "llm-tool-arg",
      executionCwd: invocationCwd,
      allowedDirectories: [canon(invocationCwd)],
      pathFields: ["path"],
      targetFilePaths: [],
      sensitivePathsAdjacent: [],
    });
    const result = await dispatchReviewerForHeadless(
      pm,
      "write_probe",
      "builtin",
      "write",
      ["path"],
      { path: "out.txt" },
      [canon(invocationCwd)],
      [],
      { trustOrigin: "llm-tool-arg", headless: true } as ToolPermissionContext,
      evaluationContext,
      {},
      undefined,
      { groupId: "g1", toolUseId: "tu1", displayOrder: 0 },
      undefined,
    );
    expect(result.allowed).toBe(true);
    expect(captured).toHaveLength(1);
    // The producer-driven assertion: the value the classifier received is the
    // invocation cwd, NOT the ambient process cwd.
    expect(captured[0].executionCwd).toBe(invocationCwd);
    expect(captured[0].executionCwd).not.toBe(process.cwd());
  });
});

describe("shared resolver is the single authority", () => {
  it("the enforcer's extraction is literally this resolver, canonicalized", () => {
    const cwd = makeRoot();
    for (const arg of ["~/x.txt", "rel/y.txt", "./z.txt", pathResolve(cwd, "abs.txt"), "~"]) {
      expect(enforcerPath(writeTool, arg, cwd))
        .toBe(canon(resolveToolPathForPermission(arg, cwd)));
    }
  });
});
