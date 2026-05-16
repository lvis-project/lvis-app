/**
 * Issue #664 / PR #860 — StrictRiskClassifier focused unit tests.
 *
 * Post-#664 `strict` is the honest name for the pre-fix `disabled`
 * fail-closed semantic. Every invocation returns HIGH so headless mutations
 * route to the deferred queue.
 *
 * Pins:
 *   - level === "high" for every category × source × trustOrigin
 *   - reason mentions "strict" and "defer" so audit logs are searchable
 *   - The classifier never inspects finalInput / allowedDirectories — the
 *     "defer-all" contract is independent of the request shape.
 */
import { describe, it, expect } from "vitest";
import {
  StrictRiskClassifier,
  type ToolInvocationContext,
} from "../reviewer/risk-classifier.js";
import { detectSandboxCapability } from "../sandbox-capability.js";

const ALLOWED = ["/Users/ken/work", "/Users/ken/.lvis"];

function ctx(overrides: Partial<ToolInvocationContext>): ToolInvocationContext {
  return {
    toolName: "test_tool",
    source: "builtin",
    category: "write",
    pathFields: ["path"],
    trustOrigin: "user-keyboard",
    finalInput: {},
    allowedDirectories: ALLOWED,
    sensitivePathsAdjacent: [],
    sandboxCapability: detectSandboxCapability(),
    ...overrides,
  };
}

describe("StrictRiskClassifier — issue #664 defer-all", () => {
  const c = new StrictRiskClassifier();

  it("write category → HIGH defer", () => {
    const v = c.classify(
      ctx({
        category: "write",
        finalInput: { path: "/Users/ken/work/file.txt" }, // inside allowed
      }),
    );
    expect(v.level).toBe("high");
    expect(v.reason).toMatch(/strict/);
    expect(v.reason).toMatch(/defer/);
  });

  it("shell category (reversible verb) → HIGH (no downgrade)", () => {
    // Even a reversible `echo` returns HIGH — strict mode is "every call
    // routes to deferred queue", not "rule-based with deferred queue".
    const v = c.classify(
      ctx({
        category: "shell",
        finalInput: { command: "echo hi" },
      }),
    );
    expect(v.level).toBe("high");
  });

  it("network to trusted host → HIGH (no downgrade)", () => {
    const v = c.classify(
      ctx({
        category: "network",
        finalInput: { url: "https://api.openai.com/v1/chat" },
      }),
    );
    expect(v.level).toBe("high");
  });

  it("read category → HIGH (read still defers in strict)", () => {
    const v = c.classify(
      ctx({
        category: "read",
        finalInput: { path: "/Users/ken/.lvis/notes.md" },
      }),
    );
    expect(v.level).toBe("high");
  });

  it("trustOrigin variations do not change the verdict", () => {
    for (const trustOrigin of [
      "user-keyboard",
      "plugin-emitted",
      "llm-tool-arg",
      "file-content",
    ] as const) {
      const v = c.classify(ctx({ trustOrigin }));
      expect(v.level).toBe("high");
    }
  });
});
