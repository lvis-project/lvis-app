/**
 * Issue #664 P1 — sandbox-write auto-LOW rule unit tests.
 *
 * Pins the contract:
 *   (a) `writesToOwnSandbox: true` + every resolved path inside the owner
 *       sandbox → LOW with "write inside owner plugin sandbox" reason.
 *   (b) Path-traversal (`..`) cannot escape — `canonicalizePathForMatch()`
 *       collapses the segment before the prefix compare.
 *   (c) `writesToOwnSandbox: true` + path outside the owner sandbox →
 *       falls through to the standard "write outside allowed dirs" HIGH.
 *   (d) `writesToOwnSandbox: false` (or absent) → no auto-LOW; the normal
 *       write rules apply. Defends against a tool that omits the flag but
 *       writes inside a sandbox-shaped path "accidentally" qualifying.
 *
 * The runtime verifies the path-containment claim — declaration alone is
 * insufficient ("sound by construction").
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
    allowedDirectories: ALLOWED,
    sensitivePathsAdjacent: [],
    sandboxCapability: detectSandboxCapability(),
    ...overrides,
  };
}

describe("RuleBasedRiskClassifier — issue #664 P1 writesToOwnSandbox", () => {
  const rb = new RuleBasedRiskClassifier();

  it("(a) writesToOwnSandbox + path inside sandbox → LOW", () => {
    const v = rb.classify(
      ctx({
        writesToOwnSandbox: true,
        ownerPluginSandboxRoot: SANDBOX_ROOT,
        finalInput: { path: `${SANDBOX_ROOT}/msal-cache.bin` },
      }),
    );
    expect(v.level).toBe("low");
    expect(v.reason).toMatch(/owner plugin sandbox/);
  });

  it("(b) writesToOwnSandbox + path-traversal `..` denied (no auto-LOW, falls through)", () => {
    // `../` traversal: nominally inside SANDBOX_ROOT by string prefix but
    // resolves to a parent dir. canonicalizePathForMatch collapses `..` so
    // the prefix compare no longer matches → falls through to the standard
    // write rule. The non-traversed canonical IS still inside the allowed
    // dir tree (the parent contains the sandbox), so the verdict drops to
    // the next applicable write rule rather than HIGH. The critical check
    // is that the auto-LOW is NOT engaged.
    const v = rb.classify(
      ctx({
        writesToOwnSandbox: true,
        ownerPluginSandboxRoot: SANDBOX_ROOT,
        finalInput: {
          path: `${SANDBOX_ROOT}/../../sessions/sensitive.jsonl`,
        },
      }),
    );
    expect(v.reason).not.toMatch(/owner plugin sandbox/);
  });

  it("(c) writesToOwnSandbox + path outside sandbox AND outside allowed → HIGH (write outside)", () => {
    const v = rb.classify(
      ctx({
        writesToOwnSandbox: true,
        ownerPluginSandboxRoot: SANDBOX_ROOT,
        finalInput: { path: `${TMP}/outside-everything/file.bin` },
      }),
    );
    expect(v.level).toBe("high");
    expect(v.reason).toMatch(/outside allowed/);
  });

  it("(d) writesToOwnSandbox NOT set → no auto-LOW (path inside sandbox shape)", () => {
    // Tool declares the path but does NOT claim writesToOwnSandbox. The
    // sandbox-prefix shape is "accidental" — auto-LOW must NOT engage,
    // otherwise a tool could omit the flag and benefit anyway.
    const v = rb.classify(
      ctx({
        // writesToOwnSandbox: undefined — explicitly not set
        ownerPluginSandboxRoot: SANDBOX_ROOT,
        finalInput: { path: `${SANDBOX_ROOT}/anything.bin` },
      }),
    );
    expect(v.reason).not.toMatch(/owner plugin sandbox/);
  });

  it("(d') writesToOwnSandbox true but ownerPluginSandboxRoot missing → no auto-LOW", () => {
    const v = rb.classify(
      ctx({
        writesToOwnSandbox: true,
        // ownerPluginSandboxRoot: undefined — runtime did not resolve
        finalInput: { path: `${SANDBOX_ROOT}/anything.bin` },
      }),
    );
    expect(v.reason).not.toMatch(/owner plugin sandbox/);
  });

  it("manifest mistake — pathFields declared but resolves to nothing → no auto-LOW", () => {
    // A tool that declares writesToOwnSandbox + pathFields but emits an
    // empty path object must NOT auto-LOW. Falls through to "write path
    // not declared" HIGH so manifest bugs surface.
    const v = rb.classify(
      ctx({
        writesToOwnSandbox: true,
        ownerPluginSandboxRoot: SANDBOX_ROOT,
        finalInput: {}, // path field absent
      }),
    );
    expect(v.level).toBe("high");
    expect(v.reason).toMatch(/not declared/);
  });
});
