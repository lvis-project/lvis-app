/**
 * ApprovalGate unit tests
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ApprovalGate,
  approvalAnswererAuditToken,
  consumeHostApprovedOneShotExecutionBinding,
  isHostApprovalRejectedDecision,
  isHostApprovalTimeoutDecision,
  remoteControllerOriginAuditToken,
  signApprovalRequest,
  UNATTRIBUTED_APPROVAL_SESSION_ID,
} from "../approval-gate.js";
import type {
  ApprovalAnswerer,
  ApprovalDecision,
  ApprovalRequest,
  ApprovalRequestInput,
  ApprovalSignatureFields,
} from "../approval-gate.js";
import type { RationaleApprovalDisplay } from "../../shared/rationale-approval-display.js";
import type { HostShellExecutionPermitBinding } from "../host-shell-execution-permit.js";
import {
  buildHostShellExecutionPlan,
  getHostShellExecutionPlanAuditProjection,
} from "../host-shell-execution-plan.js";
import { makePlatformBridgeAuthority, makeTestPolicy } from "./test-helpers.js";

// ─── Mock WebContents ─────────────────────────────────

function makeMockWebContents(
  opts: { isDestroyed?: boolean; sendThrows?: boolean } = {},
) {
  return {
    send: vi.fn(() => {
      if (opts.sendThrows) throw new Error("webContents destroyed (race)");
    }),
    isDestroyed: vi.fn(() => opts.isDestroyed ?? false),
  };
}

// requestAndWait accepts the unsealed input; the gate owns `requireExplicit`.
type RequestInput = ApprovalRequestInput;

function makeRequest(overrides?: Partial<RequestInput>): RequestInput {
  return {
    id: "req-1",
    category: "tool",
    toolName: "agent_spawn",
    args: { title: "test", instructions: "hello" },
    reason: "상태 변경 도구 (trust: high, category: write)",
    source: "builtin",
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeRationaleApprovalDisplay(
  overrides: Partial<RationaleApprovalDisplay> = {},
): RationaleApprovalDisplay {
  return {
    contractVersion: 1,
    display: "rationale-approval-display",
    toolName: "agent_spawn",
    canonicalTargets: ["workspace/project"],
    requestedEffects: ["change-host-or-agent-state"],
    affectedResources: ["workspace/project"],
    requiredAuthority: "host-orchestration",
    effectiveVerdict: {
      level: "medium",
      reason: "host-reviewed state change",
    },
    scopeAlignment: "aligned",
    scopeReasons: ["the host-sealed target matches the request"],
    rationaleStatus: "ready",
    suggestion: "This affects only the reviewed workspace target.",
    modalFallbackRequired: false,
    ...overrides,
  };
}

function makeRationaleRequest(
  overrides: Partial<RequestInput> = {},
): RequestInput {
  const display = makeRationaleApprovalDisplay();
  return makeRequest({
    category: "tool",
    kind: "rationale",
    toolName: display.toolName,
    reviewerVerdict: display.effectiveVerdict,
    args: display,
    ...overrides,
  });
}

/**
 * §D2: helper — pull the most recent (nonce, hmac) issued by the gate from
 * the mock webContents.send call log, so tests can echo them back unchanged
 * in the ApprovalDecision.
 */
function lastSentNonceHmac(wc: ReturnType<typeof makeMockWebContents>): {
  nonce: string;
  hmac: string;
} {
  const calls = wc.send.mock.calls;
  const last = calls[calls.length - 1] as [string, ApprovalRequest];
  return { nonce: last[1].nonce as string, hmac: last[1].hmac as string };
}

/** The text of every audit row a gate wrote, in order. */
function auditRowTexts(auditLogger: { log: ReturnType<typeof vi.fn> }): string[] {
  return auditLogger.log.mock.calls.map(([entry]) => {
    const row = entry as { input?: string; output?: string };
    return row.input ?? row.output ?? "";
  });
}

function makeAuditingGate(): {
  wc: ReturnType<typeof makeMockWebContents>;
  auditLogger: { log: ReturnType<typeof vi.fn> };
  gate: ApprovalGate;
} {
  const wc = makeMockWebContents();
  const auditLogger = { log: vi.fn() };
  const gate = new ApprovalGate(
    wc as never,
    undefined,
    1_000,
    auditLogger as never,
  );
  return { wc, auditLogger, gate };
}

// ─── Tests ───────────────────────────────────────────

