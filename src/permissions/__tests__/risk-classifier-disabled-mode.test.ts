/**
 * Issue #664 / PR #860 — DisabledRiskClassifier focused unit tests.
 *
 * Post-#664 the `disabled` reviewer mode is wired as pass-through-LOW (not
 * defer-all-HIGH). The fail-closed semantic moved to {@link StrictRiskClassifier}.
 *
 * These tests pin the new contract: every category, source, and trustOrigin
 * tuple returns LOW with the "disabled — pass-through" reason. The
 * classifier is intentionally trivial (no rule lookup, no LLM call), so
 * the contract is small: any input → LOW.
 */
import { describe, it, expect } from "vitest";
import {
  DisabledRiskClassifier,
} from "../reviewer/risk-classifier.js";
import { makeRiskClassifierContext as ctx } from "./test-helpers.js";


describe("DisabledRiskClassifier — issue #664 pass-through", () => {
  const c = new DisabledRiskClassifier();

  it("write category → LOW pass-through", () => {
    const v = c.classify(
      ctx({
        category: "write",
        finalInput: { path: "/tmp/output.json" },
      }),
    );
    expect(v.level).toBe("low");
    expect(v.reason).toMatch(/disabled/);
    expect(v.reason).toMatch(/pass-through/);
  });

  it("shell category with destructive verb → still LOW (reviewer lane bypassed)", () => {
    // `disabled` short-circuits before any rule fires. The per-tool category
    // × source × trust matrix in PermissionManager (which still applies) is
    // what guards destructive shell commands when this mode is on.
    const v = c.classify(
      ctx({
        category: "shell",
        finalInput: { command: "rm -rf /" },
      }),
    );
    expect(v.level).toBe("low");
    expect(v.reason).toMatch(/disabled/);
  });

  it("network category to untrusted host → still LOW", () => {
    const v = c.classify(
      ctx({
        category: "network",
        finalInput: { url: "https://evil.example.com/exfil" },
      }),
    );
    expect(v.level).toBe("low");
    expect(v.reason).toMatch(/disabled/);
  });

  it("trustOrigin variations do not change the verdict", () => {
    for (const trustOrigin of [
      "user-keyboard",
      "plugin-emitted",
      "llm-tool-arg",
      "file-content",
    ] as const) {
      const v = c.classify(ctx({ trustOrigin }));
      expect(v.level).toBe("low");
    }
  });
});
