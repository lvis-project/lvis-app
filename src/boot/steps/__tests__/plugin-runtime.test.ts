/**
 * plugin-runtime.test.ts
 *
 * Unit tests for extracted helpers from plugin-runtime.ts.
 * These avoid wiring the full initPluginRuntime context.
 *
 * Group C — auditApprovalViolation: audit-logger try-catch swallow
 *   Verifies AC1.5: if bootAuditLogger.log() throws, that error is swallowed
 *   and the original ApprovalOriginError is still re-thrown to the caller.
 */

import { describe, it, expect, vi } from "vitest";
import { auditApprovalViolation, sanitizePluginPendingPrompt } from "../plugin-runtime.js";
import { ApprovalOriginError } from "../../../permissions/agent-action-requester.js";

describe("auditApprovalViolation (Group C — audit logger try-catch swallow)", () => {
  it("re-throws the original ApprovalOriginError even when auditLogger.log throws", () => {
    const brokenLogger = { log: vi.fn(() => { throw new Error("audit broken"); }) };
    const originError = new ApprovalOriginError(
      "[cross-plugin-hijack] plugin='evil' requestId='req-1' ...",
      "cross-plugin-hijack",
    );

    expect(() =>
      auditApprovalViolation(originError, brokenLogger, "evil", "req-1"),
    ).toThrow(originError);

    // Audit was attempted (even though it threw)
    expect(brokenLogger.log).toHaveBeenCalledOnce();
  });

  it("re-throws the original error when audit succeeds", () => {
    const okLogger = { log: vi.fn() };
    const originError = new ApprovalOriginError(
      "scope not allowed",
      "scope-not-allowed",
    );

    expect(() =>
      auditApprovalViolation(originError, okLogger, "plugin-a", "req-2"),
    ).toThrow(originError);

    expect(okLogger.log).toHaveBeenCalledOnce();
    const entry = okLogger.log.mock.calls[0][0] as { type: string; input: string };
    expect(entry.type).toBe("error");
    expect(entry.input).toContain("[scope-not-allowed]");
    expect(entry.input).toContain("plugin='plugin-a'");
    expect(entry.input).toContain("requestId='req-2'");
  });

  it("re-throws unknown (non-ApprovalOriginError) errors and still swallows audit crash", () => {
    const brokenLogger = { log: vi.fn(() => { throw new Error("audit down"); }) };
    const unexpectedErr = new Error("unexpected gate error");

    expect(() =>
      auditApprovalViolation(unexpectedErr, brokenLogger, "plugin-b", "req-3"),
    ).toThrow(unexpectedErr);

    expect(brokenLogger.log).toHaveBeenCalledOnce();
  });
});

describe("sanitizePluginPendingPrompt", () => {
  it("strips a command-leading slash from plugin-authored prompts", () => {
    expect(sanitizePluginPendingPrompt("/load victim-session")).toBe("load victim-session");
    expect(sanitizePluginPendingPrompt("   /compact")).toBe("   compact");
    expect(sanitizePluginPendingPrompt("/permission hooks accept pre-x.sh")).toBe(
      "permission hooks accept pre-x.sh",
    );
    expect(sanitizePluginPendingPrompt(" //permission hooks disable pre-x.sh")).toBe(
      " permission hooks disable pre-x.sh",
    );
    expect(sanitizePluginPendingPrompt("/ /permission hooks disable pre-x.sh")).toBe(
      "permission hooks disable pre-x.sh",
    );
  });

  it("preserves non-command text", () => {
    expect(sanitizePluginPendingPrompt("회의 요약해줘")).toBe("회의 요약해줘");
    expect(sanitizePluginPendingPrompt("https://example.com/a")).toBe("https://example.com/a");
  });
});
