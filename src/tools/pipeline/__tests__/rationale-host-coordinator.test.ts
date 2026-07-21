import { describe, expect, it, vi } from "vitest";
import { ApprovalGate } from "../../../permissions/approval-gate.js";
import type {
  ApprovalChoice,
  ApprovalDecision,
  ApprovalRequest,
} from "../../../permissions/approval-gate.js";
import { buildPermissionEvaluationContext } from "../../../permissions/evaluation-context.js";
import type { PermissionCheckResult } from "../../../permissions/permission-manager.js";
import { TOOL_TIMEOUT_POLICY } from "../../../shared/tool-timeout-policy.js";
import type {
  RationaleScopeReviewer,
} from "../../../permissions/reviewer/rationale-scope-reviewer.js";
import {
  InMemoryHostAnchorRoundCasStore,
  createRequestAnchor,
  createTriggeringBatchDisposition,
  type ActionIdentity,
  type RationaleRequiredControl,
  type RequestAnchor,
} from "../rationale-control.js";
import {
  RationaleHostCoordinator,
  deriveConservativeRationaleActionSummary,
} from "../rationale-host-coordinator.js";
import type { RationaleControlCandidate } from "../rationale-orchestrator.js";
import { createReviewerScopeReevaluation } from "../rationale-pr1-contract.js";
import {
  InMemoryHostInvocationStartCasStore,
  type InvocationAuditRecord,
} from "../rationale-ticket-lifecycle.js";
import type { RationaleUiAuditProjection } from "../rationale-resume-contract.js";
import {
  InProcessRationaleTicketStore,
  type RationaleTicketStoreAuditEvent,
} from "../rationale-ticket-store.js";

