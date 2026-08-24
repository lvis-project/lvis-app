/**
 * #664 P1 / #885 v6 — sandbox-write auto-LOW rule unit tests.
 *
 * v6 (Q4): the manifest `writesToOwnSandbox` self-attestation is REMOVED. The
 * auto-LOW keys SOLELY on the HOST-computed `ownerPluginSandboxRoot` + the
 * host-verified path-containment proof (every resolved path inside the root):
 *   (a) ownerPluginSandboxRoot set + every path inside → LOW.
 *   (b) `..` traversal cannot escape — canonicalize collapses it before the
 *       prefix compare → no auto-LOW.
 *   (c) path outside the root AND outside allowed → HIGH "write outside".
 *   (d) ownerPluginSandboxRoot ABSENT (builtin / MCP tool) → no auto-LOW (the
 *       real "cannot accidentally qualify" guard — a self-claim never existed).
 *   (e) declared-but-empty pathFields (manifest mistake) → HIGH "not declared".
 */
import { describe, it, expect } from "vitest";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  RuleBasedRiskClassifier,
  type ToolInvocationContext,
} from "../reviewer/risk-classifier.js";
import { detectSandboxCapability } from "../sandbox-capability.js";

// Use realpath so the canonicalize step inside the classifier produces
// the same string on darwin (/var → /private/var).
const TMP = realpathSync(tmpdir());
const PLUGIN_ID = "lvis-plugin-ms-graph";
const SANDBOX_ROOT = `${TMP}/lvis-sandbox-test/.lvis/plugins/${PLUGIN_ID}`;
const ALLOWED = [`${TMP}/lvis-sandbox-test/work`];

function ctx(overrides: Partial<ToolInvocationContext>): ToolInvocationContext {
  return {
    toolName: "msgraph_auth",
    source: "plugin",
    category: "write",
    pathFields: ["path"],
    trustOrigin: "plugin-emitted",
    finalInput: {},
    executionCwd: TMP,
    allowedDirectories: ALLOWED,
    sensitivePathsAdjacent: [],
    sandboxCapability: detectSandboxCapability(),
    ...overrides,
  };
}

describe("RuleBasedRiskClassifier — #664 P1 / #885 v6 host-derived sandbox-write auto-LOW", () => {
  const rb = new RuleBasedRiskClassifier();

  it("(a) ownerPluginSandboxRoot set + path inside → LOW (no self-claim needed)", () => {
    const v = rb.classify(
      ctx({
        ownerPluginSandboxRoot: SANDBOX_ROOT,
        finalInput: { path: `${SANDBOX_ROOT}/msal-cache.bin` },
      }),
    );
    expect(v.level).toBe("low");
    expect(v.reason).toMatch(/owner plugin sandbox/);
  });

  it("(b) path-traversal `..` cannot escape → no auto-LOW (falls through)", () => {
    // `../` traversal: nominally inside SANDBOX_ROOT by string prefix but
    // canonicalizePathForMatch collapses `..` so the prefix compare no longer
    // matches → the auto-LOW is NOT engaged.
    const v = rb.classify(
      ctx({
        ownerPluginSandboxRoot: SANDBOX_ROOT,
        finalInput: { path: `${SANDBOX_ROOT}/../../sessions/sensitive.jsonl` },
      }),
    );
    expect(v.reason).not.toMatch(/owner plugin sandbox/);
  });

  it("(c) path outside the root AND outside allowed → HIGH (write outside)", () => {
    const v = rb.classify(
      ctx({
        ownerPluginSandboxRoot: SANDBOX_ROOT,
        finalInput: { path: `${TMP}/outside-everything/file.bin` },
      }),
    );
    expect(v.level).toBe("high");
    expect(v.reason).toMatch(/outside allowed/);
  });

  it("(d) ownerPluginSandboxRoot ABSENT (builtin/MCP tool) → no auto-LOW", () => {
    // No host-computed sandbox root ⇒ the tool is not plugin-owned ⇒ the normal
    // write rules apply. A sandbox-shaped path can never "accidentally" auto-LOW.
    const v = rb.classify(
      ctx({
        finalInput: { path: `${SANDBOX_ROOT}/anything.bin` },
      }),
    );
    expect(v.reason).not.toMatch(/owner plugin sandbox/);
  });

  it("(e) manifest mistake — pathFields declared but resolves to nothing → HIGH (not declared)", () => {
    const v = rb.classify(
      ctx({
        ownerPluginSandboxRoot: SANDBOX_ROOT,
        finalInput: {}, // path field absent
      }),
    );
    expect(v.level).toBe("high");
    expect(v.reason).toMatch(/not declared/);
  });
});

describe("RuleBasedRiskClassifier — OS-confined no-declared-write-path LOW", () => {
  const rb = new RuleBasedRiskClassifier();
  const ASRT_FULL = {
    kind: "asrt",
    confidence: "verified",
    platform: "darwin",
    reason: "ASRT (Seatbelt) active",
    confines: { filesystem: true, process: true, network: true },
  } as const;

  it("write + owner root + NO resolvable path + asrt-full substrate → LOW", () => {
    const v = rb.classify(
      ctx({
        toolName: "work_assistant_list_detectors",
        ownerPluginSandboxRoot: SANDBOX_ROOT,
        pathFields: [],
        finalInput: {},
        sandboxCapability: { ...ASRT_FULL },
      }),
    );
    expect(v.level).toBe("low");
    expect(v.reason).toContain("OS-confined to owner plugin sandbox");
  });

  it("same call with substrate none (in-process plugin) keeps the HIGH", () => {
    const v = rb.classify(
      ctx({
        toolName: "work_assistant_list_detectors",
        ownerPluginSandboxRoot: SANDBOX_ROOT,
        pathFields: [],
        finalInput: {},
        // detectSandboxCapability() default in tests — kind none
      }),
    );
    expect(v.level).toBe("high");
    expect(v.reason).toBe("write path not declared");
  });

  it("declared path OUTSIDE the owner root stays on the lexical rules even under asrt", () => {
    const v = rb.classify(
      ctx({
        ownerPluginSandboxRoot: SANDBOX_ROOT,
        finalInput: { path: `${TMP}/somewhere-else/x.txt` },
        sandboxCapability: { ...ASRT_FULL },
      }),
    );
    // The confined-LOW rule must NOT swallow a resolvable declared path —
    // the path either proves containment lexically or escalates.
    expect(v.reason).not.toContain("OS-confined to owner plugin sandbox");
  });

  it("builtin tool without owner root cannot reach the confined LOW", () => {
    const v = rb.classify(
      ctx({
        source: "builtin",
        toolName: "write_file",
        pathFields: [],
        finalInput: {},
        sandboxCapability: { ...ASRT_FULL },
      }),
    );
    expect(v.level).toBe("high");
    expect(v.reason).toBe("write path not declared");
  });
});
