import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ApprovalGate } from "../../../permissions/approval-gate.js";
import { buildPermissionEvaluationContext } from "../../../permissions/evaluation-context.js";
import type { PermissionCheckResult } from "../../../permissions/permission-manager.js";
import type {
  RationaleScopeReviewer,
} from "../../../permissions/reviewer/rationale-scope-reviewer.js";
import type { RationaleAuditSink } from "../../../audit/rationale-audit-adapter.js";
import {
  createRequestAnchor,
  createTriggeringBatchDisposition,
  RATIONALE_CONTROL_CONTRACT_VERSION,
  type RequestAnchor,
} from "../rationale-control.js";
import { RationaleHostCoordinator } from "../rationale-host-coordinator.js";
import {
  RationaleHostService,
} from "../rationale-host-service.js";
import type { RationaleControlCandidate } from "../rationale-orchestrator.js";
import { createReviewerScopeReevaluation } from "../rationale-pr1-contract.js";
import type {
  HostInvocationStartCas,
  InvocationAuditRecord,
} from "../rationale-ticket-lifecycle.js";

const NOW = 1_900_000_000_000;
const SESSION_ID = "session-service";
const rationaleProvenance = {
  startedFromUserKeyboard: true,
  taint: "none",
} as const;
const permission = {
  decision: "ask",
  reason: "reviewer medium",
  layer: 5,
  reviewer: {
    route: "foreground-auto",
    verdict: { level: "medium", reason: "bounded destructive action" },
    outcome: "fresh",
  },
} as const satisfies PermissionCheckResult;

function createAnchor(): RequestAnchor {
  const anchor = createRequestAnchor({
    sessionId: SESSION_ID,
    turnId: "turn-service",
    inputMessageId: "message-service",
    inputOrigin: "user-keyboard",
    rawIntent: "remove the private build output",
    now: NOW,
    ttlMs: 60_000,
  });
  if (!anchor) throw new Error("expected request anchor");
  return anchor;
}

function createCandidate(anchor: RequestAnchor): RationaleControlCandidate {
  const originalInput = { command: "rm -rf workspace/private-build" };
  const finalInput = { command: "rm -rf workspace/private-build", confirmed: true };
  return {
    now: NOW,
    requestAnchor: anchor,
    rationaleProvenance,
    triggeringBatchDisposition: createTriggeringBatchDisposition({
      batchId: "provider-batch-service",
      originalToolUseIds: ["tool-use-service"],
      triggeringToolUseId: "tool-use-service",
      completedToolUseIds: [],
    }),
    toolUseId: "tool-use-service",
    originalInput,
    finalInput,
    toolName: "shell_exec",
    toolVersion: "1",
    source: "builtin",
    category: "shell",
    invocationTrustOrigin: "llm-tool-arg",
    targetFilePaths: ["workspace/private-build"],
    canonicalTargets: ["workspace/private-build"],
    allowedDirectories: ["workspace"],
    approvalCacheKey: "shell_exec:workspace/private-build",
    sandboxCapability: {
      kind: "asrt",
      confidence: "verified",
      platform: "linux",
      reason: "test sandbox",
      confines: { filesystem: true, process: true, network: true },
    },
    sandboxExecutionPlan: {
      cwd: "workspace",
      filesystem: "workspace-only",
      network: "strict-union",
    },
    permission,
    permissionEvaluationContext: buildPermissionEvaluationContext({
      policyMode: "default",
      headless: false,
      source: "builtin",
      category: "shell",
      trustOrigin: "llm-tool-arg",
      executionCwd: "workspace",
      allowedDirectories: ["workspace"],
      pathFields: ["command"],
      targetFilePaths: ["workspace/private-build"],
      sensitivePathsAdjacent: [],
    }),
    eligibilityContext: {
      headless: false,
      forceModal: false,
      approvalReasonPrefix: null,
    },
  };
}

function authorizedRecord(): InvocationAuditRecord {
  return {
    contractVersion: RATIONALE_CONTROL_CONTRACT_VERSION,
    ticketId: randomUUID(),
    actionDigest: "a".repeat(64),
    invocationDigest: "b".repeat(64),
    toolUseId: "tool-use-service",
    authorizationReceiptId: randomUUID(),
    invocationStartLeaseId: null,
    version: 0,
    state: "authorized",
    automaticRetry: "forbidden",
  };
}