const NOW = 1_900_000_000_000;
const rationaleProvenance = {
  startedFromUserKeyboard: true,
  taint: "none",
} as const;
const eligibilityContext = {
  headless: false,
  forceModal: false,
  approvalReasonPrefix: null,
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

interface SetupOptions {
  readonly platform?: NodeJS.Platform;
  readonly approvalChoice?: ApprovalChoice;
  readonly reviewer?: RationaleScopeReviewer;
  readonly deferApproval?: boolean;
  readonly approvalGate?: Pick<
    ApprovalGate,
    "requestAndWait" | "cancelPendingRationale"
  >;
  readonly onTicketAudit?: (event: RationaleTicketStoreAuditEvent) => void;
  readonly onProjectionAudit?: (
    sessionId: string,
    projection: RationaleUiAuditProjection,
    at: number,
  ) => unknown;
}

function createAnchor(
  sessionId = "session-coordinator",
  suffix = "1",
): RequestAnchor {
  const anchor = createRequestAnchor({
    sessionId,
    turnId: "turn-" + suffix,
    inputMessageId: "message-" + suffix,
    inputOrigin: "user-keyboard",
    rawIntent: "remove the private build output",
    now: NOW,
    ttlMs: 60_000,
  });
  if (!anchor) throw new Error("expected request anchor");
  return anchor;
}

function createCandidate(
  anchor: RequestAnchor,
  platform: NodeJS.Platform,
): RationaleControlCandidate {
  const originalInput = { command: "rm -rf workspace/private-build" };
  const finalInput = { command: "rm -rf workspace/private-build", confirmed: true };
  return {
    now: NOW,
    requestAnchor: anchor,
    rationaleProvenance,
    triggeringBatchDisposition: createTriggeringBatchDisposition({
      batchId: "provider-batch-1",
      originalToolUseIds: ["tool-use-1", "tool-use-cancelled"],
      triggeringToolUseId: "tool-use-1",
      completedToolUseIds: [],
    }),
    toolUseId: "tool-use-1",
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
      platform,
      reason: "test sandbox",
      confines: { filesystem: true, process: platform !== "win32", network: true },
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
    eligibilityContext,
  };
}

function responseFor(control: RationaleRequiredControl) {
  return {
    contractVersion: 1,
    anchorId: control.anchor.anchorId,
    ticketId: control.ticketId,
    actionDigest: control.action.actionDigest,
    round: 1,
    suggestion: "Remove the sealed build target.",
  } as const;
}

function setup(options: SetupOptions = {}) {
  const anchor = createAnchor();
  const candidate = createCandidate(anchor, options.platform ?? "linux");
  const ticketStore = new InProcessRationaleTicketStore({
    onAudit: options.onTicketAudit ?? (() => {}),
  });
  const anchorRoundCas = new InMemoryHostAnchorRoundCasStore();
  const hostInvocationStartCas = new InMemoryHostInvocationStartCasStore();
  const invocationAudits: InvocationAuditRecord[] = [];
  const projectionAudits: Array<{
    readonly sessionId: string;
    readonly projection: RationaleUiAuditProjection;
    readonly at: number;
  }> = [];
  const approvalRequests: Array<Omit<ApprovalRequest, "requireExplicit">> = [];
  const reviewer = options.reviewer ?? {
    async reevaluate(input) {
      return createReviewerScopeReevaluation({
        control: input.control,
        outcome: "fresh",
        scopeAlignment: "aligned",
        scopeReasons: ["the sealed target matches the direct request"],
        reevaluatedVerdict: {
          level: "medium",
          reason: "bounded destructive action remains medium",
        },
        now: input.now,
      });
    },
  } satisfies RationaleScopeReviewer;
  const generations = {
    policy: "policy-epoch-1",
    registry: "registry-generation-1",
    sandbox: "sandbox-generation-1",
  };
  const pendingApprovals = new Map<
    string,
    (decision: ApprovalDecision) => void
  >();
  const resolvePendingApproval = (
    requestId: string,
    choice: ApprovalChoice,
  ): boolean => {
    const resolve = pendingApprovals.get(requestId);
    if (!resolve) return false;
    pendingApprovals.delete(requestId);
    resolve({ requestId, choice });
    return true;
  };
  const fallbackApprovalGate = {
    requestAndWait: vi.fn(async (
      request: Omit<ApprovalRequest, "requireExplicit">,
    ) => {
      approvalRequests.push(request);
      if (options.deferApproval) {
        return await new Promise<ApprovalDecision>((resolve) => {
          pendingApprovals.set(request.id, resolve);
        });
      }
      return {
        requestId: request.id,
        choice: options.approvalChoice ?? "allow-once",
      };
    }),
    cancelPendingRationale: vi.fn((requestId: string) =>
      resolvePendingApproval(requestId, "deny-once")
    ),
  };
  const approvalGate = options.approvalGate ?? fallbackApprovalGate;
  const coordinator = new RationaleHostCoordinator({
    requestAnchor: anchor,
    rationaleProvenance,
    ticketStore,
    rationaleScopeReviewer: reviewer,
    approvalGate,
    getRationalePolicyEpoch: () => generations.policy,
    getRegistryGeneration: () => generations.registry,
    getSandboxGeneration: () => generations.sandbox,
    anchorRoundCas,
    hostInvocationStartCas,
    onInvocationAudit: (record) => invocationAudits.push(record),
    onProjectionAudit: (sessionId, projection, at) => {
      const result = options.onProjectionAudit?.(sessionId, projection, at);
      projectionAudits.push({ sessionId, projection, at });
      return result;
    },
    now: () => NOW,
  });
  return {
    coordinator,
    candidate,
    ticketStore,
    anchorRoundCas,
    hostInvocationStartCas,
    invocationAudits,
    projectionAudits,
    approvalGate,
    approvalRequests,
    pendingApprovals,
    resolvePendingApproval,
    reviewer,
    generations,
  };
}

function materialize(setupValue: ReturnType<typeof setup>) {
  const value = setupValue.coordinator.materializeRationaleControl(
    setupValue.candidate,
  );
  expect(value).not.toBeNull();
  if (!value) throw new Error("expected materialization");
  return value;
}

describe("RationaleHostCoordinator", () => {
  it.each(["linux", "darwin", "win32"] as const)(
    "materializes one conservative host round on %s",
    (platform) => {
      const state = setup({ platform });
      const materialized = materialize(state);

      expect(materialized.action).toMatchObject({
        requestedEffects: ["execute-command", "mutate-host-state"],
        affectedResources: ["workspace/private-build"],
        requiredAuthority: "shell-execution",
        policyEpoch: "policy-epoch-1",
        registryGeneration: "registry-generation-1",
        sandboxGeneration: "sandbox-generation-1",
      });
      expect(materialized.ticket.state).toBe("review_required");
      expect(state.ticketStore.get({
        sessionId: materialized.control.anchor.sessionId,
        ticketId: materialized.control.ticketId,
        now: NOW,
      })?.ticket.state).toBe("rationale_requested");
      expect(state.coordinator.materializeRationaleControl(state.candidate)).toBeNull();
    },
  );

  it("shares the anchor CAS and ticket store across coordinator instances", () => {
    const state = setup();
    const first = materialize(state);
    const second = new RationaleHostCoordinator({
      requestAnchor: state.candidate.requestAnchor,
      rationaleProvenance,
      ticketStore: state.ticketStore,
      rationaleScopeReviewer: state.reviewer,
      approvalGate: state.approvalGate,
      getRationalePolicyEpoch: () => state.generations.policy,
      getRegistryGeneration: () => state.generations.registry,
      getSandboxGeneration: () => state.generations.sandbox,
      anchorRoundCas: state.anchorRoundCas,
      hostInvocationStartCas: state.hostInvocationStartCas,
      onInvocationAudit: (record) => state.invocationAudits.push(record),
      onProjectionAudit: (sessionId, projection, at) => {
        state.projectionAudits.push({ sessionId, projection, at });
      },
      now: () => NOW,
    });

    expect(second.materializeRationaleControl(state.candidate)).toBeNull();
    expect(state.ticketStore.get({
      sessionId: first.control.anchor.sessionId,
      ticketId: first.control.ticketId,
      now: NOW,
    })?.ticket.state).toBe("rationale_requested");
  });

  it("uses the same meta authority rule for agent_spawn and every other meta tool", () => {
    const spawn = deriveConservativeRationaleActionSummary({
      category: "meta",
      source: "builtin",
      toolName: "agent_spawn",
      canonicalTargets: [],
    });
    const other = deriveConservativeRationaleActionSummary({
      category: "meta",
      source: "builtin",
      toolName: "host_setting_update",
      canonicalTargets: [],
    });

    expect(spawn.requestedEffects).toEqual(["change-host-or-agent-state"]);
    expect(spawn.requiredAuthority).toBe("host-orchestration");
    expect(other.requestedEffects).toEqual(spawn.requestedEffects);
    expect(other.requiredAuthority).toBe(spawn.requiredAuthority);
  });

  it("requires fresh cache-bypassed reevaluation, one-shot modal, and authentic resume", async () => {
    const state = setup();
    const materialized = materialize(state);
    const round = await state.coordinator.handleRationaleRoundResult({
      ticketId: materialized.control.ticketId,
      result: {
        kind: "calls",
        calls: [{
          id: "rationale-call-1",
          name: "permission_rationale",
          input: responseFor(materialized.control),
        }],
      },
      now: NOW + 1,
    });

    expect(round).toMatchObject({
      status: "ready",
      generationOutcome: "accepted-rationale",
      ticket: { ticket: { state: "user_pending", rationaleStatus: "ready" } },
      projection: {
        rationaleStatus: "ready",
        reevaluationOutcome: "fresh",
        modalFallbackRequired: false,
      },
    });
    expect(round?.reevaluation).toMatchObject({
      outcome: "fresh",
      cachePolicy: "bypass-base-cache",
      baseCacheWrite: "forbidden",
    });
    expect(state.projectionAudits).toEqual([
      expect.objectContaining({
        sessionId: materialized.control.anchor.sessionId,
        at: NOW + 1,
        projection: expect.objectContaining({ terminalReason: null }),
      }),
    ]);
    expect(state.approvalGate.requestAndWait).not.toHaveBeenCalled();

    const approval = await state.coordinator.promptForApproval(
      materialized.control.ticketId,
      { now: NOW + 2 },
    );
    expect(approval).toMatchObject({
      outcome: "allowed-once",
      ticket: { state: "allowed_once", terminalReason: "allowed-once" },
    });
    expect(state.approvalGate.requestAndWait).toHaveBeenCalledTimes(1);
    expect(state.projectionAudits.map(({ projection }) => projection.terminalReason)).toEqual([
      null,
      "allowed-once",
    ]);
    expect(state.approvalRequests[0]).toMatchObject({
      id: materialized.control.ticketId,
      kind: "rationale",
      allowedChoices: ["allow-once", "deny-once"],
      isReadOnly: false,
    });
    expect(state.approvalRequests[0]).not.toHaveProperty("approvalCacheKey");
    expect(JSON.stringify(state.approvalRequests[0]?.args)).not.toContain("rm -rf");
    const modalArgs = state.approvalRequests[0]!.args as Record<string, unknown>;
    expect(modalArgs).toMatchObject({
      display: "rationale-approval-display",
      toolName: materialized.action.toolName,
      rationaleStatus: "ready",
    });
    // The renderer receives only explanatory display facts. Replay-sensitive
    // bindings remain in the host/audit projection and never cross the modal
    // boundary.
    expect(modalArgs).not.toHaveProperty("ticketId");
    expect(modalArgs).not.toHaveProperty("anchorId");
    expect(modalArgs).not.toHaveProperty("actionDigest");
    expect(state.projectionAudits[0]?.projection).toMatchObject({
      ticketId: materialized.control.ticketId,
      anchorId: materialized.control.anchor.anchorId,
      actionDigest: materialized.action.actionDigest,
    });
    expect(await state.coordinator.promptForApproval(
      materialized.control.ticketId,
      { now: NOW + 2 },
    )).toBeNull();

    const sealed = await state.coordinator.createSealedResume({
      ticketId: materialized.control.ticketId,
      currentEligibilityContext: eligibilityContext,
      now: NOW + 3,
    });
    expect(sealed?.resumeRequest).toMatchObject({
      kind: "sealed-rationale-resume",
      actionDigest: materialized.action.actionDigest,
      executionEntryPoint: "tool-executor-security-suffix",
      directToolExecute: "forbidden",
    });
    expect(state.ticketStore.isAuthenticConsumedAllowOnceReceipt(
      sealed!.hostConsumedAllowOnceReceipt,
      NOW + 3,
    )).toBe(true);
    expect(await state.coordinator.createSealedResume({
      ticketId: materialized.control.ticketId,
      currentEligibilityContext: eligibilityContext,
      now: NOW + 3,
    })).toBeNull();
  });

  it("enforces the scope-review deadline and falls back to the bounded modal", async () => {
    vi.useFakeTimers();
    try {
      let reviewSignal: AbortSignal | undefined;
      const reviewer: RationaleScopeReviewer = {
        async reevaluate(input) {
          reviewSignal = input.abortSignal;
          return await new Promise<never>(() => {});
        },
      };
      const state = setup({ reviewer, approvalChoice: "allow-session" });
      const materialized = materialize(state);
      const pending = state.coordinator.handleRationaleRoundResult({
        ticketId: materialized.control.ticketId,
        result: {
          kind: "calls",
          calls: [{
            id: "rationale-call-1",
            name: "permission_rationale",
            input: responseFor(materialized.control),
          }],
        },
        now: NOW + 1,
      });
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(
        TOOL_TIMEOUT_POLICY.rationaleScopeReviewMs + 1,
      );
      const round = await pending;
      expect(round).toMatchObject({
        status: "failed",
        generationOutcome: "accepted-rationale",
        response: null,
        reevaluation: { outcome: "timeout", modalFallbackRequired: true },
        projection: { rationaleStatus: "failed", modalFallbackRequired: true },
      });
      expect(reviewSignal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);

      const approval = await state.coordinator.promptForApproval(
        materialized.control.ticketId,
        { now: NOW + 2 },
      );
      expect(approval).toMatchObject({
        outcome: "cancelled",
        ticket: { state: "cancelled", terminalReason: "user-cancel" },
      });
      expect(await state.coordinator.createSealedResume({
        ticketId: materialized.control.ticketId,
        currentEligibilityContext: eligibilityContext,
        now: NOW + 3,
      })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts the ticket on in-flight caller cancellation instead of reporting timeout", async () => {
    vi.useFakeTimers();
    try {
      let reviewSignal: AbortSignal | undefined;
      const reviewer: RationaleScopeReviewer = {
        async reevaluate(input) {
          reviewSignal = input.abortSignal;
          return await new Promise<never>(() => {});
        },
      };
      const state = setup({ reviewer });
      const materialized = materialize(state);
      const caller = new AbortController();
      const pending = state.coordinator.handleRationaleRoundResult({
        ticketId: materialized.control.ticketId,
        result: {
          kind: "calls",
          calls: [{
            id: "rationale-call-1",
            name: "permission_rationale",
            input: responseFor(materialized.control),
          }],
        },
        abortSignal: caller.signal,
        now: NOW + 1,
      });
      await vi.advanceTimersByTimeAsync(0);
      caller.abort(new Error("caller cancelled"));

      await expect(pending).resolves.toBeNull();
      expect(reviewSignal?.aborted).toBe(true);
      expect(state.approvalGate.cancelPendingRationale).toHaveBeenCalledWith(
        materialized.control.ticketId,
        "caller-abort",
      );
      expect(state.ticketStore.get({
        sessionId: materialized.control.anchor.sessionId,
        ticketId: materialized.control.ticketId,
        now: NOW + 1,
      })).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not infer a host timeout from a reviewer-thrown error name", async () => {
    const reviewer: RationaleScopeReviewer = {
      async reevaluate() {
        const error = new Error("reviewer failed before the host deadline");
        error.name = "TimeoutError";
        throw error;
      },
    };
    const state = setup({ reviewer });
    const materialized = materialize(state);
    const round = await state.coordinator.handleRationaleRoundResult({
      ticketId: materialized.control.ticketId,
      result: {
        kind: "calls",
        calls: [{
          id: "rationale-call-1",
          name: "permission_rationale",
          input: responseFor(materialized.control),
        }],
      },
      now: NOW + 1,
    });

    expect(round).toMatchObject({
      status: "failed",
      reevaluation: { outcome: "error", modalFallbackRequired: true },
    });
  });

  it("fails provider errors without reviewer use and records deny without persistent grant", async () => {
    const reviewer = {
      reevaluate: vi.fn(),
    } as unknown as RationaleScopeReviewer;
    const state = setup({ reviewer, approvalChoice: "deny-once" });
    const materialized = materialize(state);
    const round = await state.coordinator.handleRationaleRoundResult({
      ticketId: materialized.control.ticketId,
      result: {
        kind: "provider-failure",
        outcome: "generation-timeout",
      },
      now: NOW + 1,
    });

    expect(round).toMatchObject({
      status: "failed",
      generationOutcome: "generation-timeout",
      response: null,
      reevaluation: null,
      projection: { modalFallbackRequired: true },
    });
    expect(reviewer.reevaluate).not.toHaveBeenCalled();
    const approval = await state.coordinator.promptForApproval(
      materialized.control.ticketId,
      { now: NOW + 2 },
    );
    expect(approval).toMatchObject({
      outcome: "denied",
      ticket: { state: "denied", terminalReason: "user-deny" },
    });
    expect(state.approvalRequests[0]).not.toHaveProperty("approvalCacheKey");
  });

  it("records an actual host modal timeout separately from a user deny", async () => {
    vi.useFakeTimers();
    try {
      const gate = new ApprovalGate({
        send: vi.fn(),
        isDestroyed: vi.fn(() => false),
      } as never, undefined, 25);
      const state = setup({ approvalGate: gate });
      const materialized = materialize(state);
      await state.coordinator.handleRationaleRoundResult({
        ticketId: materialized.control.ticketId,
        result: {
          kind: "provider-failure",
          outcome: "generation-timeout",
        },
        now: NOW + 1,
      });

      const pending = state.coordinator.promptForApproval(
        materialized.control.ticketId,
        { now: NOW + 2 },
      );
      await vi.advanceTimersByTimeAsync(26);
      await expect(pending).resolves.toMatchObject({
        outcome: "timed-out",
        ticket: {
          state: "cancelled",
          terminalReason: "modal-timeout",
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("burns an allow receipt path when current identity generations changed", async () => {
    const state = setup();
    const materialized = materialize(state);
    await state.coordinator.handleRationaleRoundResult({
      ticketId: materialized.control.ticketId,
      result: {
        kind: "calls",
        calls: [{
          id: "rationale-call-1",
          name: "permission_rationale",
          input: responseFor(materialized.control),
        }],
      },
      now: NOW + 1,
    });
    await state.coordinator.promptForApproval(materialized.control.ticketId, { now: NOW + 2 });
    state.generations.registry = "registry-generation-2";

    expect(await state.coordinator.createSealedResume({
      ticketId: materialized.control.ticketId,
      currentEligibilityContext: eligibilityContext,
      now: NOW + 3,
    })).toBeNull();
    state.generations.registry = "registry-generation-1";
    expect(await state.coordinator.createSealedResume({
      ticketId: materialized.control.ticketId,
      currentEligibilityContext: eligibilityContext,
      now: NOW + 3,
    })).toBeNull();
  });

  it("retires active tickets on abort and session close", () => {
    const abortedState = setup();
    const aborted = materialize(abortedState);
    expect(abortedState.coordinator.abort(
      aborted.control.ticketId,
      NOW + 1,
    )).toMatchObject({
      state: "cancelled",
      terminalReason: "caller-abort",
    });
    expect(abortedState.ticketStore.get({
      sessionId: aborted.control.anchor.sessionId,
      ticketId: aborted.control.ticketId,
      now: NOW + 1,
    })).toBeNull();

    const closedState = setup();
    const closed = materialize(closedState);
    expect(closedState.coordinator.closeSession(
      closed.control.anchor.sessionId,
      NOW + 1,
    )).toEqual([
      expect.objectContaining({
        ticket: expect.objectContaining({
          state: "cancelled",
          terminalReason: "session-close",
        }),
      }),
    ]);
    expect(closedState.coordinator.abort(closed.control.ticketId, NOW + 1)).toBeNull();
  });

  it("blocks the modal when the pre-modal projection audit cannot commit", async () => {
    let failProjection = true;
    const state = setup({
      onProjectionAudit: () => {
        if (failProjection) throw new Error("projection audit unavailable");
      },
    });
    const materialized = materialize(state);

    await expect(state.coordinator.handleRationaleRoundResult({
      ticketId: materialized.control.ticketId,
      result: {
        kind: "generation-failure",
        generationOutcome: "generation-error",
      },
      now: NOW + 1,
    })).rejects.toThrow(/projection audit unavailable/);
    expect(await state.coordinator.promptForApproval(
      materialized.control.ticketId,
      { now: NOW + 2 },
    )).toBeNull();
    expect(state.approvalGate.requestAndWait).not.toHaveBeenCalled();

    failProjection = false;
    expect(state.coordinator.abort(
      materialized.control.ticketId,
      NOW + 3,
    )).toMatchObject({
      state: "cancelled",
      terminalReason: "caller-abort",
    });
  });

  it("rejects an asynchronous projection audit sink before modal publication", async () => {
    const state = setup({
      onProjectionAudit: async () => {},
    });
    const materialized = materialize(state);

    await expect(state.coordinator.handleRationaleRoundResult({
      ticketId: materialized.control.ticketId,
      result: {
        kind: "generation-failure",
        generationOutcome: "generation-error",
      },
      now: NOW + 1,
    })).rejects.toThrow(/must complete synchronously/);
    expect(await state.coordinator.promptForApproval(
      materialized.control.ticketId,
      { now: NOW + 2 },
    )).toBeNull();
    expect(state.approvalGate.requestAndWait).not.toHaveBeenCalled();
  });

  it("does not expose an allow receipt when terminal projection audit fails", async () => {
    let projectionAttempt = 0;
    const state = setup({
      onProjectionAudit: () => {
        projectionAttempt += 1;
        if (projectionAttempt === 2) {
          throw new Error("terminal projection audit unavailable");
        }
      },
    });
    const materialized = materialize(state);
    await state.coordinator.handleRationaleRoundResult({
      ticketId: materialized.control.ticketId,
      result: {
        kind: "calls",
        calls: [{
          id: "rationale-call-1",
          name: "permission_rationale",
          input: responseFor(materialized.control),
        }],
      },
      now: NOW + 1,
    });

    await expect(state.coordinator.promptForApproval(
      materialized.control.ticketId,
      { now: NOW + 2 },
    )).rejects.toThrow(/terminal projection audit unavailable/);
    expect(state.approvalGate.requestAndWait).toHaveBeenCalledOnce();
    expect(state.projectionAudits).toHaveLength(1);
    expect(await state.coordinator.createSealedResume({
      ticketId: materialized.control.ticketId,
      currentEligibilityContext: eligibilityContext,
      now: NOW + 3,
    })).toBeNull();
  });

  it("quarantines an abort until its required ticket audit can be retried", async () => {
    let failAbortAudit = false;
    const state = setup({
      onTicketAudit: (event) => {
        if (failAbortAudit && event.event === "abort") {
          throw new Error("abort audit unavailable");
        }
      },
    });
    const materialized = materialize(state);
    await state.coordinator.handleRationaleRoundResult({
      ticketId: materialized.control.ticketId,
      result: {
        kind: "generation-failure",
        generationOutcome: "generation-error",
      },
      now: NOW + 1,
    });
    failAbortAudit = true;

    expect(() => state.coordinator.abort(
      materialized.control.ticketId,
      NOW + 2,
    )).toThrow(AggregateError);
    expect(await state.coordinator.promptForApproval(
      materialized.control.ticketId,
      { now: NOW + 2 },
    )).toBeNull();
    expect(state.ticketStore.get({
      sessionId: materialized.control.anchor.sessionId,
      ticketId: materialized.control.ticketId,
      now: NOW + 2,
    })?.ticket.state).toBe("user_pending");

    failAbortAudit = false;
    expect(state.coordinator.abort(
      materialized.control.ticketId,
      NOW + 3,
    )).toMatchObject({
      state: "cancelled",
      terminalReason: "caller-abort",
    });
  });

  it("surfaces abort-listener audit failure through the prompt promise", async () => {
    let failAbortAudit = false;
    const state = setup({
      deferApproval: true,
      onTicketAudit: (event) => {
        if (failAbortAudit && event.event === "abort") {
          throw new Error("listener abort audit unavailable");
        }
      },
    });
    const materialized = materialize(state);
    await state.coordinator.handleRationaleRoundResult({
      ticketId: materialized.control.ticketId,
      result: {
        kind: "generation-failure",
        generationOutcome: "generation-error",
      },
      now: NOW + 1,
    });
    failAbortAudit = true;
    const caller = new AbortController();
    const pending = state.coordinator.promptForApproval(
      materialized.control.ticketId,
      { abortSignal: caller.signal, now: NOW + 2 },
    );
    await vi.waitFor(() => {
      expect(state.approvalGate.requestAndWait).toHaveBeenCalledOnce();
    });

    expect(() => caller.abort(new Error("caller cancelled"))).not.toThrow();
    await expect(pending).rejects.toThrow(AggregateError);
    expect(state.ticketStore.get({
      sessionId: materialized.control.anchor.sessionId,
      ticketId: materialized.control.ticketId,
      now: NOW + 2,
    })?.ticket.state).toBe("user_pending");

    failAbortAudit = false;
    expect(state.coordinator.abort(
      materialized.control.ticketId,
      NOW + 3,
    )).toMatchObject({
      state: "cancelled",
      terminalReason: "caller-abort",
    });
  });

  it("settles an abort when gate cancellation throws and approval never settles", async () => {
    let failCancellation = true;
    const ticketAudits: RationaleTicketStoreAuditEvent[] = [];
    const approvalGate = {
      requestAndWait: vi.fn((_request: Omit<ApprovalRequest, "requireExplicit">) =>
        new Promise<ApprovalDecision>(() => {})),
      cancelPendingRationale: vi.fn(() => {
        if (failCancellation) throw new Error("approval cancellation unavailable");
        return false;
      }),
    } satisfies Pick<ApprovalGate, "requestAndWait" | "cancelPendingRationale">;
    const state = setup({
      approvalGate,
      onTicketAudit: (event) => ticketAudits.push(event),
    });
    const materialized = materialize(state);
    await state.coordinator.handleRationaleRoundResult({
      ticketId: materialized.control.ticketId,
      result: {
        kind: "generation-failure",
        generationOutcome: "generation-error",
      },
      now: NOW + 1,
    });
    const caller = new AbortController();
    const pending = state.coordinator.promptForApproval(
      materialized.control.ticketId,
      { abortSignal: caller.signal, now: NOW + 2 },
    );
    await vi.waitFor(() => {
      expect(approvalGate.requestAndWait).toHaveBeenCalledOnce();
    });

    expect(() => caller.abort()).not.toThrow();
    await expect(pending).rejects.toThrow(AggregateError);
    expect(state.ticketStore.get({
      sessionId: materialized.control.anchor.sessionId,
      ticketId: materialized.control.ticketId,
      now: NOW + 2,
    })).toBeNull();
    expect(ticketAudits.filter((event) => event.event === "abort")).toHaveLength(1);

    failCancellation = false;
    expect(state.coordinator.abort(
      materialized.control.ticketId,
      NOW + 3,
    )).toMatchObject({
      state: "cancelled",
      terminalReason: "caller-abort",
    });
    expect(approvalGate.cancelPendingRationale).toHaveBeenCalledTimes(2);
    expect(ticketAudits.some((event) => event.operation === "replay-rejected"))
      .toBe(false);
  });

  it("quarantines session close contexts until ticket audit recovery", async () => {
    let failCloseAudit = false;
    const state = setup({
      onTicketAudit: (event) => {
        if (failCloseAudit && event.event === "session-close") {
          throw new Error("session close audit unavailable");
        }
      },
    });
    const materialized = materialize(state);
    await state.coordinator.handleRationaleRoundResult({
      ticketId: materialized.control.ticketId,
      result: {
        kind: "generation-failure",
        generationOutcome: "generation-error",
      },
      now: NOW + 1,
    });
    failCloseAudit = true;

    expect(() => state.coordinator.closeSession(
      materialized.control.anchor.sessionId,
      NOW + 2,
    )).toThrow(AggregateError);
    expect(await state.coordinator.promptForApproval(
      materialized.control.ticketId,
      { now: NOW + 2 },
    )).toBeNull();
    expect(state.ticketStore.get({
      sessionId: materialized.control.anchor.sessionId,
      ticketId: materialized.control.ticketId,
      now: NOW + 2,
    })?.ticket.state).toBe("user_pending");

    failCloseAudit = false;
    expect(state.coordinator.closeSession(
      materialized.control.anchor.sessionId,
      NOW + 3,
    )).toEqual([
      expect.objectContaining({
        ticket: expect.objectContaining({
          state: "cancelled",
          terminalReason: "session-close",
        }),
      }),
    ]);
  });

  it("retains session-close context until gate cancellation can be retried", async () => {
    let failCancellation = true;
    let settleApproval: ((decision: ApprovalDecision) => void) | null = null;
    const approvalGate = {
      requestAndWait: vi.fn((_request: Omit<ApprovalRequest, "requireExplicit">) =>
        new Promise<ApprovalDecision>((resolve) => {
          settleApproval = resolve;
        })),
      cancelPendingRationale: vi.fn((requestId: string) => {
        if (failCancellation) throw new Error("session cancellation unavailable");
        settleApproval?.({ requestId, choice: "deny-once" });
        return true;
      }),
    } satisfies Pick<ApprovalGate, "requestAndWait" | "cancelPendingRationale">;
    const state = setup({ approvalGate });
    const materialized = materialize(state);
    await state.coordinator.handleRationaleRoundResult({
      ticketId: materialized.control.ticketId,
      result: {
        kind: "generation-failure",
        generationOutcome: "generation-error",
      },
      now: NOW + 1,
    });
    const pending = state.coordinator.promptForApproval(
      materialized.control.ticketId,
      { now: NOW + 2 },
    );
    await vi.waitFor(() => {
      expect(approvalGate.requestAndWait).toHaveBeenCalledOnce();
    });

    expect(() => state.coordinator.closeSession(
      materialized.control.anchor.sessionId,
      NOW + 2,
    )).toThrow(AggregateError);
    expect(state.ticketStore.get({
      sessionId: materialized.control.anchor.sessionId,
      ticketId: materialized.control.ticketId,
      now: NOW + 2,
    })).toBeNull();

    failCancellation = false;
    expect(state.coordinator.closeSession(
      materialized.control.anchor.sessionId,
      NOW + 3,
    )).toEqual([]);
    await expect(pending).resolves.toBeNull();
    expect(approvalGate.cancelPendingRationale).toHaveBeenCalledTimes(2);
  });
});
