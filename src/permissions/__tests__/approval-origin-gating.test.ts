/**
 * approval-origin-gating.test.ts — §8 P0 security regression (issue #71)
 *
 * Verifies the cross-plugin attack defense introduced by ApprovalIssuerRegistry
 * + verifyApprovalResponder:
 *
 *   (a) Legitimate plugin CAN respond to its own pending approval.
 *   (b) Malicious plugin CANNOT respond to another plugin's pending approval
 *       (cross-plugin hijack → ApprovalOriginError code "cross-plugin-hijack").
 *   (c) Plugin with empty agentApprovalScopes CANNOT respond even to its own
 *       request (scope-not-allowed → ApprovalOriginError code "scope-not-allowed").
 *   (d) Unknown requestId (never issued or already consumed) → "unknown-request".
 *   (e) Registry consume is idempotent: second respond attempt after success fails
 *       with "unknown-request" (no double-respond).
 *   (f) requestAgentApproval records into registry using the provided scope.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import {
  ApprovalIssuerRegistry,
  verifyApprovalResponder,
  requestAgentApproval,
  ApprovalOriginError,
} from "../agent-action-requester.js";
import type { ApprovalGate } from "../approval-gate.js";

// These tests verify the hard-enforcement security contract.
// Set LVIS_FEATURE_APPROVAL_ORIGIN_GATING=true so verifyApprovalResponder
// throws on violations rather than soft-logging.
beforeAll(() => { vi.stubEnv("LVIS_FEATURE_APPROVAL_ORIGIN_GATING", "true"); });
afterAll(() => { vi.unstubAllEnvs(); });

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRegistry(): ApprovalIssuerRegistry {
  return new ApprovalIssuerRegistry();
}

function makeGate(choice: import("../approval-gate.js").ApprovalChoice = "allow-once"): ApprovalGate {
  return {
    requestAndWait: vi.fn(async (req) => ({
      requestId: req.id,
      choice,
      nonce: "test-nonce",
      hmac: "test-hmac",
    })),
  } as unknown as ApprovalGate;
}

const SCOPE = "agent_external_api_call";
const PLUGIN_A = "agent-hub";
const PLUGIN_B = "malicious-plugin";

// ─── (a) Legitimate plugin CAN respond to its own pending approval ────────────

describe("verifyApprovalResponder — legitimate respond", () => {
  it("(a) succeeds when responderPluginId matches issuer and scope is allowed", () => {
    const registry = makeRegistry();
    const requestId = "req-legit-1";
    registry.record(requestId, PLUGIN_A, SCOPE);

    const entry = verifyApprovalResponder(registry, requestId, PLUGIN_A, [SCOPE]);

    expect(entry.issuerPluginId).toBe(PLUGIN_A);
    expect(entry.scope).toBe(SCOPE);
    // Entry consumed — registry should be empty
    expect(registry.size).toBe(0);
  });

  it("(a) succeeds with one of several allowed scopes", () => {
    const registry = makeRegistry();
    const requestId = "req-legit-2";
    registry.record(requestId, PLUGIN_A, "agent_task_delegate");

    expect(() =>
      verifyApprovalResponder(registry, requestId, PLUGIN_A, [
        "agent_file_share",
        "agent_task_delegate",
        "agent_external_api_call",
      ]),
    ).not.toThrow();
  });
});

// ─── (b) Cross-plugin hijack attack ──────────────────────────────────────────

describe("verifyApprovalResponder — cross-plugin hijack denied", () => {
  it("(b) throws ApprovalOriginError with code 'cross-plugin-hijack' when malicious plugin tries to respond", () => {
    const registry = makeRegistry();
    const requestId = "req-hijack-1";
    registry.record(requestId, PLUGIN_A, SCOPE);

    expect(() =>
      verifyApprovalResponder(registry, requestId, PLUGIN_B, [SCOPE]),
    ).toThrow(ApprovalOriginError);

    try {
      verifyApprovalResponder(registry, requestId, PLUGIN_B, [SCOPE]);
    } catch (err) {
      expect(err).toBeInstanceOf(ApprovalOriginError);
      expect((err as ApprovalOriginError).code).toBe("cross-plugin-hijack");
      expect((err as ApprovalOriginError).message).toContain("cross-plugin attack detected");
      expect((err as ApprovalOriginError).message).toContain(PLUGIN_B);
      expect((err as ApprovalOriginError).message).toContain(PLUGIN_A);
    }
  });

  it("(b) re-inserts entry after hijack attempt so legitimate issuer can still respond", () => {
    const registry = makeRegistry();
    const requestId = "req-hijack-2";
    registry.record(requestId, PLUGIN_A, SCOPE);

    // Malicious plugin tries to respond → fails
    try {
      verifyApprovalResponder(registry, requestId, PLUGIN_B, [SCOPE]);
    } catch {
      // expected
    }

    // Legitimate plugin can still respond after the hijack attempt
    expect(() =>
      verifyApprovalResponder(registry, requestId, PLUGIN_A, [SCOPE]),
    ).not.toThrow();
  });
});

// ─── (c) Empty agentApprovalScopes blocks even self-respond ──────────────────

describe("verifyApprovalResponder — scope-not-allowed", () => {
  it("(c) throws 'scope-not-allowed' when issuer's allowed scopes is empty", () => {
    const registry = makeRegistry();
    const requestId = "req-scope-empty";
    registry.record(requestId, PLUGIN_A, SCOPE);

    let err: ApprovalOriginError | undefined;
    try {
      verifyApprovalResponder(registry, requestId, PLUGIN_A, []); // empty scopes
    } catch (e) {
      err = e as ApprovalOriginError;
    }

    expect(err).toBeInstanceOf(ApprovalOriginError);
    expect(err?.code).toBe("scope-not-allowed");
    expect(err?.message).toContain(SCOPE);
    expect(err?.message).toContain("agentApprovalScopes");
  });

  it("(c) throws 'scope-not-allowed' when scope is not in issuer's declared scopes", () => {
    const registry = makeRegistry();
    const requestId = "req-scope-mismatch";
    registry.record(requestId, PLUGIN_A, "agent_external_api_call");

    let err: ApprovalOriginError | undefined;
    try {
      verifyApprovalResponder(registry, requestId, PLUGIN_A, ["agent_file_share"]); // different scope
    } catch (e) {
      err = e as ApprovalOriginError;
    }

    expect(err).toBeInstanceOf(ApprovalOriginError);
    expect(err?.code).toBe("scope-not-allowed");
  });
});

// ─── (d) Unknown requestId ────────────────────────────────────────────────────

describe("verifyApprovalResponder — unknown-request", () => {
  it("(d) throws 'unknown-request' for a requestId never recorded", () => {
    const registry = makeRegistry();

    let err: ApprovalOriginError | undefined;
    try {
      verifyApprovalResponder(registry, "req-nonexistent", PLUGIN_A, [SCOPE]);
    } catch (e) {
      err = e as ApprovalOriginError;
    }

    expect(err).toBeInstanceOf(ApprovalOriginError);
    expect(err?.code).toBe("unknown-request");
  });
});

// ─── (e) Double-respond prevention ───────────────────────────────────────────

describe("verifyApprovalResponder — double-respond prevention", () => {
  it("(e) second respond attempt after successful first attempt fails with 'unknown-request'", () => {
    const registry = makeRegistry();
    const requestId = "req-double-respond";
    registry.record(requestId, PLUGIN_A, SCOPE);

    // First respond: succeeds
    expect(() =>
      verifyApprovalResponder(registry, requestId, PLUGIN_A, [SCOPE]),
    ).not.toThrow();

    // Second respond: entry already consumed → fails
    let err: ApprovalOriginError | undefined;
    try {
      verifyApprovalResponder(registry, requestId, PLUGIN_A, [SCOPE]);
    } catch (e) {
      err = e as ApprovalOriginError;
    }

    expect(err).toBeInstanceOf(ApprovalOriginError);
    expect(err?.code).toBe("unknown-request");
  });
});

// ─── (f) requestAgentApproval records into registry ──────────────────────────

describe("requestAgentApproval — registry integration", () => {
  it("(f) records issuer + scope into registry before calling gate", async () => {
    const registry = makeRegistry();
    const gate = makeGate("allow-once");

    const choice = await requestAgentApproval(
      gate,
      {
        toolName: "agent_hub_decide_approval_with_host",
        args: { approvalId: 42 },
        reason: "test approval",
        source: "plugin",
        sourcePluginId: PLUGIN_A,
        scope: SCOPE,
      },
      registry,
    );

    expect(choice).toBe("allow-once");
    // Entry persists after requestAndWait returns — only removed when respond() calls delete().
    expect(registry.size).toBe(1);
  });

  it("(f) registered entry has correct issuerPluginId and scope", async () => {
    const registry = makeRegistry();
    const gate = makeGate("deny-once");

    await requestAgentApproval(
      gate,
      {
        toolName: "some_tool",
        args: {},
        reason: "test",
        source: "plugin",
        sourcePluginId: PLUGIN_A,
        scope: "agent_task_delegate",
      },
      registry,
    );

    // Consume and verify
    const entry = verifyApprovalResponder(
      registry,
      // We need the requestId — but it's a random UUID. Access via gate mock.
      (gate.requestAndWait as ReturnType<typeof vi.fn>).mock.calls[0][0].id as string,
      PLUGIN_A,
      ["agent_task_delegate"],
    );
    expect(entry.issuerPluginId).toBe(PLUGIN_A);
    expect(entry.scope).toBe("agent_task_delegate");
  });

});