function setup() {
  const appendTicket = vi.fn((event) => event as never);
  const appendProjection = vi.fn((_sessionId, projection, _at) => projection as never);
  const auditSink = {
    assertWritable: vi.fn(),
    appendTicket,
    appendInvocation: vi.fn((_sessionId, record) => record as never),
    appendProjection,
  } satisfies RationaleAuditSink;
  const reviewer = {
    reevaluate: vi.fn(async (input) =>
      createReviewerScopeReevaluation({
        control: input.control,
        outcome: "fresh",
        scopeAlignment: "aligned",
        scopeReasons: ["sealed target remains in scope"],
        reevaluatedVerdict: {
          level: "medium",
          reason: "bounded destructive action remains medium",
        },
        now: input.now,
      })),
  } satisfies RationaleScopeReviewer;
  const getRationaleScopeReviewer = vi.fn(() => reviewer);
  const requestAndWait = vi.fn(async (
    request: Parameters<ApprovalGate["requestAndWait"]>[0],
  ) => ({
    requestId: request.id,
    choice: "deny-once" as const,
  }));
  const cancelPendingRationale = vi.fn(() => false);
  const approvalGate = {
    requestAndWait,
    cancelPendingRationale,
  };
  const commitStart = vi.fn(async (
    _input: Parameters<HostInvocationStartCas["commitStart"]>[0],
  ) => null);
  const invocationStartCas = {
    commitStart,
    commitTerminal: vi.fn(async (
      _input: Parameters<HostInvocationStartCas["commitTerminal"]>[0],
    ) => true),
  } satisfies HostInvocationStartCas;
  const service = new RationaleHostService({
    approvalGate,
    getRationaleScopeReviewer,
    getRegistryGeneration: () => "registry-1",
    getSandboxGeneration: () => "sandbox-1",
    invocationStartCas,
    auditSink,
    now: () => NOW,
  });
  const factory = service.createCoordinatorFactory({
    getRationalePolicyEpoch: () => "policy-1",
    isSessionCurrent: (sessionId) => sessionId === SESSION_ID,
  });
  const anchor = createAnchor();
  const createCoordinator = async (): Promise<RationaleHostCoordinator> => {
    const runtime = await factory({
      requestAnchor: anchor,
      rationaleProvenance,
      sessionId: SESSION_ID,
    });
    expect(runtime).toBeInstanceOf(RationaleHostCoordinator);
    return runtime as RationaleHostCoordinator;
  };
  return {
    service,
    factory,
    anchor,
    createCoordinator,
    auditSink,
    appendTicket,
    appendProjection,
    getRationaleScopeReviewer,
    reviewer,
    requestAndWait,
    cancelPendingRationale,
    commitStart,
  };
}