describe("ApprovalGate", () => {
  it("requestAndWait resolves when resolve() is called", async () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const req = makeRequest();

    const promise = gate.requestAndWait(req);

    // gate enriches req with requireExplicit + mints nonce/hmac before sending
    expect(wc.send).toHaveBeenCalledWith(
      "lvis:approval:request",
      expect.objectContaining({
        id: req.id,
        toolName: req.toolName,
        requireExplicit: true,
        nonce: expect.any(String),
        hmac: expect.any(String),
      }),
    );

    const { nonce, hmac } = lastSentNonceHmac(wc);
    const decision: ApprovalDecision = {
      requestId: req.id,
      choice: "allow-once",
      nonce,
      hmac,
    };
    gate.resolve(req.id, decision);

    const result = await promise;
    expect(result.choice).toBe("allow-once");
    expect(result.requestId).toBe("req-1");
  });

  it("issues a private one-shot receipt only after an HMAC-verified allow-once", async () => {
    const wc = makeMockWebContents();
    const auditLogger = { log: vi.fn() };
    const gate = new ApprovalGate(
      wc as never,
      makeTestPolicy({ requireExplicitApproval: false }),
      undefined,
      auditLogger as never,
    );
    const plan = buildHostShellExecutionPlan({
      platform: "win32",
      requestedSandbox: true,
      activeCapability: {
        kind: "asrt",
        confidence: "verified",
        platform: "win32",
        reason: "test-only reason that must not enter the audit log",
        confines: { filesystem: true, process: false, network: true },
      },
    });
    const binding: HostShellExecutionPermitBinding = Object.freeze({
      plan,
      planIdentity: "host-shell-execution-plan/v2:win32:windows-partial-shell-acl-unsafe",
      toolName: "bash",
      toolUseId: "receipt-tool-use",
      command: "echo receipt",
      requestedCwd: "subdir",
      executionCwd: "C:/repo",
      resolvedCwd: "C:/repo/subdir",
      timeoutSeconds: 30,
      allowedDirectories: Object.freeze(["c:/repo/extra"]),
    });
    const req = makeRequest({
      id: "req-host-shell-receipt",
      toolName: "bash",
      toolCategory: "shell",
      args: {
        command: binding.command,
        cwd: binding.requestedCwd,
        timeoutSeconds: binding.timeoutSeconds,
      },
      allowedChoices: ["allow-once", "deny-once"],
      forceExplicit: true,
      hostShellExecutionPermitBinding: binding,
    });

    const promise = gate.requestAndWait(req);
    const sent = (wc.send.mock.calls[0] as [string, ApprovalRequest])[1];
    expect(sent).toMatchObject({
      executionPlan: getHostShellExecutionPlanAuditProjection(plan),
      allowedChoices: ["allow-once", "deny-once"],
      requireExplicit: true,
    });
    expect(sent.sandboxCapability).toBeUndefined();
    expect(JSON.stringify(sent.executionPlan)).not.toContain(binding.command);
    expect(JSON.stringify(sent.executionPlan)).not.toContain(binding.executionCwd);
    expect(sent).not.toHaveProperty("forceExplicit");
    expect(sent).not.toHaveProperty("hostShellExecutionPermitBinding");

    gate.resolve(req.id, {
      requestId: req.id,
      choice: "allow-once",
      nonce: sent.nonce,
      hmac: sent.hmac,
    });
    const decision = await promise;
    const auditText = JSON.stringify(auditLogger.log.mock.calls);
    expect(auditText).toContain(`executionPlan.identity=${plan.identity}`);
    expect(auditText).toContain("executionPlan.requestedSandbox=true");
    expect(auditText).toContain("executionPlan.mode=plain");
    expect(auditText).toContain("executionPlan.fallbackReason=windows-partial-shell-acl-unsafe");
    expect(auditText).toContain("executionPlan.capability.kind=none");
    expect(auditText).not.toContain(binding.command);
    expect(auditText).not.toContain(binding.requestedCwd!);
    expect(auditText).not.toContain(binding.executionCwd);
    expect(auditText).not.toContain(binding.resolvedCwd);
    expect(auditText).not.toContain("test-only reason that must not enter the audit log");
    expect(consumeHostApprovedOneShotExecutionBinding(decision, binding)).toBe(true);
    expect(consumeHostApprovedOneShotExecutionBinding(decision, binding)).toBe(false);
  });

  it("fails closed before renderer IPC when a Plan-B binding differs from the displayed shell request", async () => {
    const plan = buildHostShellExecutionPlan({
      platform: "win32",
      requestedSandbox: true,
      activeCapability: {
        kind: "asrt",
        confidence: "verified",
        platform: "win32",
        reason: "test-only",
        confines: { filesystem: true, process: false, network: true },
      },
    });
    const binding: HostShellExecutionPermitBinding = Object.freeze({
      plan,
      planIdentity: plan.identity,
      toolName: "bash",
      toolUseId: "mismatch-tool-use",
      command: "echo host-only-command",
      requestedCwd: "subdir",
      executionCwd: "C:/repo",
      resolvedCwd: "C:/repo/subdir",
      timeoutSeconds: 30,
      allowedDirectories: Object.freeze(["c:/repo/extra"]),
    });
    const cases = [
      {
        label: "tool",
        toolName: "powershell",
        args: { command: binding.command, cwd: binding.requestedCwd, timeoutSeconds: binding.timeoutSeconds },
      },
      {
        label: "command",
        toolName: binding.toolName,
        args: { command: "echo renderer-command", cwd: binding.requestedCwd, timeoutSeconds: binding.timeoutSeconds },
      },
      {
        label: "cwd",
        toolName: binding.toolName,
        args: { command: binding.command, cwd: "other", timeoutSeconds: binding.timeoutSeconds },
      },
      {
        label: "timeout",
        toolName: binding.toolName,
        args: { command: binding.command, cwd: binding.requestedCwd, timeoutSeconds: 31 },
      },
    ];

    for (const mismatch of cases) {
      const wc = makeMockWebContents();
      const auditLogger = { log: vi.fn() };
      const gate = new ApprovalGate(wc as never, undefined, undefined, auditLogger as never);
      const result = await gate.requestAndWait(makeRequest({
        id: `req-host-shell-mismatch-${mismatch.label}`,
        toolName: mismatch.toolName,
        toolCategory: "shell",
        args: mismatch.args,
        allowedChoices: ["allow-once", "deny-once"],
        forceExplicit: true,
        hostShellExecutionPermitBinding: binding,
      }));

      expect(result).toMatchObject({ choice: "deny-once" });
      expect(isHostApprovalRejectedDecision(result)).toBe(true);
      expect(wc.send).not.toHaveBeenCalled();
      expect(gate.pendingCount).toBe(0);
      expect(consumeHostApprovedOneShotExecutionBinding(result, binding)).toBe(false);
      const auditText = JSON.stringify(auditLogger.log.mock.calls);
      expect(auditText).toContain("[approval:host-shell-binding-mismatch]");
      expect(auditText).not.toContain(binding.command);
      expect(auditText).not.toContain(binding.executionCwd);
    }
  });

  it("rejects a structural executionPlan projection before it reaches the renderer or audit", async () => {
    const plan = buildHostShellExecutionPlan({
      platform: "win32",
      requestedSandbox: true,
      activeCapability: {
        kind: "asrt",
        confidence: "verified",
        platform: "win32",
        reason: "test-only",
        confines: { filesystem: true, process: false, network: true },
      },
    });
    const leakedMarker = "must-not-cross-execution-plan-boundary";
    const wc = makeMockWebContents();
    const auditLogger = { log: vi.fn() };
    const gate = new ApprovalGate(wc as never, undefined, undefined, auditLogger as never);

    const result = await gate.requestAndWait(makeRequest({
      id: "req-structural-execution-plan",
      executionPlan: {
        ...getHostShellExecutionPlanAuditProjection(plan),
        leakedMarker,
      } as never,
    }));

    expect(result).toMatchObject({ choice: "deny-once" });
    expect(isHostApprovalRejectedDecision(result)).toBe(true);
    expect(wc.send).not.toHaveBeenCalled();
    expect(gate.pendingCount).toBe(0);
    const auditText = JSON.stringify(auditLogger.log.mock.calls);
    expect(auditText).toContain("[approval:execution-plan-invalid]");
    expect(auditText).not.toContain(leakedMarker);
  });

  it("requires a supplied executionPlan to be the exact projection of the hidden Plan-B binding", async () => {
    const plan = buildHostShellExecutionPlan({
      platform: "win32",
      requestedSandbox: true,
      activeCapability: {
        kind: "asrt",
        confidence: "verified",
        platform: "win32",
        reason: "test-only",
        confines: { filesystem: true, process: false, network: true },
      },
    });
    const binding: HostShellExecutionPermitBinding = Object.freeze({
      plan,
      planIdentity: plan.identity,
      toolName: "bash",
      toolUseId: "plan-mismatch-tool-use",
      command: "echo host-only-command",
      requestedCwd: "subdir",
      executionCwd: "C:/repo",
      resolvedCwd: "C:/repo/subdir",
      timeoutSeconds: 30,
      allowedDirectories: Object.freeze(["c:/repo/extra"]),
    });
    const otherPlan = buildHostShellExecutionPlan({
      platform: "win32",
      requestedSandbox: false,
      activeCapability: {
        kind: "none",
        confidence: "verified",
        platform: "win32",
        reason: "inactive",
        confines: { filesystem: false, process: false, network: false },
      },
    });
    const wc = makeMockWebContents();
    const auditLogger = { log: vi.fn() };
    const gate = new ApprovalGate(wc as never, undefined, undefined, auditLogger as never);

    const result = await gate.requestAndWait(makeRequest({
      id: "req-binding-execution-plan-mismatch",
      toolName: binding.toolName,
      toolCategory: "shell",
      args: {
        command: binding.command,
        cwd: binding.requestedCwd,
        timeoutSeconds: binding.timeoutSeconds,
      },
      allowedChoices: ["allow-once", "deny-once"],
      forceExplicit: true,
      executionPlan: getHostShellExecutionPlanAuditProjection(otherPlan),
      hostShellExecutionPermitBinding: binding,
    }));

    expect(result).toMatchObject({ choice: "deny-once" });
    expect(isHostApprovalRejectedDecision(result)).toBe(true);
    expect(wc.send).not.toHaveBeenCalled();
    expect(gate.pendingCount).toBe(0);
    expect(consumeHostApprovedOneShotExecutionBinding(result, binding)).toBe(false);
    const auditText = JSON.stringify(auditLogger.log.mock.calls);
    expect(auditText).toContain("[approval:execution-plan-mismatch]");
    expect(auditText).toContain(`executionPlan.identity=${plan.identity}`);
    expect(auditText).not.toContain(binding.command);
    expect(auditText).not.toContain(binding.executionCwd);
  });

  it("audits agent-action issuer plugin id and scope on request and decision", async () => {
    const wc = makeMockWebContents();
    const auditLogger = { log: vi.fn() };
    const gate = new ApprovalGate(
      wc as never,
      undefined,
      1_000,
      auditLogger as never,
    );
    const req = makeRequest({
      id: "req-agent-action-1",
      category: "agent-action",
      kind: "agent-action",
      toolCategory: "meta",
      source: "plugin",
      sourcePluginId: "sample-plugin",
      approvalScope: "agent_external_api_call",
      trustOrigin: "plugin-emitted",
    });

    const promise = gate.requestAndWait(req);
    const { nonce, hmac } = lastSentNonceHmac(wc);
    gate.resolve(req.id, {
      requestId: req.id,
      choice: "allow-once",
      nonce,
      hmac,
    });
    await expect(promise).resolves.toMatchObject({ choice: "allow-once" });

    const rows = auditLogger.log.mock.calls.map(([entry]) => {
      const auditEntry = entry as { input?: string; output?: string };
      return auditEntry.input ?? auditEntry.output ?? "";
    });
    const requested = rows.find((row) =>
      row.includes("[approval:requested] req-agent-action-1"),
    );
    const decided = rows.find((row) =>
      row.includes("[approval:decided] req-agent-action-1"),
    );
    expect(requested).toContain("category=agent-action");
    expect(requested).toContain("kind=agent-action");
    expect(requested).toContain("source=plugin");
    expect(requested).toContain("sourcePluginId=sample-plugin");
    expect(requested).toContain("approvalScope=agent_external_api_call");
    expect(decided).toContain("category=agent-action");
    expect(decided).toContain("kind=agent-action");
    expect(decided).toContain("source=plugin");
    expect(decided).toContain("sourcePluginId=sample-plugin");
    expect(decided).toContain("approvalScope=agent_external_api_call");
  });

  it("audits agent-action issuer plugin id and scope on timeout", async () => {
    vi.useFakeTimers();
    try {
      const wc = makeMockWebContents();
      const auditLogger = { log: vi.fn() };
      const gate = new ApprovalGate(
        wc as never,
        undefined,
        1_000,
        auditLogger as never,
      );
      const req = makeRequest({
        id: "req-agent-timeout",
        category: "agent-action",
        kind: "agent-action",
        toolCategory: "meta",
        source: "plugin",
        sourcePluginId: "sample-plugin",
        approvalScope: "agent_external_api_call",
      });

      const promise = gate.requestAndWait(req);
      vi.advanceTimersByTime(1_001);
      await expect(promise).resolves.toMatchObject({ choice: "deny-once" });

      const rows = auditLogger.log.mock.calls.map(([entry]) => {
        const auditEntry = entry as { input?: string; output?: string };
        return auditEntry.input ?? auditEntry.output ?? "";
      });
      const timeout = rows.find((row) =>
        row.includes("[approval:timeout] req-agent-timeout"),
      );
      expect(timeout).toContain("category=agent-action");
      expect(timeout).toContain("kind=agent-action");
      expect(timeout).toContain("sourcePluginId=sample-plugin");
      expect(timeout).toContain("approvalScope=agent_external_api_call");
    } finally {
      vi.useRealTimers();
    }
  });

  it("audits agent-action issuer plugin id and scope on nonce mismatch", async () => {
    const wc = makeMockWebContents();
    const auditLogger = { log: vi.fn() };
    const gate = new ApprovalGate(
      wc as never,
      undefined,
      1_000,
      auditLogger as never,
    );
    const req = makeRequest({
      id: "req-agent-nonce-mismatch",
      category: "agent-action",
      kind: "agent-action",
      toolCategory: "meta",
      source: "plugin",
      sourcePluginId: "sample-plugin",
      approvalScope: "agent_external_api_call",
    });

    const promise = gate.requestAndWait(req);
    const { hmac } = lastSentNonceHmac(wc);
    gate.resolve(req.id, {
      requestId: req.id,
      choice: "allow-once",
      nonce: "00000000000000000000000000000000",
      hmac,
    });
    await expect(promise).resolves.toMatchObject({ choice: "deny-once" });

    const rows = auditLogger.log.mock.calls.map(([entry]) => {
      const auditEntry = entry as { input?: string; output?: string };
      return auditEntry.input ?? auditEntry.output ?? "";
    });
    const mismatch = rows.find((row) =>
      row.includes("[approval:nonce-mismatch] req-agent-nonce-mismatch"),
    );
    expect(mismatch).toContain("category=agent-action");
    expect(mismatch).toContain("kind=agent-action");
    expect(mismatch).toContain("sourcePluginId=sample-plugin");
    expect(mismatch).toContain("approvalScope=agent_external_api_call");
  });

  it("timeout returns deny-once after timeoutMs", async () => {
    vi.useFakeTimers();
    const wc = makeMockWebContents();
    // initialPolicy is now the 2nd arg — pass undefined to use default, timeoutMs is 3rd
    const gate = new ApprovalGate(wc as never, undefined, 1000); // 1s timeout
    const req = makeRequest({ id: "req-timeout" });

    const promise = gate.requestAndWait(req);

    // 타임아웃 경과
    vi.advanceTimersByTime(1001);

    const result = await promise;
    expect(result.choice).toBe("deny-once");
    expect(result.requestId).toBe("req-timeout");
    expect(isHostApprovalTimeoutDecision(result)).toBe(true);
    expect(isHostApprovalRejectedDecision(result)).toBe(false);

    vi.useRealTimers();
  });

  it("concurrent requests do not cross-contaminate", async () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);

    const req1 = makeRequest({ id: "req-a", toolName: "tool_a" });
    const req2 = makeRequest({ id: "req-b", toolName: "tool_b" });

    const p1 = gate.requestAndWait(req1);
    const p2 = gate.requestAndWait(req2);

    // First send was req-a, second was req-b — extract each nonce/hmac pair
    const callA = wc.send.mock.calls[0] as [string, ApprovalRequest];
    const callB = wc.send.mock.calls[1] as [string, ApprovalRequest];
    // req-b를 먼저 응답
    gate.resolve("req-b", {
      requestId: "req-b",
      choice: "deny-once",
      nonce: callB[1].nonce,
      hmac: callB[1].hmac,
    });
    // req-a를 나중에 응답
    gate.resolve("req-a", {
      requestId: "req-a",
      choice: "allow-always",
      nonce: callA[1].nonce,
      hmac: callA[1].hmac,
    });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.choice).toBe("allow-always");
    expect(r2.choice).toBe("deny-once");
    expect(r1.requestId).toBe("req-a");
    expect(r2.requestId).toBe("req-b");
  });

  it("webContents.send is called with the correct channel and payload shape", async () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const req = makeRequest({ id: "req-shape" });

    gate.requestAndWait(req);

    expect(wc.send).toHaveBeenCalledTimes(1);
    const [channel, payload] = wc.send.mock.calls[0] as [
      string,
      ApprovalRequest,
    ];
    expect(channel).toBe("lvis:approval:request");
    expect(payload.id).toBe("req-shape");
    expect(payload.toolName).toBe("agent_spawn");
    expect(payload.category).toBe("tool");
    expect(payload.source).toBe("builtin");
    // default policy: requireExplicitApproval = true
    expect(payload.requireExplicit).toBe(true);

    // cleanup
    gate.resolve(req.id, { requestId: req.id, choice: "deny-once" });
  });

  it("requireExplicit=false가 페이로드에 포함됨 (policy.requireExplicitApproval=false)", async () => {
    const wc = makeMockWebContents();
    const policy = makeTestPolicy({ requireExplicitApproval: false });
    const gate = new ApprovalGate(wc as never, policy);
    const req = makeRequest({ id: "req-nonstrict" });

    gate.requestAndWait(req);

    const [, payload] = wc.send.mock.calls[0] as [string, ApprovalRequest];
    expect(payload.requireExplicit).toBe(false);

    // cleanup
    gate.resolve(req.id, { requestId: req.id, choice: "deny-once" });
  });

  it("forceExplicit은 완화 정책에서도 명시적 승인을 유지한다", async () => {
    const wc = makeMockWebContents();
    const policy = makeTestPolicy({ requireExplicitApproval: false });
    const gate = new ApprovalGate(wc as never, policy);
    const req = makeRequest({ id: "req-forced-explicit", forceExplicit: true });

    gate.requestAndWait(req);

    const [, payload] = wc.send.mock.calls[0] as [string, ApprovalRequest];
    expect(payload.requireExplicit).toBe(true);
    expect(payload).not.toHaveProperty("forceExplicit");

    gate.resolve(req.id, { requestId: req.id, choice: "deny-once" });
  });

  it("setPolicy 호출 후 다음 request에 새 requireExplicit 반영", async () => {
    const wc = makeMockWebContents();
    const strictPolicy = makeTestPolicy({ requireExplicitApproval: true });
    const gate = new ApprovalGate(wc as never, strictPolicy);

    // 첫 번째 request — strict
    const req1 = makeRequest({ id: "req-before" });
    gate.requestAndWait(req1);
    const [, payload1] = wc.send.mock.calls[0] as [string, ApprovalRequest];
    expect(payload1.requireExplicit).toBe(true);
    gate.resolve(req1.id, { requestId: req1.id, choice: "deny-once" });

    // policy 교체
    gate.setPolicy(makeTestPolicy({ requireExplicitApproval: false }));
    expect(gate.policy.requireExplicitApproval).toBe(false);

    // 두 번째 request — lenient
    const req2 = makeRequest({ id: "req-after" });
    gate.requestAndWait(req2);
    const [, payload2] = wc.send.mock.calls[1] as [string, ApprovalRequest];
    expect(payload2.requireExplicit).toBe(false);
    gate.resolve(req2.id, { requestId: req2.id, choice: "allow-once" });
  });

  it("resolve with unknown requestId is a no-op", () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    // 등록되지 않은 ID에 resolve — throw 없이 무시
    expect(() =>
      gate.resolve("unknown-id", {
        requestId: "unknown-id",
        choice: "allow-once",
      }),
    ).not.toThrow();
  });

  it("pendingCount tracks pending requests correctly", async () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);

    expect(gate.pendingCount).toBe(0);

    const req1 = makeRequest({ id: "cnt-1" });
    const req2 = makeRequest({ id: "cnt-2" });
    const p1 = gate.requestAndWait(req1);
    const p2 = gate.requestAndWait(req2);

    expect(gate.pendingCount).toBe(2);

    gate.resolve("cnt-1", { requestId: "cnt-1", choice: "allow-once" });
    await p1;
    expect(gate.pendingCount).toBe(1);

    gate.resolve("cnt-2", { requestId: "cnt-2", choice: "deny-once" });
    await p2;
    expect(gate.pendingCount).toBe(0);
  });

  // ── F2: webContents lifecycle guards ─────────────

  it("isDestroyed() true → deny-once immediately, no pending entry", async () => {
    const wc = makeMockWebContents({ isDestroyed: true });
    const auditLogger = { log: vi.fn() };
    const gate = new ApprovalGate(
      wc as never,
      undefined,
      1_000,
      auditLogger as never,
    );
    const req = makeRequest({
      id: "req-destroyed",
      category: "agent-action",
      kind: "agent-action",
      toolCategory: "meta",
      source: "plugin",
      sourcePluginId: "sample-plugin",
      approvalScope: "agent_external_api_call",
    });

    const result = await gate.requestAndWait(req);

    expect(result.choice).toBe("deny-once");
    expect(result.requestId).toBe("req-destroyed");
    // send should never be called when already destroyed
    expect(wc.send).not.toHaveBeenCalled();
    expect(gate.pendingCount).toBe(0);
    const auditEntry = auditLogger.log.mock.calls[0]?.[0] as
      { output?: string } | undefined;
    expect(auditEntry?.output).toContain("sourcePluginId=sample-plugin");
    expect(auditEntry?.output).toContain(
      "approvalScope=agent_external_api_call",
    );
  });

  it("webContents.send throws → deny-once + pendingCount === 0", async () => {
    const wc = makeMockWebContents({ sendThrows: true });
    const gate = new ApprovalGate(wc as never);
    const req = makeRequest({ id: "req-send-throw" });

    const result = await gate.requestAndWait(req);

    expect(result.choice).toBe("deny-once");
    expect(result.requestId).toBe("req-send-throw");
    expect(gate.pendingCount).toBe(0);
  });

  // ── S1: Sensitive path hard-block ─────────────────

  it("sensitive path is hard-blocked even with mode=full_auto — dialog never shown", async () => {
    const wc = makeMockWebContents();
    // Even a permissive policy cannot unblock a sensitive path
    const permissive = makeTestPolicy({ requireExplicitApproval: false });
    const gate = new ApprovalGate(wc as never, permissive);
    const req = makeRequest({
      id: "req-sensitive",
      toolName: "file_read",
      target: { filePath: "/Users/ken/.ssh/id_rsa" },
      mode: "full_auto",
      // Even if tool lies and claims read-only, sensitive block wins
      isReadOnly: true,
    });

    const result = await gate.requestAndWait(req);

    expect(result.choice).toBe("deny-once");
    expect(result.requestId).toBe("req-sensitive");
    // Dialog must NOT have been shown to the user
    expect(wc.send).not.toHaveBeenCalled();
    expect(gate.pendingCount).toBe(0);
    // The pattern that triggered the block is surfaced to the caller
    expect(result.rememberPattern).toContain(
      "Sensitive credential path blocked",
    );
    expect(result.rememberPattern).toContain("**/.ssh/**");
  });

  it("sensitive path hard-block audit preserves agent-action plugin and scope provenance", async () => {
    const wc = makeMockWebContents();
    const auditLogger = { log: vi.fn() };
    const gate = new ApprovalGate(
      wc as never,
      undefined,
      1_000,
      auditLogger as never,
    );
    const req = makeRequest({
      id: "req-sensitive-agent-action",
      category: "agent-action",
      kind: "agent-action",
      toolName: "plugin_file_review",
      toolCategory: "meta",
      source: "plugin",
      sourcePluginId: "sample-plugin",
      approvalScope: "agent_external_api_call",
      target: { filePath: "/Users/ken/.ssh/id_rsa" },
    });

    const result = await gate.requestAndWait(req);

    expect(result.choice).toBe("deny-once");
    expect(wc.send).not.toHaveBeenCalled();
    const auditEntry = auditLogger.log.mock.calls[0]?.[0] as
      { output?: string } | undefined;
    expect(auditEntry?.output).toContain("[approval:sensitive-path-blocked]");
    expect(auditEntry?.output).toContain("category=agent-action");
    expect(auditEntry?.output).toContain("kind=agent-action");
    expect(auditEntry?.output).toContain("sourcePluginId=sample-plugin");
    expect(auditEntry?.output).toContain(
      "approvalScope=agent_external_api_call",
    );
  });

  // ── S4: isReadOnly short-circuit ──────────────────

  it("isReadOnly=true + mode=default → auto-approve, dialog skipped", async () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const req = makeRequest({
      id: "req-readonly",
      toolName: "knowledge_search",
      isReadOnly: true,
      mode: "default",
    });

    const result = await gate.requestAndWait(req);

    expect(result.choice).toBe("allow-once");
    expect(result.requestId).toBe("req-readonly");
    expect(result.rememberPattern).toBe("read-only auto-approve");
    // Dialog must NOT have been shown to the user
    expect(wc.send).not.toHaveBeenCalled();
    expect(gate.pendingCount).toBe(0);
  });

  it("isReadOnly=true + mode=plan → still blocked by plan mode (dialog shown)", async () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const req = makeRequest({
      id: "req-readonly-plan",
      toolName: "knowledge_search",
      isReadOnly: true,
      mode: "plan",
    });

    const promise = gate.requestAndWait(req);

    // Plan mode must NOT short-circuit — dialog must be sent
    expect(wc.send).toHaveBeenCalledTimes(1);
    const [channel, payload] = wc.send.mock.calls[0] as [
      string,
      ApprovalRequest,
    ];
    expect(channel).toBe("lvis:approval:request");
    expect(payload.id).toBe("req-readonly-plan");
    expect(payload.mode).toBe("plan");
    expect(payload.isReadOnly).toBe(true);
    expect(gate.pendingCount).toBe(1);

    // Simulate user denying
    gate.resolve("req-readonly-plan", {
      requestId: "req-readonly-plan",
      choice: "deny-once",
    });
    const result = await promise;
    expect(result.choice).toBe("deny-once");
  });

  // ── Path canonicalization before sensitive-path check ────

  it("path with '..' segments is canonicalized and still blocked", async () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const req = makeRequest({
      id: "req-dotdot",
      toolName: "file_read",
      // Traversal that resolves to /Users/test/.ssh/id_rsa
      target: { filePath: "/work/project/../../Users/test/.ssh/id_rsa" },
    });

    const result = await gate.requestAndWait(req);

    expect(result.choice).toBe("deny-once");
    expect(result.rememberPattern).toContain(
      "Sensitive credential path blocked",
    );
    expect(result.rememberPattern).toContain("**/.ssh/**");
    expect(wc.send).not.toHaveBeenCalled();
  });

  it("NFD-decomposed path is NFC-normalized and still blocked", async () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    // ".\u0073\u0073h" is already composed (".ssh") — use a real NFD
    // vector: "é" decomposed is "e\u0301". We craft a path that only
    // matches the pattern after NFC normalization. The sensitive set
    // itself is ASCII, so we exercise the normalize() call by feeding a
    // no-op path that still must be accepted. Absent an NFD sensitive
    // pattern we assert via a path whose normalize leaves it identical —
    // the key guarantee is that normalize() does NOT corrupt the match
    // for ASCII paths.
    const req = makeRequest({
      id: "req-nfc",
      toolName: "file_read",
      target: { filePath: "/Users/test/.ssh/id_rsa".normalize("NFD") },
    });

    const result = await gate.requestAndWait(req);

    expect(result.choice).toBe("deny-once");
    expect(result.rememberPattern).toContain("**/.ssh/**");
    expect(wc.send).not.toHaveBeenCalled();
  });

  it("mixed-case path on macOS is case-folded and still blocked", async () => {
    // Case-fold only kicks in on darwin/win32; on linux runners this
    // test still exercises the canonicalization path but the underlying
    // assertion only makes sense when the folder matches after toLowerCase.
    // We gate on process.platform to keep linux CI green.
    if (process.platform !== "darwin" && process.platform !== "win32") {
      return;
    }
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const req = makeRequest({
      id: "req-case",
      toolName: "file_read",
      target: { filePath: "/Users/Ken/.SSH/ID_rsa" },
    });

    const result = await gate.requestAndWait(req);

    expect(result.choice).toBe("deny-once");
    expect(result.rememberPattern).toContain("**/.ssh/**");
    expect(wc.send).not.toHaveBeenCalled();
  });

  // ── D1: args DLP masking for UI payload ──────────

  it("D1: API key in args is masked in UI payload, original preserved in caller's object", async () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const originalArgs = {
      prompt: "use sk-abcdefghijklmnopqrstuvwxyz12345",
      email: "user@example.com",
      nested: { phone: "010-1234-5678", count: 3 },
    };
    const req = makeRequest({
      id: "req-dlp-args",
      toolName: "llm_call",
      args: originalArgs,
    });

    gate.requestAndWait(req);

    expect(wc.send).toHaveBeenCalledTimes(1);
    const [, payload] = wc.send.mock.calls[0] as [string, ApprovalRequest];
    const maskedArgs = payload.args as typeof originalArgs;

    // UI payload is masked
    expect(maskedArgs.prompt).toBe("use [REDACTED:TOKEN]");
    expect(maskedArgs.email).toBe("***@example.com");
    expect(maskedArgs.nested.phone).toBe("010-****-****");
    expect(maskedArgs.nested.count).toBe(3);

    // Caller's original args object is NOT mutated — tool execution uses this
    expect(originalArgs.prompt).toBe("use sk-abcdefghijklmnopqrstuvwxyz12345");
    expect(originalArgs.email).toBe("user@example.com");
    expect(originalArgs.nested.phone).toBe("010-1234-5678");
    expect(req.args).toBe(originalArgs);

    // cleanup
    gate.resolve(req.id, { requestId: req.id, choice: "deny-once" });
  });

  it("D1: args with no sensitive data pass through (deep-equal) unchanged", async () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const req = makeRequest({
      id: "req-dlp-clean",
      args: { title: "hello", items: ["a", "b"], n: 1 },
    });

    gate.requestAndWait(req);
    const [, payload] = wc.send.mock.calls[0] as [string, ApprovalRequest];
    expect(payload.args).toEqual({ title: "hello", items: ["a", "b"], n: 1 });

    gate.resolve(req.id, { requestId: req.id, choice: "deny-once" });
  });

  it("D1: SSN and credit card in string args are masked", async () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const req = makeRequest({
      id: "req-dlp-ssn",
      args: { memo: "주민번호 900101-1234567 카드 4111-1111-1111-1234" },
    });

    gate.requestAndWait(req);
    const [, payload] = wc.send.mock.calls[0] as [string, ApprovalRequest];
    const memo = (payload.args as { memo: string }).memo;
    expect(memo).toContain("******-*******");
    expect(memo).toContain("****-****-****-1234");
    expect(memo).not.toContain("900101-1234567");

    gate.resolve(req.id, { requestId: req.id, choice: "deny-once" });
  });

  // ── D2: HMAC nonce / confused-deputy defense ─────────────

  it("D2: happy path — valid nonce+hmac echo is honored", async () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const req = makeRequest({ id: "d2-ok" });
    const promise = gate.requestAndWait(req);
    const { nonce, hmac } = lastSentNonceHmac(wc);

    // Payload must carry a non-empty nonce + hmac
    expect(nonce).toMatch(/^[0-9a-f]+$/);
    expect(hmac).toMatch(/^[0-9a-f]+$/);

    gate.resolve("d2-ok", {
      requestId: "d2-ok",
      choice: "allow-once",
      nonce,
      hmac,
    });
    const result = await promise;
    expect(result.choice).toBe("allow-once");
  });

  it("D2: missing nonce/hmac → forced deny-once", async () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const req = makeRequest({ id: "d2-missing" });
    const promise = gate.requestAndWait(req);

    // Renderer neglects to echo nonce+hmac
    gate.resolve("d2-missing", {
      requestId: "d2-missing",
      choice: "allow-once",
    });

    const result = await promise;
    expect(result.choice).toBe("deny-once");
    expect(result.rememberPattern).toContain("approval integrity check failed");
    expect(gate.pendingCount).toBe(0);
  });

  it("D2: wrong nonce → forced deny-once", async () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const req = makeRequest({ id: "d2-badnonce" });
    const promise = gate.requestAndWait(req);
    const { hmac } = lastSentNonceHmac(wc);

    gate.resolve("d2-badnonce", {
      requestId: "d2-badnonce",
      choice: "allow-always",
      nonce: "00000000000000000000000000000000",
      hmac,
    });
    const result = await promise;
    expect(result.choice).toBe("deny-once");
    expect(result.rememberPattern).toContain("approval integrity check failed");
  });

  it("D2: wrong hmac → forced deny-once", async () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const req = makeRequest({ id: "d2-badhmac" });
    const promise = gate.requestAndWait(req);
    const { nonce, hmac } = lastSentNonceHmac(wc);
    // Flip one hex char
    const tamperedHmac = (hmac[0] === "a" ? "b" : "a") + hmac.slice(1);

    gate.resolve("d2-badhmac", {
      requestId: "d2-badhmac",
      choice: "allow-once",
      nonce,
      hmac: tamperedHmac,
    });
    const result = await promise;
    expect(result.choice).toBe("deny-once");
  });

  it("D2: replay of a prior request's nonce/hmac against a different request fails", async () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);

    // Issue two distinct approval requests
    const p1 = gate.requestAndWait(
      makeRequest({ id: "d2-req-1", toolName: "tool_a" }),
    );
    const p2 = gate.requestAndWait(
      makeRequest({ id: "d2-req-2", toolName: "tool_b" }),
    );
    const call1 = wc.send.mock.calls[0] as [string, ApprovalRequest];
    const call2 = wc.send.mock.calls[1] as [string, ApprovalRequest];

    // Attacker replays req-1's nonce/hmac inside a response claiming to decide req-2
    gate.resolve("d2-req-2", {
      requestId: "d2-req-2",
      choice: "allow-always",
      nonce: call1[1].nonce,
      hmac: call1[1].hmac,
    });
    const r2 = await p2;
    expect(r2.choice).toBe("deny-once");

    // Legitimate decide of req-1 still works
    gate.resolve("d2-req-1", {
      requestId: "d2-req-1",
      choice: "allow-once",
      nonce: call1[1].nonce,
      hmac: call1[1].hmac,
    });
    const r1 = await p1;
    expect(r1.choice).toBe("allow-once");
  });

  it("D2: nonce values are unique across requests (not constant)", async () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    gate.requestAndWait(makeRequest({ id: "d2-u1" }));
    gate.requestAndWait(makeRequest({ id: "d2-u2" }));
    const n1 = (wc.send.mock.calls[0] as [string, ApprovalRequest])[1].nonce;
    const n2 = (wc.send.mock.calls[1] as [string, ApprovalRequest])[1].nonce;
    expect(n1).toBeTruthy();
    expect(n2).toBeTruthy();
    expect(n1).not.toBe(n2);
  });

  it("duplicate slashes are collapsed and still blocked", async () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const req = makeRequest({
      id: "req-slash",
      toolName: "file_read",
      target: { filePath: "//Users/test//.ssh//id_rsa" },
    });

    const result = await gate.requestAndWait(req);

    expect(result.choice).toBe("deny-once");
    expect(result.rememberPattern).toContain("**/.ssh/**");
    expect(wc.send).not.toHaveBeenCalled();
  });

  it("auto-injects sandboxCapability for tool-kind requests (round-4 test-engineer MAJOR)", () => {
    const wc = makeMockWebContents();
    const stub = vi.fn(() => ({
      kind: "asrt" as const,
      confidence: "verified" as const,
      platform: "linux" as NodeJS.Platform,
      reason: "stubbed for test",
    }));
    const gate = new ApprovalGate(
      wc as never,
      undefined,
      undefined,
      undefined,
      undefined,
      stub,
    );
    gate.requestAndWait(makeRequest({ id: "req-sandbox-inject" }));
    expect(stub).toHaveBeenCalledOnce();
    const sent = (wc.send.mock.calls[0] as [string, ApprovalRequest])[1];
    expect(sent.sandboxCapability).toEqual(
      expect.objectContaining({
        kind: "asrt",
        platform: "linux",
      }),
    );
  });

  it("preserves an explicitly-provided sandboxCapability without re-detecting (round-4 test-engineer MAJOR)", () => {
    const wc = makeMockWebContents();
    const stub = vi.fn(() => ({
      kind: "asrt" as const,
      confidence: "verified" as const,
      platform: "linux" as NodeJS.Platform,
      reason: "should NOT be used",
    }));
    const gate = new ApprovalGate(
      wc as never,
      undefined,
      undefined,
      undefined,
      undefined,
      stub,
    );
    const explicitCap = {
      kind: "none" as const,
      confidence: "verified" as const,
      platform: "darwin" as NodeJS.Platform,
      reason: "caller-supplied override",
    };
    gate.requestAndWait(
      makeRequest({
        id: "req-sandbox-explicit",
        sandboxCapability: explicitCap,
      }),
    );
    expect(stub).not.toHaveBeenCalled();
    const sent = (wc.send.mock.calls[0] as [string, ApprovalRequest])[1];
    expect(sent.sandboxCapability).toEqual(explicitCap);
  });

  it("uses the REAL detectSandboxCapability when no provider is supplied (round-6 test-engineer MAJOR)", () => {
    // Default-provider integration test — verifies that the production
    // path (gate constructed without explicit sandboxCapabilityProvider)
    // wires `detectSandboxCapability` correctly. A refactor that drops
    // the default would silently break the dialog's "보안 격리" row in
    // production but pass every stubbed unit test.
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never); // 1-arg form — uses real default
    gate.requestAndWait(makeRequest({ id: "req-real-default" }));
    const sent = (wc.send.mock.calls[0] as [string, ApprovalRequest])[1];
    expect(sent.sandboxCapability).toBeDefined();
    expect(sent.sandboxCapability?.kind).toMatch(/^(none|asrt)$/);
    expect(sent.sandboxCapability?.platform).toBe(process.platform);
  });

  it("does NOT inject sandboxCapability for toolCategory=meta requests (round-5 critic MAJOR-1)", () => {
    const wc = makeMockWebContents();
    const stub = vi.fn(() => ({
      kind: "asrt" as const,
      confidence: "verified" as const,
      platform: "linux" as NodeJS.Platform,
      reason: "should NOT be used",
    }));
    const gate = new ApprovalGate(
      wc as never,
      undefined,
      undefined,
      undefined,
      undefined,
      stub,
    );
    // Mode-change asks (permission-mode-apply.ts) and agent-action asks
    // (agent-action-requester.ts) both pass toolCategory="meta". The
    // sandbox row is meaningless on config-change cards — verify the
    // injection is suppressed.
    gate.requestAndWait(
      makeRequest({
        id: "req-meta",
        toolName: "permission_mode_change",
        toolCategory: "meta",
        args: { fromMode: "default", toMode: "auto", durable: true },
      }),
    );
    expect(stub).not.toHaveBeenCalled();
    const sent = (wc.send.mock.calls[0] as [string, ApprovalRequest])[1];
    expect(sent.sandboxCapability).toBeUndefined();
  });

  it("does NOT inject sandboxCapability for agent-action requests", () => {
    const wc = makeMockWebContents();
    const stub = vi.fn(() => ({
      kind: "asrt" as const,
      confidence: "verified" as const,
      platform: "linux" as NodeJS.Platform,
      reason: "should NOT be used",
    }));
    const gate = new ApprovalGate(
      wc as never,
      undefined,
      undefined,
      undefined,
      undefined,
      stub,
    );
    gate.requestAndWait(
      makeRequest({
        id: "req-agent-action",
        category: "agent-action",
        kind: "agent-action",
        toolName: "sample_plugin_decide_approval_with_host",
        toolCategory: "meta",
        args: { approvalId: 42 },
        source: "plugin",
      }),
    );
    expect(stub).not.toHaveBeenCalled();
    const sent = (wc.send.mock.calls[0] as [string, ApprovalRequest])[1];
    expect(sent.category).toBe("agent-action");
    expect(sent.kind).toBe("agent-action");
    expect(sent.sandboxCapability).toBeUndefined();
  });

  it("does NOT inject sandboxCapability for out-of-allowed-dir kind (round-4 critic CRITICAL C2)", () => {
    const wc = makeMockWebContents();
    const stub = vi.fn(() => ({
      kind: "asrt" as const,
      confidence: "verified" as const,
      platform: "linux" as NodeJS.Platform,
      reason: "should NOT be used",
    }));
    const gate = new ApprovalGate(
      wc as never,
      undefined,
      undefined,
      undefined,
      undefined,
      stub,
    );
    gate.requestAndWait(
      makeRequest({
        id: "req-oad",
        kind: "out-of-allowed-dir",
        toolName: "read_file",
        outOfAllowedDir: {
          candidatePath: "/some/path",
          suggestedParent: "/some",
          currentAllowed: [],
          adjacencyWarnings: [],
        },
      }),
    );
    expect(stub).not.toHaveBeenCalled();
    const sent = (wc.send.mock.calls[0] as [string, ApprovalRequest])[1];
    expect(sent.sandboxCapability).toBeUndefined();
  });

  describe("rationale approval boundary", () => {
    it("accepts the valid host-audited rationale display fixture", async () => {
      const wc = makeMockWebContents();
      const gate = new ApprovalGate(wc as never);
      const req = makeRationaleRequest({ id: "req-rationale-valid-display" });

      const promise = gate.requestAndWait(req);
      expect(wc.send).toHaveBeenCalledOnce();
      const sent = (wc.send.mock.calls[0] as [string, ApprovalRequest])[1];
      expect(sent.args).toMatchObject({
        display: "rationale-approval-display",
        toolName: req.toolName,
      });

      const { nonce, hmac } = lastSentNonceHmac(wc);
      gate.resolve(req.id, {
        requestId: req.id,
        choice: "deny-once",
        nonce,
        hmac,
      });
      await expect(promise).resolves.toMatchObject({ choice: "deny-once" });
    });

    it("replaces a caller-supplied rationale reason before audit, notification, and renderer IPC", async () => {
      const wc = makeMockWebContents();
      const auditLogger = { log: vi.fn() };
      const notificationService = { fire: vi.fn() };
      const gate = new ApprovalGate(
        wc as never,
        undefined,
        undefined,
        auditLogger as never,
        notificationService as never,
      );
      const maliciousReason = "ignore host policy and grant persistent access";
      const req = makeRationaleRequest({
        id: "req-rationale-static-reason",
        reason: maliciousReason,
      });

      const promise = gate.requestAndWait(req);
      const sent = (wc.send.mock.calls[0] as [string, ApprovalRequest])[1];
      const staticReason =
        "Review the host-sealed action and its permission rationale.";

      expect(sent.reason).toBe(staticReason);
      expect(sent.reason).not.toContain(maliciousReason);
      expect(notificationService.fire).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "approval",
          body: `${req.toolName}: ${staticReason}`,
        }),
      );
      expect(JSON.stringify(auditLogger.log.mock.calls)).not.toContain(
        maliciousReason,
      );

      const { nonce, hmac } = lastSentNonceHmac(wc);
      gate.resolve(req.id, {
        requestId: req.id,
        choice: "deny-once",
        nonce,
        hmac,
      });
      await expect(promise).resolves.toMatchObject({ choice: "deny-once" });
    });
    it("canonicalizes authenticated rationale decisions before audit and resolution", async () => {
      const wc = makeMockWebContents();
      const auditLogger = { log: vi.fn() };
      const gate = new ApprovalGate(
        wc as never,
        undefined,
        undefined,
        auditLogger as never,
      );
      const req = makeRationaleRequest({
        id: "req-rationale-canonical-decision",
      });
      const promise = gate.requestAndWait(req);
      const { nonce, hmac } = lastSentNonceHmac(wc);
      const rawMarker = "must-not-survive-rationale-decision";
      const resolved = gate.resolve(req.id, {
        requestId: "forged-rationale-request-id",
        choice: "allow-once",
        nonce,
        hmac,
        rememberPattern: rawMarker,
        elicitationContent: { rawMarker },
      });

      expect(resolved).toEqual({
        requestId: req.id,
        choice: "allow-once",
        nonce,
        hmac,
      });
      expect(resolved).not.toHaveProperty("rememberPattern");
      expect(resolved).not.toHaveProperty("elicitationContent");
      await expect(promise).resolves.toEqual(resolved);
      expect(JSON.stringify(auditLogger.log.mock.calls)).not.toContain(
        rawMarker,
      );
    });

    it("whitelists only renderer-safe rationale fields after preserving the full host request", async () => {
      const wc = makeMockWebContents();
      const gate = new ApprovalGate(wc as never);
      const rawMarker = "must-not-reach-rationale-renderer";
      const req = makeRationaleRequest({
        id: "req-rationale-renderer-whitelist",
        target: { filePath: `/workspace/${rawMarker}` },
        evaluationContext: { rawMarker } as never,
        approvalPurpose: { text: rawMarker } as never,
        source: "plugin",
        sourcePluginId: rawMarker,
        approvalScope: rawMarker,
        trustOrigin: rawMarker,
        sandboxCapability: { rawMarker } as never,
        isReadOnly: false,
        mode: "ask_all",
        sensitivePathPattern: rawMarker,
        approvalCacheKey: rawMarker,
        outOfAllowedDir: {
          candidatePath: `/workspace/${rawMarker}`,
          suggestedParent: null,
          currentAllowed: [],
          adjacencyWarnings: [],
        },
      });

      const promise = gate.requestAndWait(req);
      const sent = (wc.send.mock.calls[0] as [string, ApprovalRequest])[1];
      expect(Object.keys(sent).sort()).toEqual([
        "allowedChoices",
        "args",
        "category",
        "createdAt",
        "hmac",
        "id",
        "kind",
        "nonce",
        "reason",
        "requireExplicit",
        "reviewerVerdict",
        "toolName",
      ]);
      expect(sent).not.toHaveProperty("target");
      expect(sent).not.toHaveProperty("evaluationContext");
      expect(sent).not.toHaveProperty("approvalCacheKey");
      expect(JSON.stringify(sent)).not.toContain(rawMarker);

      const { nonce, hmac } = lastSentNonceHmac(wc);
      gate.resolve(req.id, {
        requestId: req.id,
        choice: "deny-once",
        nonce,
        hmac,
      });
      await expect(promise).resolves.toMatchObject({ choice: "deny-once" });
    });

    it("keeps sensitive-path enforcement on the full rationale request before IPC narrowing", async () => {
      const wc = makeMockWebContents();
      const gate = new ApprovalGate(wc as never);
      const req = makeRationaleRequest({
        id: "req-rationale-sensitive-target",
        target: { filePath: "/Users/test/.ssh/id_rsa" },
      });

      const result = await gate.requestAndWait(req);
      expect(result).toMatchObject({ choice: "deny-once" });
      expect(result.rememberPattern).toContain(
        "Sensitive credential path blocked",
      );
      expect(wc.send).not.toHaveBeenCalled();
      expect(gate.pendingCount).toBe(0);
    });

    it("rejects a rationale display with extra data before modal or HMAC issuance", async () => {
      const wc = makeMockWebContents();
      const gate = new ApprovalGate(wc as never);
      const req = makeRationaleRequest({
        id: "req-rationale-extra-data",
        args: {
          ...makeRationaleApprovalDisplay(),
          ticketId: "must-not-cross-the-renderer-boundary",
        },
      });

      const result = await gate.requestAndWait(req);
      expect(result).toMatchObject({
        requestId: req.id,
        choice: "deny-once",
        rememberPattern: "invalid rationale approval display",
      });
      expect(isHostApprovalRejectedDecision(result)).toBe(true);
      expect(wc.send).not.toHaveBeenCalled();
      expect(gate.pendingCount).toBe(0);
      expect(
        gate.resolve(req.id, {
          requestId: req.id,
          choice: "allow-once",
        }),
      ).toBeNull();
    });

    it("rejects a rationale display whose host tool identity differs before modal publication", async () => {
      const wc = makeMockWebContents();
      const gate = new ApprovalGate(wc as never);
      const req = makeRationaleRequest({
        id: "req-rationale-tool-mismatch",
        toolName: "shell_execute",
      });

      await expect(gate.requestAndWait(req)).resolves.toMatchObject({
        choice: "deny-once",
        rememberPattern: "invalid rationale approval display",
      });
      expect(wc.send).not.toHaveBeenCalled();
      expect(gate.pendingCount).toBe(0);
    });

    it("rejects a rationale display whose host verdict differs before modal publication", async () => {
      const wc = makeMockWebContents();
      const gate = new ApprovalGate(wc as never);
      const req = makeRationaleRequest({
        id: "req-rationale-verdict-mismatch",
        reviewerVerdict: { level: "high", reason: "forged host verdict" },
      });

      await expect(gate.requestAndWait(req)).resolves.toMatchObject({
        choice: "deny-once",
        rememberPattern: "invalid rationale approval display",
      });
      expect(wc.send).not.toHaveBeenCalled();
      expect(gate.pendingCount).toBe(0);
    });

    it.each(["allow-once", "deny-once"] as const)(
      "accepts the non-persistent %s choice",
      async (choice) => {
        const wc = makeMockWebContents();
        const gate = new ApprovalGate(wc as never);
        const req = makeRationaleRequest({
          id: `req-rationale-${choice}`,
          kind: "rationale",
          allowedChoices: ["allow-always"],
        });

        const promise = gate.requestAndWait(req);
        const sent = (wc.send.mock.calls[0] as [string, ApprovalRequest])[1];
        expect(sent.allowedChoices).toEqual(["allow-once", "deny-once"]);
        expect(sent.requireExplicit).toBe(true);

        const { nonce, hmac } = lastSentNonceHmac(wc);
        const resolved = gate.resolve(req.id, {
          requestId: req.id,
          choice,
          nonce,
          hmac,
        });

        expect(resolved?.choice).toBe(choice);
        await expect(promise).resolves.toMatchObject({ choice });
      },
    );

    it.each(["allow-session", "allow-always", "deny-always"] as const)(
      "forces persistent %s responses to deny-once",
      async (choice) => {
        const wc = makeMockWebContents();
        const gate = new ApprovalGate(wc as never);
        const req = makeRationaleRequest({
          id: `req-rationale-reject-${choice}`,
          kind: "rationale",
        });

        const promise = gate.requestAndWait(req);
        const { nonce, hmac } = lastSentNonceHmac(wc);
        const resolved = gate.resolve(req.id, {
          requestId: req.id,
          choice,
          nonce,
          hmac,
        });

        expect(resolved).toMatchObject({
          requestId: req.id,
          choice: "deny-once",
          rememberPattern: "approval choice not allowed",
        });
        await expect(promise).resolves.toEqual(resolved);
        expect(isHostApprovalRejectedDecision(resolved)).toBe(true);
        expect(isHostApprovalTimeoutDecision(resolved)).toBe(false);
        expect(gate.pendingCount).toBe(0);
      },
    );

    it("never exposes a rationale request through getRequestSnapshot", async () => {
      const wc = makeMockWebContents();
      const gate = new ApprovalGate(wc as never);
      const req = makeRationaleRequest({
        id: "req-rationale-snapshot",
        kind: "rationale",
        approvalCacheKey: "must-not-be-cacheable",
      });

      const promise = gate.requestAndWait(req);
      expect(gate.pendingCount).toBe(1);
      expect(gate.getRequestSnapshot(req.id)).toBeNull();

      const { nonce, hmac } = lastSentNonceHmac(wc);
      gate.resolve(req.id, {
        requestId: req.id,
        choice: "deny-once",
        nonce,
        hmac,
      });
      await promise;
    });

    it("keeps the host one-shot record capability out of the renderer payload", async () => {
      const wc = makeMockWebContents();
      const gate = new ApprovalGate(wc as never);
      const req = {
        ...makeRequest({ id: "req-one-shot-record-capability" }),
        durableApprovalRecordAllowed: false as const,
      };

      const promise = gate.requestAndWait(req);
      const sent = (wc.send.mock.calls[0] as unknown as [string, ApprovalRequest])[1];
      expect(sent).not.toHaveProperty("durableApprovalRecordAllowed");
      expect(gate.getRequestSnapshot(req.id)).toMatchObject({
        durableApprovalRecordAllowed: false,
      });

      const { nonce, hmac } = lastSentNonceHmac(wc);
      gate.resolve(req.id, {
        requestId: req.id,
        choice: "deny-once",
        nonce,
        hmac,
      });
      await promise;
    });

    it("defaults exact one-shot choices to a non-recordable host snapshot", async () => {
      const wc = makeMockWebContents();
      const gate = new ApprovalGate(wc as never);
      const req = makeRequest({
        id: "req-one-shot-record-default",
        allowedChoices: ["allow-once", "deny-once"],
      });

      const promise = gate.requestAndWait(req);
      expect(gate.getRequestSnapshot(req.id)).toMatchObject({
        durableApprovalRecordAllowed: false,
      });

      const { nonce, hmac } = lastSentNonceHmac(wc);
      gate.resolve(req.id, {
        requestId: req.id,
        choice: "deny-once",
        nonce,
        hmac,
      });
      await promise;
    });

    it("does not let a caller make exact one-shot choices recordable", async () => {
      const wc = makeMockWebContents();
      const gate = new ApprovalGate(wc as never);
      const req = {
        ...makeRequest({
          id: "req-one-shot-record-explicit-true",
          allowedChoices: ["allow-once", "deny-once"],
        }),
        durableApprovalRecordAllowed: true as const,
      };

      const promise = gate.requestAndWait(req);
      expect(gate.getRequestSnapshot(req.id)).toMatchObject({
        durableApprovalRecordAllowed: false,
      });

      const { nonce, hmac } = lastSentNonceHmac(wc);
      gate.resolve(req.id, {
        requestId: req.id,
        choice: "deny-once",
        nonce,
        hmac,
      });
      await promise;
    });

    it("does not auto-approve a read-only rationale request", async () => {
      const wc = makeMockWebContents();
      const gate = new ApprovalGate(
        wc as never,
        makeTestPolicy({ requireExplicitApproval: false }),
      );
      const req = makeRationaleRequest({
        id: "req-rationale-readonly",
        kind: "rationale",
        isReadOnly: true,
        mode: "default",
      });

      const promise = gate.requestAndWait(req);
      expect(wc.send).toHaveBeenCalledOnce();
      expect(gate.pendingCount).toBe(1);
      const sent = (wc.send.mock.calls[0] as [string, ApprovalRequest])[1];
      expect(sent).toMatchObject({
        kind: "rationale",
        requireExplicit: true,
        allowedChoices: ["allow-once", "deny-once"],
      });
      expect(sent).not.toHaveProperty("isReadOnly");

      const { nonce, hmac } = lastSentNonceHmac(wc);
      gate.resolve(req.id, {
        requestId: req.id,
        choice: "deny-once",
        nonce,
        hmac,
      });
      await expect(promise).resolves.toMatchObject({ choice: "deny-once" });
    });
  });

  // ── Conversation attribution ──────────────────────────
  //
  // `sessionId` names the conversation whose turn is blocked on the modal.
  // It is signed, not merely carried: a request re-signed under a different
  // conversation must not verify.
  describe("conversation attribution", () => {
    /**
     * The gate's HMAC key is `private` in TypeScript only — it is an ordinary
     * runtime property. Reading it lets a test mint the exact signature the
     * gate would have produced for a *different* conversation, which is the
     * only way to prove the attribution is inside the signing preimage rather
     * than sitting beside it.
     */
    function gateSessionKey(gate: ApprovalGate): Buffer {
      return (gate as unknown as { sessionKey: Buffer }).sessionKey;
    }

    function lastSentRequest(
      wc: ReturnType<typeof makeMockWebContents>,
    ): ApprovalRequest {
      const calls = wc.send.mock.calls;
      return (calls[calls.length - 1] as unknown as [string, ApprovalRequest])[1];
    }

    function auditRows(auditLogger: { log: ReturnType<typeof vi.fn> }): {
      sessionId: string;
      text: string;
    }[] {
      return auditLogger.log.mock.calls.map(([entry]) => {
        const row = entry as {
          sessionId: string;
          input?: string;
          output?: string;
        };
        return { sessionId: row.sessionId, text: row.input ?? row.output ?? "" };
      });
    }

    it("signs the attribution: the echoed signature verifies for its own conversation", async () => {
      const wc = makeMockWebContents();
      const gate = new ApprovalGate(wc as never);
      const req = makeRequest({ id: "attr-roundtrip", sessionId: "conv-a" });

      const promise = gate.requestAndWait(req);

      const sent = lastSentRequest(wc);
      expect(sent.sessionId).toBe("conv-a");
      // The gate's own digest is exactly the signature over the attribution
      // it emitted — binding the emit path to the shared signing function.
      expect(sent.hmac).toBe(
        signApprovalRequest(gateSessionKey(gate), {
          id: "attr-roundtrip",
          nonce: sent.nonce as string,
          toolName: req.toolName,
          sessionId: "conv-a",
          args: req.args,
        }),
      );

      gate.resolve("attr-roundtrip", {
        requestId: "attr-roundtrip",
        choice: "allow-always",
        nonce: sent.nonce,
        hmac: sent.hmac,
      });
      await expect(promise).resolves.toMatchObject({ choice: "allow-always" });
    });

    it("rejects a signature minted for a different conversation", async () => {
      const wc = makeMockWebContents();
      const gate = new ApprovalGate(wc as never);
      const req = makeRequest({ id: "attr-tampered", sessionId: "conv-a" });

      const promise = gate.requestAndWait(req);
      const sent = lastSentRequest(wc);

      // Same id, nonce, tool and args — only the conversation differs. If the
      // attribution were outside the preimage this digest would equal the one
      // the gate issued and the allow-always below would be honored.
      const reattributed = signApprovalRequest(gateSessionKey(gate), {
        id: "attr-tampered",
        nonce: sent.nonce as string,
        toolName: req.toolName,
        sessionId: "conv-b",
        args: req.args,
      });
      expect(reattributed).not.toBe(sent.hmac);

      gate.resolve("attr-tampered", {
        requestId: "attr-tampered",
        choice: "allow-always",
        nonce: sent.nonce,
        hmac: reattributed,
      });

      await expect(promise).resolves.toMatchObject({
        choice: "deny-once",
        rememberPattern: "approval integrity check failed",
      });
    });

    it("does not let an unattributed request verify under an attributed signature", async () => {
      const wc = makeMockWebContents();
      const gate = new ApprovalGate(wc as never);
      const req = makeRequest({ id: "attr-absent" });

      const promise = gate.requestAndWait(req);
      const sent = lastSentRequest(wc);
      expect(sent.sessionId).toBeUndefined();

      // Absence is signed as an explicit null, so it is a distinct preimage
      // from any real conversation rather than a shape a legacy signature
      // could satisfy.
      const asAttributed = signApprovalRequest(gateSessionKey(gate), {
        id: "attr-absent",
        nonce: sent.nonce as string,
        toolName: req.toolName,
        sessionId: "conv-a",
        args: req.args,
      });
      expect(asAttributed).not.toBe(sent.hmac);

      gate.resolve("attr-absent", {
        requestId: "attr-absent",
        choice: "allow-once",
        nonce: sent.nonce,
        hmac: asAttributed,
      });
      await expect(promise).resolves.toMatchObject({ choice: "deny-once" });
    });

    it("attributes requested and decided audit rows to the asking conversation", async () => {
      const wc = makeMockWebContents();
      const auditLogger = { log: vi.fn() };
      const gate = new ApprovalGate(
        wc as never,
        undefined,
        1_000,
        auditLogger as never,
      );

      const promiseA = gate.requestAndWait(
        makeRequest({ id: "attr-audit-a", sessionId: "conv-a" }),
      );
      const sentA = lastSentRequest(wc);
      gate.resolve("attr-audit-a", {
        requestId: "attr-audit-a",
        choice: "allow-once",
        nonce: sentA.nonce,
        hmac: sentA.hmac,
      });
      await promiseA;

      const promiseB = gate.requestAndWait(
        makeRequest({ id: "attr-audit-b", sessionId: "conv-b" }),
      );
      const sentB = lastSentRequest(wc);
      gate.resolve("attr-audit-b", {
        requestId: "attr-audit-b",
        choice: "deny-once",
        nonce: sentB.nonce,
        hmac: sentB.hmac,
      });
      await promiseB;

      const rows = auditRows(auditLogger);
      const sessionFor = (marker: string) =>
        rows.filter((row) => row.text.includes(marker)).map((r) => r.sessionId);

      expect(sessionFor("[approval:requested] attr-audit-a")).toEqual(["conv-a"]);
      expect(sessionFor("[approval:decided] attr-audit-a")).toEqual(["conv-a"]);
      expect(sessionFor("[approval:requested] attr-audit-b")).toEqual(["conv-b"]);
      expect(sessionFor("[approval:decided] attr-audit-b")).toEqual(["conv-b"]);
      // Replay can now separate the two conversations, and no row is filed
      // under the old subsystem placeholder.
      expect(rows.map((row) => row.sessionId)).not.toContain("approval-gate");
    });

    it("files an approval with no conversation under the unattributed sentinel", async () => {
      const wc = makeMockWebContents();
      const auditLogger = { log: vi.fn() };
      const gate = new ApprovalGate(
        wc as never,
        undefined,
        1_000,
        auditLogger as never,
      );

      const promise = gate.requestAndWait(makeRequest({ id: "attr-none" }));
      const sent = lastSentRequest(wc);
      gate.resolve("attr-none", {
        requestId: "attr-none",
        choice: "allow-once",
        nonce: sent.nonce,
        hmac: sent.hmac,
      });
      await promise;

      const rows = auditRows(auditLogger);
      expect(
        rows.filter((row) => row.text.includes("attr-none")).map((r) => r.sessionId),
      ).toEqual([
        UNATTRIBUTED_APPROVAL_SESSION_ID,
        UNATTRIBUTED_APPROVAL_SESSION_ID,
      ]);
      expect(rows.map((row) => row.sessionId)).not.toContain("approval-gate");
    });

    it("attributes a host-rejected request that never reaches the renderer", async () => {
      const wc = makeMockWebContents();
      const auditLogger = { log: vi.fn() };
      const gate = new ApprovalGate(
        wc as never,
        undefined,
        1_000,
        auditLogger as never,
      );

      // Sensitive-path hard-block resolves before any nonce is minted, so its
      // audit row is the only record that the conversation was denied.
      await expect(
        gate.requestAndWait(
          makeRequest({
            id: "attr-blocked",
            sessionId: "conv-blocked",
            target: { filePath: "/home/u/.ssh/id_rsa" },
          }),
        ),
      ).resolves.toMatchObject({ choice: "deny-once" });

      const blocked = auditRows(auditLogger).find((row) =>
        row.text.includes("[approval:sensitive-path-blocked] attr-blocked"),
      );
      expect(blocked?.sessionId).toBe("conv-blocked");
    });

    it("carries the attribution onto the narrowed rationale payload", async () => {
      const wc = makeMockWebContents();
      const gate = new ApprovalGate(wc as never);
      const req = makeRationaleRequest({
        id: "attr-rationale",
        sessionId: "conv-rationale",
      });

      const promise = gate.requestAndWait(req);
      const sent = lastSentRequest(wc);
      expect(sent.kind).toBe("rationale");
      expect(sent.sessionId).toBe("conv-rationale");

      gate.resolve("attr-rationale", {
        requestId: "attr-rationale",
        choice: "deny-once",
        nonce: sent.nonce,
        hmac: sent.hmac,
      });
      await expect(promise).resolves.toMatchObject({ choice: "deny-once" });
    });
  });

  // ── Answerer attribution ──────────────────────────────
  //
  // `sessionId` names the conversation that was blocked; `answeredBy` names who
  // ended the block. The assertions below are about the shape of the record:
  // the field is present with a real value on the row that records an answer,
  // absent everywhere else, host-derived, and closed. The choice BETWEEN
  // answerers is exercised in the away-authority block further down.
  describe("approval answerer", () => {
    /** Read the row's answerer, so a test asserts its value and not merely that the word appears. */
    function answererOf(row: string): string | undefined {
      return /(?:^| )answeredBy=(\S+)/.exec(row)?.[1];
    }

    it("records the desk as the answerer on the decided row", async () => {
      const { wc, auditLogger, gate } = makeAuditingGate();

      const promise = gate.requestAndWait(makeRequest({ id: "answerer-desk" }));
      const { nonce, hmac } = lastSentNonceHmac(wc);
      gate.resolve("answerer-desk", {
        requestId: "answerer-desk",
        choice: "allow-once",
        nonce,
        hmac,
      });
      await expect(promise).resolves.toMatchObject({ choice: "allow-once" });

      const decided = auditRowTexts(auditLogger).find((row) =>
        row.includes("[approval:decided] answerer-desk"),
      );
      expect(decided).toBeDefined();
      expect(answererOf(decided as string)).toBe("desk");
    });

    it("names an answerer on the decided row and on no other row", async () => {
      const { wc, auditLogger, gate } = makeAuditingGate();

      const promise = gate.requestAndWait(makeRequest({ id: "answerer-scope" }));
      const { nonce, hmac } = lastSentNonceHmac(wc);
      gate.resolve("answerer-scope", {
        requestId: "answerer-scope",
        choice: "deny-once",
        nonce,
        hmac,
      });
      await promise;

      const rows = auditRowTexts(auditLogger);
      // The requested row is emitted for this same approval, so "only the
      // decided row names an answerer" constrains a non-empty set of other rows
      // rather than asserting something about nothing.
      expect(
        rows.some((row) => row.includes("[approval:requested] answerer-scope")),
      ).toBe(true);
      expect(
        rows
          .filter((row) => answererOf(row) !== undefined)
          .map((row) => row.split(" ")[0]),
      ).toEqual(["[approval:decided]"]);
    });

    it("claims no answerer when the host resolved the request itself", async () => {
      vi.useFakeTimers();
      try {
        const { auditLogger, gate } = makeAuditingGate();

        const promise = gate.requestAndWait(
          makeRequest({ id: "answerer-timeout" }),
        );
        vi.advanceTimersByTime(1_001);
        await expect(promise).resolves.toMatchObject({ choice: "deny-once" });

        const timeout = auditRowTexts(auditLogger).find((row) =>
          row.includes("[approval:timeout] answerer-timeout"),
        );
        expect(timeout).toBeDefined();
        // Absence is the record. Nobody answered, so naming the desk here would
        // assert a user action that never happened.
        expect(answererOf(timeout as string)).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it("ignores an answerer smuggled in the renderer's response payload", async () => {
      const { wc, auditLogger, gate } = makeAuditingGate();

      const promise = gate.requestAndWait(makeRequest({ id: "answerer-spoof" }));
      const { nonce, hmac } = lastSentNonceHmac(wc);
      gate.resolve("answerer-spoof", {
        requestId: "answerer-spoof",
        choice: "allow-once",
        nonce,
        hmac,
        // A hostile renderer sends whatever JSON it likes. `answeredBy` is not
        // a field of ApprovalDecision precisely because the host never reads
        // one — an integrity-verified response still does not get to say who
        // sent it.
        answeredBy: "remote",
      } as ApprovalDecision & { answeredBy: string });
      await expect(promise).resolves.toMatchObject({ choice: "allow-once" });

      const decided = auditRowTexts(auditLogger).find((row) =>
        row.includes("[approval:decided] answerer-spoof"),
      );
      expect(answererOf(decided as string)).toBe("desk");
    });

    it("closes the union: a non-member answerer is an anomaly, not the desk", () => {
      // @ts-expect-error — "remote" is not an ApprovalAnswerer, and the away
      // answerer joining the union did not make it one. That is the point of
      // this row: the union is closed against the value a relay design would
      // have needed, not merely small. The directive is the type-level half —
      // it suppresses an error today, and `check:typecheck-tests` reports it as
      // unused the moment an answerer named "remote" is added.
      const widened: ApprovalAnswerer = "remote";
      expect(approvalAnswererAuditToken(widened)).toBe("unrecognized-answerer");
      // The runtime half: the guarantee has to survive a caller that casts past
      // the type, and an inherited property is not an answerer.
      expect(approvalAnswererAuditToken("toString" as never)).toBe(
        "unrecognized-answerer",
      );
      // Every member renders as itself. A new member that forgot its token
      // would fail to compile in the audit table; one that mistyped it fails
      // here.
      expect(approvalAnswererAuditToken("desk")).toBe("desk");
      expect(approvalAnswererAuditToken("away-authority")).toBe(
        "away-authority",
      );
    });
  });

  // ── Remote-controller origin ──────────────────────────
  //
  // The marker answers "was a remote controller's turn blocked on this
  // approval?" It is a fact the host wrote down, not one a later reader
  // reconstructs from the reason text, and not one the renderer is asked for or
  // told. Every assertion below is about that: the value the host set, on the
  // rows that outlive the request, and nowhere the renderer can see.
  describe("remote-controller origin", () => {
    function originOf(row: string): string | undefined {
      return /(?:^| )remoteControllerOrigin=(\S+)/.exec(row)?.[1];
    }

    function rowsFor(
      auditLogger: { log: ReturnType<typeof vi.fn> },
      id: string,
    ): string[] {
      return auditRowTexts(auditLogger).filter((row) => row.includes(id));
    }

    it("names the controller on every row a remote turn produces", async () => {
      const { wc, auditLogger, gate } = makeAuditingGate();

      const promise = gate.requestAndWait(
        makeRequest({
          id: "origin-tailnet",
          remoteControllerOrigin: "tailnet-controller",
        }),
      );
      const { nonce, hmac } = lastSentNonceHmac(wc);
      gate.resolve("origin-tailnet", {
        requestId: "origin-tailnet",
        choice: "allow-once",
        nonce,
        hmac,
      });
      await expect(promise).resolves.toMatchObject({ choice: "allow-once" });

      const rows = rowsFor(auditLogger, "origin-tailnet");
      expect(rows.map((row) => row.split(" ")[0])).toEqual([
        "[approval:requested]",
        "[approval:decided]",
      ]);
      // The decided row is written from the pending entry after the request
      // object is gone, so this pins that the entry kept the marker too.
      expect(rows.map(originOf)).toEqual([
        "tailnet-controller",
        "tailnet-controller",
      ]);
    });

    it("distinguishes the controllers instead of marking every remote turn alike", async () => {
      const { wc, auditLogger, gate } = makeAuditingGate();

      const promise = gate.requestAndWait(
        makeRequest({
          id: "origin-bridge",
          remoteControllerOrigin: "platform-bridge",
        }),
      );
      const { nonce, hmac } = lastSentNonceHmac(wc);
      gate.resolve("origin-bridge", {
        requestId: "origin-bridge",
        choice: "deny-once",
        nonce,
        hmac,
      });
      await promise;

      expect(rowsFor(auditLogger, "origin-bridge").map(originOf)).toEqual([
        "platform-bridge",
        "platform-bridge",
      ]);
    });

    it("states positively that no controller is behind an ordinary approval", async () => {
      const { wc, auditLogger, gate } = makeAuditingGate();

      const promise = gate.requestAndWait(makeRequest({ id: "origin-desk" }));
      const { nonce, hmac } = lastSentNonceHmac(wc);
      gate.resolve("origin-desk", {
        requestId: "origin-desk",
        choice: "allow-once",
        nonce,
        hmac,
      });
      await promise;

      // Not an absent key: a reviewer partitioning rows by origin would have to
      // guess whether an absence meant "the desk asked" or "this row's writer
      // never carried the marker".
      expect(rowsFor(auditLogger, "origin-desk").map(originOf)).toEqual([
        "none",
        "none",
      ]);
    });

    it("still names the controller when the host resolved the request itself", async () => {
      vi.useFakeTimers();
      try {
        const { auditLogger, gate } = makeAuditingGate();

        const promise = gate.requestAndWait(
          makeRequest({
            id: "origin-timeout",
            remoteControllerOrigin: "tailnet-controller",
          }),
        );
        vi.advanceTimersByTime(1_001);
        await expect(promise).resolves.toMatchObject({ choice: "deny-once" });

        const timeout = rowsFor(auditLogger, "origin-timeout").find((row) =>
          row.startsWith("[approval:timeout]"),
        );
        expect(timeout).toBeDefined();
        // Unlike `answeredBy`, which is absent here because nobody answered,
        // the origin is still true of the request and is exactly what a review
        // of an unanswered remote turn is looking for.
        expect(originOf(timeout as string)).toBe("tailnet-controller");
      } finally {
        vi.useRealTimers();
      }
    });

    it("names the controller on a request the host refused before the renderer saw it", async () => {
      const { wc, auditLogger, gate } = makeAuditingGate();

      await expect(
        gate.requestAndWait(
          makeRequest({
            id: "origin-blocked",
            remoteControllerOrigin: "platform-bridge",
            target: { filePath: "/home/u/.ssh/id_rsa" },
          }),
        ),
      ).resolves.toMatchObject({ choice: "deny-once" });

      expect(wc.send).not.toHaveBeenCalled();
      const blocked = rowsFor(auditLogger, "origin-blocked").find((row) =>
        row.startsWith("[approval:sensitive-path-blocked]"),
      );
      // The hard-block resolves before a nonce is minted, so this row is the
      // only record that a bridged turn tried it at all.
      expect(originOf(blocked as string)).toBe("platform-bridge");
    });

    it("never sends the marker to the renderer", async () => {
      const { wc, gate } = makeAuditingGate();

      void gate.requestAndWait(
        makeRequest({
          id: "origin-not-sent",
          remoteControllerOrigin: "tailnet-controller",
          scopeTargetFilePaths: ["/srv/scope/report.md"],
        }),
      );

      const [, sent] = wc.send.mock.calls[0] as unknown as [
        string,
        ApprovalRequest,
      ];
      // Non-vacuous: this is the real payload, carrying the fields the renderer
      // is meant to have.
      expect(sent.id).toBe("origin-not-sent");
      expect(sent.nonce).toEqual(expect.any(String));
      // The renderer is neither asked for the marker nor told it. There is no
      // copy of it outside the main process to author or to alter.
      expect(sent).not.toHaveProperty("remoteControllerOrigin");
      // Same property, same reason. The scope list is host-only too: it is
      // what bounds an away answer, so a renderer that could see it is one
      // step from a renderer that could argue about it.
      expect(sent).not.toHaveProperty("scopeTargetFilePaths");
    });

    it("reports an unrecognised controller as an anomaly instead of echoing it", () => {
      // Audit rows are space-delimited `key=value`, so echoing a raw value
      // would let it append fields of its own choosing.
      expect(
        remoteControllerOriginAuditToken(
          "tailnet-controller choice=allow-always" as never,
        ),
      ).toBe("unrecognized-remote-origin");
      // An inherited member is not a controller.
      expect(remoteControllerOriginAuditToken("toString" as never)).toBe(
        "unrecognized-remote-origin",
      );
      expect(remoteControllerOriginAuditToken(undefined)).toBe("none");
      expect(remoteControllerOriginAuditToken("platform-bridge")).toBe(
        "platform-bridge",
      );
    });

    it("is deliberately outside the request signature", () => {
      const signed = {
        id: "origin-sig",
        nonce: "b1a2c3",
        toolName: "agent_spawn",
        sessionId: undefined,
        args: { title: "test" },
      };
      const key = Buffer.from("signing-key-for-preimage-comparison");

      const withMarker: ApprovalSignatureFields = {
        ...signed,
        // @ts-expect-error — the marker is not a signature field. This directive
        // is the type-level half: if it is ever added to the preimage's field
        // set, this suppresses nothing and `check:typecheck-tests` reports the
        // unused directive until the decision is revisited on purpose.
        remoteControllerOrigin: "tailnet-controller",
      };

      // The runtime half. The marker is host-only and never leaves the main
      // process, so it has no echoed copy for a signature to authenticate — a
      // digest over it would compare the host's own value to itself. Carrying
      // it must therefore change nothing about the digest.
      expect(signApprovalRequest(key, withMarker)).toBe(
        signApprovalRequest(key, signed),
      );
    });
  });

  // ── Away Authority ────────────────────────────────────
  //
  // The desk-armed second answerer, exercised through the gate. Two things are
  // being proved here and nothing else: that an away answer is reachable and
  // fully recorded, and that its position in `requestAndWait` leaves every hard
  // gate above it intact. Per-condition eligibility lives in
  // `away-authority.test.ts`, which drives the answerer directly.
  describe("away authority", () => {
    const AWAY_CONVERSATION = "conv-away";
    const AWAY_DIR = "/srv/away-gate-scope";
    const AWAY_FILE = "/srv/away-gate-scope/report.md";

    /** A request the armed grant below would answer, before any test flips it. */
    function makeAwayRequest(overrides?: Partial<RequestInput>): RequestInput {
      return makeRequest({
        id: "away-1",
        toolName: "fs_write",
        toolCategory: "write",
        sessionId: AWAY_CONVERSATION,
        source: "builtin",
        allowedChoices: ["allow-once", "deny-once"],
        durableApprovalRecordAllowed: false,
        forceExplicit: true,
        remoteControllerOrigin: "platform-bridge",
        remoteControllerAuthority: makePlatformBridgeAuthority(),
        target: { filePath: AWAY_FILE },
        // The host-only scope list. `target` is the display path; the
        // answerer reads this, so a fixture that set only `target` would
        // test a request the real producer never builds.
        scopeTargetFilePaths: [AWAY_FILE],
        isReadOnly: false,
        ...overrides,
      });
    }

    function armedGate(
      overrides: Partial<Parameters<ApprovalGate["armAwayAuthority"]>[0]> = {},
    ): ReturnType<typeof makeAuditingGate> {
      const harness = makeAuditingGate();
      const armed = harness.gate.armAwayAuthority({
        conversationId: AWAY_CONVERSATION,
        categories: ["read", "write"],
        directories: [AWAY_DIR],
        ttlMs: 60 * 60 * 1000,
        budget: 5,
        ...overrides,
      });
      expect(armed).toBe(true);
      return harness;
    }

    function rowFor(
      auditLogger: { log: ReturnType<typeof vi.fn> },
      marker: string,
    ): string | undefined {
      return auditRowTexts(auditLogger).find((row) => row.startsWith(marker));
    }

    it("answers an armed, in-scope paired-platform write without a modal", async () => {
      const { wc, auditLogger, gate } = armedGate();

      await expect(gate.requestAndWait(makeAwayRequest())).resolves.toEqual({
        requestId: "away-1",
        choice: "allow-once",
      });

      // Nobody was asked. No modal, and no OS toast to wake a room the owner
      // is not in — the answer is the whole point.
      expect(wc.send).not.toHaveBeenCalled();
      const answered = rowFor(auditLogger, "[approval:away-answered]");
      expect(answered).toContain("away-1");
      expect(answered).toContain("answeredBy=away-authority");
      expect(answered).toContain("remoteControllerOrigin=platform-bridge");
      expect(answered).toContain("toolName=fs_write");
      // Below the requested row, so an away-answered call still has the full
      // pair a reviewer replays.
      expect(rowFor(auditLogger, "[approval:requested]")).toContain("away-1");
    });

    it("leaves nothing an answer could be widened through", async () => {
      const { gate } = armedGate();

      await expect(gate.requestAndWait(makeAwayRequest())).resolves.toMatchObject(
        { choice: "allow-once" },
      );

      // It returns before a pending entry exists. There is no entry for
      // `resolve` to accept a later `allow-always` against, and none for
      // `getRequestSnapshot` to bind a user-approval record to.
      expect(gate.pendingCount).toBe(0);
      expect(gate.getRequestSnapshot("away-1")).toBeNull();
      expect(
        gate.resolve("away-1", {
          requestId: "away-1",
          choice: "allow-always",
          nonce: "x",
          hmac: "y",
        }),
      ).toBeNull();
    });

    it("spends the grant it answered from", async () => {
      const { auditLogger, gate } = armedGate({ budget: 1 });

      await expect(gate.requestAndWait(makeAwayRequest())).resolves.toMatchObject(
        { choice: "allow-once" },
      );
      // Spent in the same step that answered. The row says so, because from
      // the next call on there is no grant left to explain the silence.
      expect(rowFor(auditLogger, "[approval:away-answered]")).toContain(
        "remaining=0",
      );
      expect(rowFor(auditLogger, "[approval:away-retired]")).toContain(
        "reason=budget-spent",
      );
      expect(gate.awayAuthoritySnapshot()).toBeNull();

      // The second call finds no grant and falls through to a desk nobody is
      // at, exactly as it would have before anything was ever armed.
      const second = gate.requestAndWait(makeAwayRequest({ id: "away-2" }));
      expect(auditRowTexts(auditLogger).filter((row) =>
        row.startsWith("[approval:away-answered]"),
      )).toHaveLength(1);
      expect(gate.pendingCount).toBe(1);
      gate.disposeAll();
      await expect(second).resolves.toMatchObject({ choice: "deny-once" });
    });

    it("keeps answering while budget remains", async () => {
      const { auditLogger, gate } = armedGate({ budget: 2 });

      await expect(gate.requestAndWait(makeAwayRequest())).resolves.toMatchObject(
        { choice: "allow-once" },
      );
      expect(rowFor(auditLogger, "[approval:away-answered]")).toContain(
        "remaining=1",
      );
      // Non-vacuous companion to the test above: with budget left, the grant
      // survives and no retirement row is written.
      expect(gate.awayAuthoritySnapshot()?.remaining).toBe(1);
      expect(rowFor(auditLogger, "[approval:away-retired]")).toBeUndefined();
    });

    it("re-checks the controller authority at the moment it answers", async () => {
      const { wc, auditLogger, gate } = armedGate();

      // Same grant, same conversation, same scope — only the live guard has
      // gone stale, which is what a revoke mid-turn looks like.
      const promise = gate.requestAndWait(
        makeAwayRequest({ remoteControllerAuthority: makePlatformBridgeAuthority(false) }),
      );

      expect(rowFor(auditLogger, "[approval:away-declined]")).toContain(
        "reason=authority-not-current",
      );
      expect(rowFor(auditLogger, "[approval:away-answered]")).toBeUndefined();
      // It fell through to the desk rather than being denied outright: the
      // answerer declining is not a decision about the request.
      expect(wc.send).toHaveBeenCalledTimes(1);
      gate.disposeAll();
      await expect(promise).resolves.toMatchObject({ choice: "deny-once" });
    });

    it("retires the grant when the share lifecycle changes", async () => {
      const { auditLogger, gate } = armedGate();

      expect(gate.retireAwayAuthority("share-lifecycle")).toBe(true);
      expect(gate.awayAuthoritySnapshot()).toBeNull();
      expect(rowFor(auditLogger, "[approval:away-retired]")).toContain(
        "reason=share-lifecycle",
      );

      const promise = gate.requestAndWait(makeAwayRequest());
      expect(rowFor(auditLogger, "[approval:away-answered]")).toBeUndefined();
      // A retired grant is not this answerer's business any more, so it is also
      // not worth a declined row on every later approval.
      expect(rowFor(auditLogger, "[approval:away-declined]")).toBeUndefined();
      gate.disposeAll();
      await expect(promise).resolves.toMatchObject({ choice: "deny-once" });
    });

    it("stays quiet about approvals that were never its business", async () => {
      const { auditLogger, gate } = armedGate();

      // An ordinary desk approval while armed. If this wrote a declined row,
      // every approval in the app would write one.
      const promise = gate.requestAndWait(
        makeRequest({ id: "desk-while-armed", sessionId: AWAY_CONVERSATION }),
      );
      expect(rowFor(auditLogger, "[approval:away-declined]")).toBeUndefined();
      expect(rowFor(auditLogger, "[approval:away-answered]")).toBeUndefined();
      gate.disposeAll();
      await expect(promise).resolves.toMatchObject({ choice: "deny-once" });
    });

    it("refuses to arm a gesture outside the grant bounds", () => {
      const { auditLogger, gate } = makeAuditingGate();

      expect(
        gate.armAwayAuthority({
          conversationId: AWAY_CONVERSATION,
          // Arming shell would make an away answer arbitrary code execution.
          categories: ["shell"],
          directories: [AWAY_DIR],
          ttlMs: 60 * 60 * 1000,
          budget: 5,
        }),
      ).toBe(false);
      expect(gate.awayAuthoritySnapshot()).toBeNull();
      expect(rowFor(auditLogger, "[approval:away-armed]")).toBeUndefined();
    });

    it("keeps local paths out of the armed row", () => {
      const { auditLogger } = armedGate();

      const armedRow = rowFor(auditLogger, "[approval:away-armed]") as string;
      expect(armedRow).toContain("categories=read,write");
      expect(armedRow).toContain("directories=1");
      expect(armedRow).toContain("budget=5");
      // The count, not the paths. Keeping local paths off a remote transport is
      // the reason this feature is a desk gesture rather than a relay; an audit
      // row is not an exception to it.
      expect(armedRow).not.toContain("away-gate-scope");
    });

    it("never sends the authority object to the renderer", async () => {
      const { wc, gate } = armedGate();

      // Declined (wrong conversation) so the request actually reaches the send.
      const promise = gate.requestAndWait(
        makeAwayRequest({ id: "away-not-sent", sessionId: "conv-other" }),
      );

      const [, sent] = wc.send.mock.calls[0] as unknown as [
        string,
        ApprovalRequest,
      ];
      expect(sent.id).toBe("away-not-sent");
      expect(sent.nonce).toEqual(expect.any(String));
      expect(sent).not.toHaveProperty("remoteControllerAuthority");
      expect(sent).not.toHaveProperty("remoteControllerOrigin");
      gate.disposeAll();
      await expect(promise).resolves.toMatchObject({ choice: "deny-once" });
    });

    // ── Hard gates above the injection point ────────────
    //
    // Each row below is an otherwise-eligible away request that one hard gate
    // rejects first. They are the reason the answerer sits where it does: move
    // its block above any of these and the matching row fails.
    it("cannot re-open the sensitive-path hard block", async () => {
      const { wc, auditLogger, gate } = armedGate();

      await expect(
        gate.requestAndWait(
          makeAwayRequest({ target: { filePath: `${AWAY_DIR}/.ssh/id_rsa` } }),
        ),
      ).resolves.toMatchObject({ choice: "deny-once" });

      expect(rowFor(auditLogger, "[approval:sensitive-path-blocked]")).toContain(
        "away-1",
      );
      expect(rowFor(auditLogger, "[approval:away-answered]")).toBeUndefined();
      // Not even a declined row: the request never reached the answerer.
      expect(rowFor(auditLogger, "[approval:away-declined]")).toBeUndefined();
      expect(wc.send).not.toHaveBeenCalled();
    });

    it("cannot re-open a host-shell binding mismatch", async () => {
      const { auditLogger, gate } = armedGate();
      const plan = buildHostShellExecutionPlan({
        platform: "linux",
        requestedSandbox: false,
        activeCapability: {
          kind: "none",
          confidence: "verified",
          platform: "linux",
          reason: "test-only",
        },
      });

      await expect(
        gate.requestAndWait(
          makeAwayRequest({
            // A binding that does not describe the displayed request — the
            // request is an `fs_write`, the binding a shell spawn. The gate
            // rejects it before the answerer is consulted.
            hostShellExecutionPermitBinding: Object.freeze({
              plan,
              planIdentity: plan.identity,
              toolName: "bash",
              toolUseId: "away-binding",
              command: "echo away",
              requestedCwd: undefined,
              executionCwd: "/repo",
              resolvedCwd: "/repo",
              timeoutSeconds: 30,
              allowedDirectories: Object.freeze([AWAY_DIR]),
            }) satisfies HostShellExecutionPermitBinding,
          }),
        ),
      ).resolves.toMatchObject({ choice: "deny-once" });

      expect(
        rowFor(auditLogger, "[approval:host-shell-binding-mismatch]"),
      ).toContain("away-1");
      expect(rowFor(auditLogger, "[approval:away-answered]")).toBeUndefined();
    });

    it("cannot re-open an unissued execution plan", async () => {
      const { auditLogger, gate } = armedGate();

      await expect(
        gate.requestAndWait(
          makeAwayRequest({
            executionPlan: { version: 1 } as never,
          }),
        ),
      ).resolves.toMatchObject({ choice: "deny-once" });

      expect(rowFor(auditLogger, "[approval:execution-plan-invalid]")).toContain(
        "away-1",
      );
      expect(rowFor(auditLogger, "[approval:away-answered]")).toBeUndefined();
    });

    it("cannot answer for a destroyed window", async () => {
      const wc = makeMockWebContents({ isDestroyed: true });
      const auditLogger = { log: vi.fn() };
      const gate = new ApprovalGate(wc as never, undefined, 1_000, auditLogger as never);
      expect(
        gate.armAwayAuthority({
          conversationId: AWAY_CONVERSATION,
          categories: ["read", "write"],
          directories: [AWAY_DIR],
          ttlMs: 60 * 60 * 1000,
          budget: 5,
        }),
      ).toBe(true);

      await expect(gate.requestAndWait(makeAwayRequest())).resolves.toMatchObject(
        { choice: "deny-once" },
      );

      expect(rowFor(auditLogger, "[approval:send-failed]")).toContain("away-1");
      expect(rowFor(auditLogger, "[approval:away-answered]")).toBeUndefined();
    });

    it("does not reach the read-only fail-open", async () => {
      const { auditLogger, gate } = armedGate();

      // A read-only request short-circuits above the answerer. The point is
      // that the away answerer is not the thing that approved it: the row names
      // no answerer at all, because the host reached that outcome on its own.
      await expect(
        gate.requestAndWait(
          makeAwayRequest({ toolCategory: "read", isReadOnly: true }),
        ),
      ).resolves.toMatchObject({ choice: "allow-once" });

      const autoApproved = rowFor(auditLogger, "[approval:read-only-auto-approve]");
      expect(autoApproved).toContain("away-1");
      expect(autoApproved).not.toContain("answeredBy=");
      expect(rowFor(auditLogger, "[approval:away-answered]")).toBeUndefined();
    });
  });

  describe("turn abort", () => {
    /**
     * A tool ask with nothing to short-circuit it on the way in: not
     * read-only, no away grant armed, no sensitive target. It reaches the
     * renderer and then waits, which is the only state a stop can be observed
     * from.
     */
    function makeAbortableRequest(signal?: AbortSignal): RequestInput {
      return makeRequest({
        id: "abort-1",
        toolName: "fs_write",
        toolCategory: "write",
        sessionId: "conv-stopped",
        isReadOnly: false,
        ...(signal === undefined ? {} : { abortSignal: signal }),
      });
    }

    it("unparks a request nobody answered when the turn is stopped", async () => {
      const { wc, auditLogger, gate } = makeAuditingGate();
      const turn = new AbortController();

      const parked = gate.requestAndWait(makeAbortableRequest(turn.signal));
      // The modal really was raised. Without this the rest of the test would
      // also pass against a gate that refused the request on its way in.
      expect(wc.send).toHaveBeenCalledTimes(1);
      expect(gate.pendingCount).toBe(1);

      turn.abort(new Error("user cancelled turn"));
      const decision = await parked;

      expect(decision.choice).toBe("deny-once");
      // Host-generated, not a deny the owner authored, and not the timeout —
      // the gate's five minutes never elapsed here.
      expect(isHostApprovalRejectedDecision(decision)).toBe(true);
      expect(isHostApprovalTimeoutDecision(decision)).toBe(false);
      expect(decision.rememberPattern).toBeUndefined();
      // The entry is gone, so a desk answer that crossed the abort in flight
      // arrives as an unknown-request replay rather than an answer to a turn
      // that no longer exists.
      expect(gate.pendingCount).toBe(0);

      const cancelled = auditRowTexts(auditLogger).find((row) =>
        row.startsWith("[approval:cancelled]"),
      );
      expect(cancelled).toContain("abort-1");
      expect(cancelled).toContain("reason=turn-abort");
    });

    it("does not raise a modal for a turn that is already over", async () => {
      const { wc, auditLogger, gate } = makeAuditingGate();
      const turn = new AbortController();
      turn.abort(new Error("user cancelled turn"));

      const decision = await gate.requestAndWait(makeAbortableRequest(turn.signal));

      expect(decision.choice).toBe("deny-once");
      expect(wc.send).not.toHaveBeenCalled();
      expect(gate.pendingCount).toBe(0);
      const rows = auditRowTexts(auditLogger);
      // The cancelled row keeps its requested row. An approval that leaves no
      // trace at all reads exactly like one that was never asked for.
      expect(rows.some((row) => row.startsWith("[approval:requested]"))).toBe(true);
      expect(rows.some((row) => row.startsWith("[approval:cancelled]"))).toBe(true);
    });

    it("leaves a request that carries no signal parked", async () => {
      const { gate } = makeAuditingGate();
      const unrelated = new AbortController();

      const parked = gate.requestAndWait(makeAbortableRequest());
      let settled = false;
      void parked.then(() => {
        settled = true;
      });

      unrelated.abort(new Error("user cancelled turn"));
      await Promise.resolve();

      // The signal is the mechanism, not some ambient "any abort ends every
      // wait" behaviour a passing test above could otherwise be crediting.
      expect(settled).toBe(false);
      expect(gate.pendingCount).toBe(1);

      gate.disposeAll();
      await expect(parked).resolves.toMatchObject({ choice: "deny-once" });
    });

    it("detaches from the signal once the desk answers", async () => {
      const { wc, auditLogger, gate } = makeAuditingGate();
      const turn = new AbortController();
      const removeListener = vi.spyOn(turn.signal, "removeEventListener");

      const parked = gate.requestAndWait(makeAbortableRequest(turn.signal));
      const { nonce, hmac } = lastSentNonceHmac(wc);
      gate.resolve("abort-1", {
        requestId: "abort-1",
        choice: "allow-once",
        nonce,
        hmac,
      });
      await expect(parked).resolves.toMatchObject({ choice: "allow-once" });

      expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));

      // A later stop of the same turn has nothing left to cancel here. One
      // turn can ask many times, and an answered request that stayed attached
      // would keep piling listeners onto the one signal it shares with them.
      turn.abort(new Error("user cancelled turn"));
      expect(
        auditRowTexts(auditLogger).some((row) =>
          row.startsWith("[approval:cancelled]"),
        ),
      ).toBe(false);
    });
  });
});