describe("RationaleHostService", () => {
  it("keeps factory injection dormant and fails closed on audit preflight", async () => {
    const state = setup();

    expect(state.auditSink.assertWritable).not.toHaveBeenCalled();
    expect(state.getRationaleScopeReviewer).not.toHaveBeenCalled();
    state.auditSink.assertWritable.mockImplementationOnce(() => {
      throw new Error("audit unavailable");
    });

    expect(await state.factory({
      requestAnchor: state.anchor,
      rationaleProvenance,
      sessionId: SESSION_ID,
    })).toBeNull();
    expect(state.getRationaleScopeReviewer).not.toHaveBeenCalled();
    expect(state.commitStart).not.toHaveBeenCalled();
  });

  it("overwrites caller session identity and rejects starts after close", async () => {
    const state = setup();
    const coordinator = await state.createCoordinator();
    const startInput = {
      sessionId: "spoofed-session",
      control: {} as never,
      authorized: authorizedRecord(),
      expectedInvocationVersion: 0 as const,
      persistAudit: vi.fn(),
      now: NOW,
    };

    expect(await coordinator.hostInvocationStartCas.commitStart(startInput)).toBeNull();
    expect(state.commitStart).toHaveBeenCalledWith({
      ...startInput,
      sessionId: SESSION_ID,
    });

    state.service.closeSession(SESSION_ID, NOW + 1);
    expect(await coordinator.hostInvocationStartCas.commitStart(startInput)).toBeNull();
    expect(state.commitStart).toHaveBeenCalledTimes(1);
  });

  it("does not open a delayed modal after session close", async () => {
    const state = setup();
    const coordinator = await state.createCoordinator();
    const materialized = coordinator.materializeRationaleControl(
      createCandidate(state.anchor),
    );
    expect(materialized).not.toBeNull();
    if (!materialized) throw new Error("expected materialized rationale control");

    const resolved = await coordinator.handleRationaleRoundResult({
      ticketId: materialized.control.ticketId,
      result: {
        kind: "generation-failure",
        generationOutcome: "generation-error",
      },
      now: NOW,
    });
    expect(resolved?.ticket.ticket.state).toBe("user_pending");
    expect(state.appendProjection).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({
        projection: "rationale-ui-audit",
        terminalReason: null,
      }),
      NOW,
    );

    state.service.closeSession(SESSION_ID, NOW + 1);
    expect(await coordinator.promptForApproval(
      materialized.control.ticketId,
      { now: NOW + 1 },
    )).toBeNull();
    expect(state.requestAndWait).not.toHaveBeenCalled();
  });

  it("retries gate cancellation after the ticket store already closed", async () => {
    const state = setup();
    const coordinator = await state.createCoordinator();
    const materialized = coordinator.materializeRationaleControl(
      createCandidate(state.anchor),
    );
    if (!materialized) throw new Error("expected materialized rationale control");
    await coordinator.handleRationaleRoundResult({
      ticketId: materialized.control.ticketId,
      result: {
        kind: "generation-failure",
        generationOutcome: "generation-error",
      },
      now: NOW,
    });

    let settleApproval: ((value: null) => void) | undefined;
    state.requestAndWait.mockImplementationOnce(() => new Promise((resolve) => {
      settleApproval = resolve as (value: null) => void;
    }));
    state.cancelPendingRationale
      .mockImplementationOnce(() => {
        throw new Error("gate cancellation unavailable");
      })
      .mockImplementationOnce(() => {
        settleApproval?.(null);
        return true;
      });
    const pendingPrompt = coordinator.promptForApproval(
      materialized.control.ticketId,
      { now: NOW + 1 },
    );
    expect(state.requestAndWait).toHaveBeenCalledOnce();

    expect(() => state.service.closeSession(SESSION_ID, NOW + 2)).toThrow(
      AggregateError,
    );
    expect(state.cancelPendingRationale).toHaveBeenCalledTimes(1);

    expect(() => state.service.closeSession(SESSION_ID, NOW + 3)).not.toThrow();
    expect(state.cancelPendingRationale).toHaveBeenCalledTimes(2);
    await expect(pendingPrompt).resolves.toBeNull();
  });

  it("quarantines coordinator contexts before a close audit failure", async () => {
    const state = setup();
    const coordinator = await state.createCoordinator();
    const materialized = coordinator.materializeRationaleControl(
      createCandidate(state.anchor),
    );
    if (!materialized) throw new Error("expected materialized rationale control");
    await coordinator.handleRationaleRoundResult({
      ticketId: materialized.control.ticketId,
      result: {
        kind: "generation-failure",
        generationOutcome: "generation-error",
      },
      now: NOW,
    });
    state.appendTicket.mockImplementation(() => {
      throw new Error("audit append failed");
    });

    expect(() => coordinator.closeSession(SESSION_ID, NOW + 1)).toThrow(
      AggregateError,
    );
    expect(await coordinator.promptForApproval(
      materialized.control.ticketId,
      { now: NOW + 1 },
    )).toBeNull();
    expect(state.requestAndWait).not.toHaveBeenCalled();
  });

  it("keeps stale start authority closed when shutdown audit teardown fails", async () => {
    const state = setup();
    const coordinator = await state.createCoordinator();
    const materialized = coordinator.materializeRationaleControl(
      createCandidate(state.anchor),
    );
    expect(materialized).not.toBeNull();
    state.appendTicket.mockImplementation(() => {
      throw new Error("audit append failed");
    });

    expect(() => state.service.shutdown(NOW + 1)).toThrow(AggregateError);
    expect(await coordinator.hostInvocationStartCas.commitStart({
      sessionId: SESSION_ID,
      control: {} as never,
      authorized: authorizedRecord(),
      expectedInvocationVersion: 0,
      persistAudit: vi.fn(),
      now: NOW + 1,
    })).toBeNull();
    expect(state.commitStart).not.toHaveBeenCalled();
    expect(await state.factory({
      requestAnchor: state.anchor,
      rationaleProvenance,
      sessionId: SESSION_ID,
    })).toBeNull();
  });
});
