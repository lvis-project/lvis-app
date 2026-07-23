import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PermissionCheckResult } from "../../../permissions/permission-manager.js";
import {
  FOREGROUND_RATIONALE_PRODUCTION_ENABLED,
  InMemoryHostAnchorRoundCasStore,
  RATIONALE_RESPONSE_SCHEMA,
  createActionIdentity,
  createRationaleRequiredControl,
  createRequestAnchor,
  createTriggeringBatchDisposition,
  parseRationaleResponse,
  type RationaleRequiredControl,
} from "../rationale-control.js";
import {
  createRationaleExecutorControlOutcome,
  createRationaleOnlyRoundContract,
  createReviewerScopeReevaluation,
  evaluateRationaleOnlyBatch,
  isReviewerAutoApproveEligible,
  validateRationaleOnlyBatchDecision,
  validateReviewerScopeReevaluation,
} from "../rationale-pr1-contract.js";
import {
  InMemoryHostInvocationStartCasStore,
  createAuthorizedInvocationAudit,
  createInvocationAuditEvent,
  createInvocationStartedAudit,
  createRationaleGenerationProviderFailureEvent,
  createRationaleReviewRequiredRecord,
  createRationaleTicketEvent,
  createRationaleTicketEventFromBatchDecision,
  transitionInvocationAudit,
  transitionRationaleTicket,
  type HostConsumedAllowOnceReceipt,
  type RationaleTicketEventName,
  type RationaleTicketStateRecord,
} from "../rationale-ticket-lifecycle.js";
import {
  RATIONALE_SECURITY_SUFFIX,
  RATIONALE_SECURITY_SUFFIX_VERSION,
  createRationaleExecutionAuthorityEntry,
  createRationaleUiAuditProjection,
  createSealedRationaleResumeRequest,
  validateRationaleUiAuditProjection,
  validateSealedRationaleResumeRequest,
} from "../rationale-resume-contract.js";

const NOW = 1_900_000_000_000;
const eligibilityContext = {
  headless: false, forceModal: false, approvalReasonPrefix: null,
} as const;
const permission = {
  decision: "ask", reason: "reviewer medium", layer: 5,
  reviewer: {
    route: "foreground-auto",
    verdict: { level: "medium", reason: "bounded workspace deletion" },
    outcome: "fresh",
  },
} as const satisfies PermissionCheckResult;

function fixture(display: {
  readonly toolName?: string;
  readonly canonicalTargets?: readonly string[];
  readonly requestedEffects?: readonly string[];
  readonly affectedResources?: readonly string[];
  readonly requiredAuthority?: string;
  readonly initialVerdictReason?: string;
} = {}): RationaleRequiredControl {
  const anchor = createRequestAnchor({
    sessionId: "session-1", turnId: "turn-1", inputMessageId: "message-1",
    inputOrigin: "user-keyboard", rawIntent: "빌드 산출물을 정리해줘",
    now: NOW, ttlMs: 60_000,
  });
  if (!anchor) throw new Error("expected anchor");
  const finalInput = { command: "Remove-Item -Recurse build" };
  const toolName = display.toolName ?? "bash";
  const action = createActionIdentity({
    anchorId: anchor.anchorId,
    invocationTrustOrigin: "llm-tool-arg",
    rationaleProvenance: { startedFromUserKeyboard: true, taint: "none" },
    toolName, toolVersion: "1", source: "builtin", category: "shell",
    finalInput, canonicalTargets: display.canonicalTargets ?? ["workspace/build"],
    requestedEffects: display.requestedEffects ?? ["delete-files"],
    affectedResources: display.affectedResources ?? ["workspace/build"],
    requiredAuthority: display.requiredAuthority ?? "shell", policyEpoch: "policy-1",
    registryGeneration: "registry-1", sandboxGeneration: "sandbox-1",
    sandboxExecutionPlan: { cwd: "workspace", filesystem: "workspace-only" },
  });
  const triggeringBatchDisposition = createTriggeringBatchDisposition({
    batchId: "provider-batch-1",
    originalToolUseIds: ["tool-use-completed", "tool-use-1", "tool-use-cancelled"],
    triggeringToolUseId: "tool-use-1",
    completedToolUseIds: ["tool-use-completed"],
  });
  const hostAnchorRoundCas = new InMemoryHostAnchorRoundCasStore();
  const anchorRoundReservation = hostAnchorRoundCas.tryReserve({
    anchor, action, triggeringBatchDisposition, round: 1, now: NOW,
  });
  if (!anchorRoundReservation) throw new Error("expected anchor reservation");
  const fixturePermission = display.initialVerdictReason === undefined
    ? permission
    : {
        ...permission,
        reviewer: {
          ...permission.reviewer,
          verdict: {
            ...permission.reviewer.verdict,
            reason: display.initialVerdictReason,
          },
        },
      } satisfies PermissionCheckResult;
  return createRationaleRequiredControl({
    anchor, action, triggeringBatchDisposition, anchorRoundReservation,
    hostAnchorRoundCas,
    eligibilityContext, permission: fixturePermission, now: NOW,
    sealedAction: {
      toolUseId: "tool-use-1", toolName,
      originalInput: finalInput, finalInput,
    },
  });
}

function responseFor(control: RationaleRequiredControl) {
  return {
    contractVersion: 1, anchorId: control.anchor.anchorId,
    ticketId: control.ticketId, actionDigest: control.action.actionDigest,
    round: 1, suggestion: "봉인된 build 폴더 삭제 작업입니다.",
  } as const;
}

function event(control: RationaleRequiredControl, name: RationaleTicketEventName) {
  return createRationaleTicketEvent(control, name, name === "rationale-failed"
    ? { generationOutcome: "accepted-rationale", reevaluationOutcome: "timeout" }
    : undefined);
}

function receiptFor(
  control: RationaleRequiredControl,
  ticket: RationaleTicketStateRecord,
  overrides: Partial<HostConsumedAllowOnceReceipt> = {},
): HostConsumedAllowOnceReceipt {
  return {
    contractVersion: 1, kind: "host-consumed-allow-once-cas",
    receiptId: "11111111-1111-4111-8111-111111111111",
    ticketId: control.ticketId, actionDigest: control.action.actionDigest,
    invocationDigest: control.invocationDigest, consumedAt: NOW, ticket,
    ...overrides,
  };
}

describe("PR1 executor channel and rationale-only round", () => {
  it("keeps rationale control out of transcript/tool-result authority", () => {
    const control = fixture();
    const outcome = createRationaleExecutorControlOutcome(control, NOW);
    expect(outcome).toMatchObject({
      channel: "executor-control", transcriptVisibility: "hidden",
      ordinaryToolResult: null, executionAuthorized: false,
    });
    expect(outcome.control.sealedAction.finalInput).toEqual(control.sealedAction.finalInput);
    expect(outcome.triggeringBatchDisposition).toEqual(
      control.triggeringBatchDisposition,
    );
    expect(outcome.anchorRoundReservation).toEqual(control.anchorRoundReservation);
    expect(outcome.triggeringBatchDisposition).not.toBe(
      outcome.control.triggeringBatchDisposition,
    );

    const round = createRationaleOnlyRoundContract(control, NOW);
    expect(round.anchorRoundBudget).toBe(1);
    expect(round.schemas).toEqual([RATIONALE_RESPONSE_SCHEMA]);
    expect(round.triggeringBatchDisposition).toBe(
      "completed-before-rationale-only-round",
    );
    expect(round.ordinaryToolSchemas).toBe("forbidden");
    expect(round.executionAuthority).toBe("none");
  });

  it("exactly partitions the triggering provider batch and atomically consumes anchor round 1", async () => {
    const control = fixture();
    expect(control.triggeringBatchDisposition).toMatchObject({
      originalToolUseIds: ["tool-use-completed", "tool-use-1", "tool-use-cancelled"],
      triggeringToolUseId: "tool-use-1",
      completedToolUseIds: ["tool-use-completed"],
      cancelledUnexecutedToolUseIds: ["tool-use-cancelled"],
      unexecutedSiblingPolicy: "cancel-all",
      followupRationaleBatchPolicy: "separate-rationale-only-batch",
    });

    const changedAction = createActionIdentity({
      anchorId: control.anchor.anchorId,
      invocationTrustOrigin: "llm-tool-arg",
      rationaleProvenance: { startedFromUserKeyboard: true, taint: "none" },
      toolName: "bash", toolVersion: "1", source: "builtin", category: "shell",
      finalInput: { command: "Remove-Item -Recurse dist" },
      canonicalTargets: ["workspace/dist"], requestedEffects: ["delete-files"],
      affectedResources: ["workspace/dist"], requiredAuthority: "shell",
      policyEpoch: "policy-1", registryGeneration: "registry-1",
      sandboxGeneration: "sandbox-1",
      sandboxExecutionPlan: { cwd: "workspace", filesystem: "workspace-only" },
    });
    const changedBatch = createTriggeringBatchDisposition({
      batchId: "provider-batch-2",
      originalToolUseIds: ["tool-use-2", "tool-use-3"],
      triggeringToolUseId: "tool-use-2", completedToolUseIds: [],
    });

    const sequentialStore = new InMemoryHostAnchorRoundCasStore();
    const winner = sequentialStore.tryReserve({
      anchor: control.anchor, action: control.action,
      triggeringBatchDisposition: control.triggeringBatchDisposition,
      round: 1, now: NOW,
    });
    if (!winner) throw new Error("expected first anchor-round winner");
    expect(sequentialStore.tryReserve({
      anchor: control.anchor, action: control.action,
      triggeringBatchDisposition: control.triggeringBatchDisposition,
      round: 1, now: NOW,
    })).toEqual(winner);
    expect(sequentialStore.tryReserve({
      anchor: control.anchor, action: changedAction,
      triggeringBatchDisposition: changedBatch, round: 1, now: NOW,
    })).toBeNull();

    const replayA = createRationaleRequiredControl({
      anchor: control.anchor, action: control.action,
      triggeringBatchDisposition: control.triggeringBatchDisposition,
      anchorRoundReservation: winner,
      hostAnchorRoundCas: sequentialStore,
      sealedAction: control.sealedAction, eligibilityContext, permission, now: NOW,
    });
    const replayB = createRationaleRequiredControl({
      anchor: control.anchor, action: control.action,
      triggeringBatchDisposition: control.triggeringBatchDisposition,
      anchorRoundReservation: winner,
      hostAnchorRoundCas: sequentialStore,
      sealedAction: control.sealedAction, eligibilityContext, permission, now: NOW,
    });
    expect(replayB).toEqual(replayA);
    expect(replayB.ticketId).toBe(replayA.ticketId);
    expect(replayB.nonce).toBe(replayA.nonce);

    const concurrentStore = new InMemoryHostAnchorRoundCasStore();
    const attempts = await Promise.all([
      { action: control.action, batch: control.triggeringBatchDisposition },
      { action: changedAction, batch: changedBatch },
    ].map(async ({ action, batch }) => {
      await Promise.resolve();
      return concurrentStore.tryReserve({
        anchor: control.anchor, action, triggeringBatchDisposition: batch,
        round: 1, now: NOW,
      });
    }));
    expect(attempts.filter((receipt) => receipt !== null)).toHaveLength(1);
  });

  it("rejects hostile batch descriptors and forged anchor CAS bindings", () => {
    const control = fixture();
    let getterCalls = 0;
    const hostile = ["tool-use-1"];
    Object.defineProperty(hostile, "0", {
      enumerable: true, configurable: true,
      get() { getterCalls += 1; return "tool-use-1"; },
    });
    expect(() => createTriggeringBatchDisposition({
      batchId: "hostile-batch", originalToolUseIds: hostile,
      triggeringToolUseId: "tool-use-1", completedToolUseIds: [],
    })).toThrow(/data property/);
    expect(getterCalls).toBe(0);
    expect(() => createTriggeringBatchDisposition({
      batchId: "duplicate-batch",
      originalToolUseIds: ["tool-use-1", "tool-use-1"],
      triggeringToolUseId: "tool-use-1", completedToolUseIds: [],
    })).toThrow(/partition is invalid/);

    const store = new InMemoryHostAnchorRoundCasStore();
    expect(() => store.tryReserve({
      anchor: control.anchor, action: control.action,
      triggeringBatchDisposition: control.triggeringBatchDisposition,
      round: 2 as never, now: NOW,
    })).toThrow(/invalid anchor-round CAS/);
    const receipt = store.tryReserve({
      anchor: control.anchor, action: control.action,
      triggeringBatchDisposition: control.triggeringBatchDisposition,
      round: 1, now: NOW,
    });
    if (!receipt) throw new Error("expected anchor reservation");
    expect(() => createRationaleRequiredControl({
      anchor: control.anchor, action: control.action,
      triggeringBatchDisposition: control.triggeringBatchDisposition,
      anchorRoundReservation: { ...receipt, actionDigest: "0".repeat(64) },
      hostAnchorRoundCas: store,
      sealedAction: control.sealedAction, eligibilityContext, permission, now: NOW,
    })).toThrow(/eligible sealed action/);
    expect(() => createRationaleRequiredControl({
      anchor: control.anchor, action: control.action,
      triggeringBatchDisposition: {
        ...control.triggeringBatchDisposition,
        cancelledUnexecutedToolUseIds: [],
      },
      anchorRoundReservation: receipt,
      hostAnchorRoundCas: store,
      sealedAction: control.sealedAction, eligibilityContext, permission, now: NOW,
    })).toThrow(/eligible sealed action/);
    expect(() => createRationaleRequiredControl({
      anchor: control.anchor, action: control.action,
      triggeringBatchDisposition: control.triggeringBatchDisposition,
      anchorRoundReservation: receipt,
      hostAnchorRoundCas: store,
      sealedAction: { ...control.sealedAction, toolUseId: "other-trigger" },
      eligibilityContext, permission, now: NOW,
    })).toThrow(/eligible sealed action/);
  });

  it("accepts one permission_rationale call and rejects ordinary calls with sibling cancel", () => {
    const control = fixture();
    const response = responseFor(control);
    const accepted = evaluateRationaleOnlyBatch(control, [{
      id: "rationale-1", name: "permission_rationale", input: response,
    }], NOW);
    expect(accepted).toMatchObject({
      accepted: true, ticketCreationAllowed: true, sideEffectsAllowed: false,
      generationOutcome: "accepted-rationale", reason: "accepted-rationale",
    });

    const rejected = evaluateRationaleOnlyBatch(control, [
      { id: "rationale-2", name: "permission_rationale", input: response },
      { id: "shell-1", name: "bash", input: { command: "whoami" } },
      { id: "write-1", name: "write_file", input: { path: "x" } },
    ], NOW);
    expect(rejected).toMatchObject({
      batchKind: "rationale-only-followup",
      accepted: false, ticketCreationAllowed: false, sideEffectsAllowed: false,
      generationOutcome: "ordinary-tool-call-rejected",
      reason: "ordinary-tool-call-rejected", rejectedCallIds: ["shell-1"],
      cancelledRationaleOnlySiblingCallIds: ["rationale-2", "write-1"],
    });
  });
  it("validates single ordinary, missing, and multiple-call generation outcomes", () => {
    const control = fixture();
    const response = responseFor(control);
    const ordinary = evaluateRationaleOnlyBatch(control, [{
      id: "shell-1", name: "bash", input: { command: "whoami" },
    }], NOW);
    expect(ordinary).toMatchObject({
      generationOutcome: "ordinary-tool-call-rejected",
      rejectedCallIds: ["shell-1"], cancelledRationaleOnlySiblingCallIds: [],
    });
    expect(validateRationaleOnlyBatchDecision(ordinary, control, NOW)).toBe(true);

    const missing = evaluateRationaleOnlyBatch(control, [], NOW);
    expect(missing.generationOutcome).toBe("missing-rationale-call");
    expect(validateRationaleOnlyBatchDecision(missing, control, NOW)).toBe(true);

    const multiple = evaluateRationaleOnlyBatch(control, [
      { id: "rationale-1", name: "permission_rationale", input: response },
      { id: "rationale-2", name: "permission_rationale", input: responseFor(control) },
    ], NOW);
    expect(multiple.generationOutcome).toBe("multiple-calls-rejected");
    expect(validateRationaleOnlyBatchDecision(multiple, control, NOW)).toBe(true);
    expect(validateRationaleOnlyBatchDecision(
      { ...ordinary, extra: true }, control, NOW,
    )).toBe(false);
  });


  it("never accepts scopeAlignment from the main LLM response", () => {
    const control = fixture();
    expect(parseRationaleResponse({
      ...responseFor(control), scopeAlignment: "aligned", scopeReasons: ["same"],
    }, control, NOW)).toBeNull();
  });
});

describe("reviewer-owned scope reevaluation", () => {
  it("uses a ticket namespace, bypasses base cache, and cannot lower risk", () => {
    const control = fixture();
    const reevaluation = createReviewerScopeReevaluation({
      control, outcome: "fresh", scopeAlignment: "aligned",
      scopeReasons: ["sealed targets match the request"],
      reevaluatedVerdict: { level: "low", reason: "narrow target" }, now: NOW,
    });
    expect(reevaluation.ticketNamespace).toBe("rationale-ticket/" + control.ticketId);
    expect(reevaluation.cachePolicy).toBe("bypass-base-cache");
    expect(reevaluation.baseCacheWrite).toBe("forbidden");
    expect(reevaluation.effectiveVerdict.level).toBe("medium");
    expect(reevaluation.modalFallbackRequired).toBe(false);
    expect(validateReviewerScopeReevaluation(reevaluation, control, NOW)).toBe(true);

    const elevated = createReviewerScopeReevaluation({
      control, outcome: "fresh", scopeAlignment: "outside",
      scopeReasons: ["target exceeds the request"],
      reevaluatedVerdict: { level: "high", reason: "scope expansion" }, now: NOW,
    });
    expect(elevated.effectiveVerdict.level).toBe("high");
    expect(validateReviewerScopeReevaluation({
      ...elevated, effectiveVerdict: { level: "low", reason: "tampered" },
    }, control, NOW)).toBe(false);
  });

  it.each([
    "unavailable", "error", "timeout", "malformed", "sandbox-state-changed",
  ] as const)("%s failure forces unknown/modal fallback without lowering risk", (outcome) => {
    const control = fixture();
    const reevaluation = createReviewerScopeReevaluation({ control, outcome, now: NOW });
    expect(reevaluation.scopeAlignment).toBe("unknown");
    expect(reevaluation.modalFallbackRequired).toBe(true);
    expect(reevaluation.reevaluatedVerdict).toEqual(control.initialVerdict);
    expect(reevaluation.effectiveVerdict).toEqual(control.initialVerdict);
    expect(validateReviewerScopeReevaluation(reevaluation, control, NOW)).toBe(true);
  });

  it("forbids cache and approval-memory in the reevaluation namespace", () => {
    const control = fixture();
    for (const outcome of ["cache", "approval-memory"] as const) {
      expect(() => createReviewerScopeReevaluation({
        control, outcome: outcome as never, now: NOW,
      })).toThrow(/forbidden/);
    }
  });

  it("rejects a non-runtime scopeAlignment value", () => {
    const control = fixture();
    expect(() => createReviewerScopeReevaluation({
      control, outcome: "fresh",
      scopeAlignment: "evil" as never,
      scopeReasons: ["attacker supplied"],
      reevaluatedVerdict: { level: "low", reason: "attacker supplied" },
      now: NOW,
    })).toThrow(/reviewer-owned scope and verdict/);
  });
});

describe("isReviewerAutoApproveEligible", () => {
  const fresh = (
    scopeAlignment: "aligned" | "unclear" | "outside",
    level: "low" | "medium" | "high",
  ) => createReviewerScopeReevaluation({
    control: fixture(), outcome: "fresh", scopeAlignment,
    scopeReasons: ["scope reason"],
    reevaluatedVerdict: { level, reason: "reviewer verdict" }, now: NOW,
  });

  it.each([
    ["aligned", "low", true],
    ["aligned", "medium", true],
    ["aligned", "high", false],
    ["unclear", "low", false],
    ["unclear", "medium", false],
    ["unclear", "high", false],
    ["outside", "low", false],
    ["outside", "medium", false],
    ["outside", "high", false],
  ] as const)(
    "fresh %s + %s reevaluated verdict → %s",
    (scopeAlignment, level, expected) => {
      expect(isReviewerAutoApproveEligible(fresh(scopeAlignment, level)))
        .toBe(expected);
    },
  );

  it.each([
    "unavailable", "error", "timeout", "malformed", "sandbox-state-changed",
  ] as const)("non-fresh reviewer failure %s → false", (outcome) => {
    const reevaluation = createReviewerScopeReevaluation({
      control: fixture(), outcome, now: NOW,
    });
    // Failure outcomes force scopeAlignment "unknown" and re-carry the initial
    // verdict; the predicate never auto-approves them (fail-closed → modal).
    expect(reevaluation.scopeAlignment).toBe("unknown");
    expect(isReviewerAutoApproveEligible(reevaluation)).toBe(false);
  });

  it("gates on reevaluatedVerdict, not effectiveVerdict", () => {
    // effectiveVerdict = max(initial, reevaluated). Construct a case where they
    // diverge (reevaluated below the sealed effectiveVerdict) and confirm the
    // predicate follows reevaluatedVerdict, never the composed effectiveVerdict.
    const control = fixture();
    const reevaluation = createReviewerScopeReevaluation({
      control, outcome: "fresh", scopeAlignment: "aligned",
      scopeReasons: ["in scope"],
      reevaluatedVerdict: { level: "low", reason: "narrower than initial" },
      now: NOW,
    });
    expect(reevaluation.reevaluatedVerdict.level).toBe("low");
    expect(reevaluation.effectiveVerdict.level).toBe("medium");
    expect(reevaluation.effectiveVerdict).not.toEqual(reevaluation.reevaluatedVerdict);
    expect(isReviewerAutoApproveEligible(reevaluation)).toBe(true);
  });
});

describe("ticket/action-bound lifecycle truth table", () => {
  it("covers every state × event pair and preserves failed→user_pending", () => {
    const control = fixture();
    const review = createRationaleReviewRequiredRecord(control, NOW);
    const requested = transitionRationaleTicket(review, event(control, "request-rationale"));
    const ready = transitionRationaleTicket(requested, event(control, "rationale-ready"));
    const failed = transitionRationaleTicket(requested, event(control, "rationale-failed"));
    const pendingReady = transitionRationaleTicket(ready, event(control, "prompt-user"));
    const pendingFailed = transitionRationaleTicket(failed, event(control, "prompt-user"));
    expect(pendingFailed).toMatchObject({ state: "user_pending", rationaleStatus: "failed" });

    const records: Record<string, RationaleTicketStateRecord> = {
      review_required: review, rationale_requested: requested, rationale_ready: ready,
      rationale_failed: failed, user_pending: pendingReady,
      allowed_once: transitionRationaleTicket(pendingReady, event(control, "allow-once")),
      denied: transitionRationaleTicket(pendingReady, event(control, "deny")),
      cancelled: transitionRationaleTicket(pendingReady, event(control, "cancel")),
      expired: transitionRationaleTicket(review, event(control, "expire")),
      rejected: transitionRationaleTicket(review, event(control, "stale-replay")),
    };
    const events: readonly RationaleTicketEventName[] = [
      "request-rationale", "rationale-ready", "rationale-failed", "prompt-user",
      "allow-once", "reviewer-authorize-once", "deny", "cancel", "modal-timeout",
      "abort", "session-close", "identity-mismatch", "stale-replay", "expire",
    ];
    const universal = new Set<RationaleTicketEventName>([
      "abort", "session-close", "identity-mismatch", "stale-replay", "expire",
    ]);
    // The reviewer auto-approve terminal moves rationale_ready straight to
    // allowed_once, so reviewer-authorize-once is legal only from that state.
    const specific: Record<string, readonly RationaleTicketEventName[]> = {
      review_required: ["request-rationale"],
      rationale_requested: ["rationale-ready", "rationale-failed"],
      rationale_ready: ["prompt-user", "reviewer-authorize-once"],
      rationale_failed: ["prompt-user"],
      user_pending: ["allow-once", "deny", "cancel", "modal-timeout"],
      allowed_once: [], denied: [], cancelled: [], expired: [], rejected: [],
    };

    for (const [state, record] of Object.entries(records)) {
      for (const name of events) {
        const allowed = !["allowed_once", "denied", "cancelled", "expired", "rejected"]
          .includes(state) && (universal.has(name) || specific[state]!.includes(name));
        const run = () => transitionRationaleTicket(record, event(control, name));
        if (allowed) expect(run).not.toThrow();
        else expect(run).toThrow();
      }
    }
  });

  it("separates generation, reviewer, and modal timeout outcomes", () => {
    const control = fixture();
    const requested = transitionRationaleTicket(
      createRationaleReviewRequiredRecord(control, NOW),
      event(control, "request-rationale"),
    );
    const accepted = evaluateRationaleOnlyBatch(control, [{
      id: "rationale-1", name: "permission_rationale", input: responseFor(control),
    }], NOW);
    const reviewerFailed = transitionRationaleTicket(
      requested,
      createRationaleTicketEventFromBatchDecision(control, accepted, "timeout", NOW),
    );
    expect(reviewerFailed).toMatchObject({
      state: "rationale_failed", generationOutcome: "accepted-rationale",
      reevaluationOutcome: "timeout", terminalReason: null,
    });

    const generationFailed = transitionRationaleTicket(
      requested,
      createRationaleGenerationProviderFailureEvent(control, "generation-timeout"),
    );
    expect(generationFailed).toMatchObject({
      state: "rationale_failed", generationOutcome: "generation-timeout",
      reevaluationOutcome: null, terminalReason: null,
    });
    const pending = transitionRationaleTicket(
      generationFailed, event(control, "prompt-user"),
    );
    const modalTimedOut = transitionRationaleTicket(
      pending, event(control, "modal-timeout"),
    );
    expect(modalTimedOut).toMatchObject({
      state: "cancelled", rationaleStatus: "failed",
      generationOutcome: "generation-timeout", reevaluationOutcome: null,
      terminalReason: "modal-timeout",
    });

    const malformed = evaluateRationaleOnlyBatch(control, [{
      id: "rationale-bad", name: "permission_rationale", input: {},
    }], NOW);
    expect(createRationaleTicketEventFromBatchDecision(
      control, malformed, null, NOW,
    )).toMatchObject({
      event: "rationale-failed", generationOutcome: "malformed-rationale",
      reevaluationOutcome: null,
    });
    expect(() => createRationaleTicketEventFromBatchDecision(
      control, malformed, "timeout", NOW,
    )).toThrow(/cannot have a reviewer outcome/);
  });

  it.each([
    "generation-unavailable",
    "generation-error",
    "generation-timeout",
  ] as const)("records provider generation failure %s without reviewer outcome", (outcome) => {
    const control = fixture();
    const requested = transitionRationaleTicket(
      createRationaleReviewRequiredRecord(control, NOW),
      event(control, "request-rationale"),
    );
    const failed = transitionRationaleTicket(
      requested,
      createRationaleGenerationProviderFailureEvent(control, outcome),
    );
    expect(failed).toMatchObject({
      state: "rationale_failed",
      generationOutcome: outcome,
      reevaluationOutcome: null,
    });
    expect(() => createRationaleTicketEvent(control, "rationale-failed", {
      generationOutcome: outcome,
      reevaluationOutcome: "timeout",
    })).toThrow(/event\/outcome mismatch/);
  });

  it("rejects ticket/action mismatches and binds terminal reasons", () => {
    const control = fixture();
    const review = createRationaleReviewRequiredRecord(control, NOW);
    expect(() => createRationaleTicketEvent(control, "evil" as never)).toThrow(
      /invalid rationale ticket event/,
    );
    expect(() => transitionRationaleTicket(review, {
      ...event(control, "request-rationale"), actionDigest: "0".repeat(64),
    })).toThrow(/binding mismatch/);
    expect(() => transitionRationaleTicket(
      review, event(control, "cancel"),
    )).toThrow(/invalid rationale ticket transition/);
    const requested = transitionRationaleTicket(
      review, event(control, "request-rationale"),
    );
    expect(() => transitionRationaleTicket(
      requested, event(control, "cancel"),
    )).toThrow(/invalid rationale ticket transition/);
    expect(transitionRationaleTicket(review, event(control, "abort"))).toMatchObject({
      state: "cancelled", terminalReason: "caller-abort",
    });
    expect(transitionRationaleTicket(review, event(control, "identity-mismatch"))).toMatchObject({
      state: "rejected", terminalReason: "identity-mismatch",
    });
  });
});

describe("invocation audit and sealed resume", () => {
  it("maps versioned security phases to the executor source in strict order", () => {
    const source = [
      "../../executor-implementation.ts",
      "../../invocation-runner.ts",
      "../../invocation-authorization.ts",
      "../../invocation-execution.ts",
    ]
      .map((relativePath) => readFileSync(new URL(relativePath, import.meta.url), "utf8"))
      .join("\n")
      .replace(/\r\n/g, "\n");
    expect(FOREGROUND_RATIONALE_PRODUCTION_ENABLED).toBe(true);
    expect(RATIONALE_SECURITY_SUFFIX_VERSION).toBe(2);
    expect(RATIONALE_SECURITY_SUFFIX).toEqual([
      "resume-cas-validate",
      "current-invocation-scope-revalidate",
      "current-policy-mode-revalidate",
      "current-permission-revalidate",
      "current-sandbox-capability-revalidate",
      "permission-request-hook",
      "permission-ask-audit",
      "approval-allow-once-cas-consume",
      "script-pre-tool-use",
      "rate-limit",
      "permission-audit-writable-fail-closed",
      "host-invocation-start-cas",
      "tool-start-emit-boundary",
      "during-execute-effect-gate-context",
      "tool-execute",
      "effect-shadow-reconciliation",
      "post-tool-use-hooks",
      "post-failure-lifecycle",
      "post-exec-dlp-display-audit",
      "tool-end-emit",
      "final-permission-audit",
      "invocation-audit-terminal",
    ]);
    const sourceMarkers = [
      ["current-invocation-scope-revalidate", "createInvocationContext(permissionContext, executionCwd)"],
      ["current-policy-mode-revalidate", "policyMode: services.permissionManager?.getMode?.()"],
      ["current-permission-revalidate", "services.permissionManager.checkDetailed("],
      ["current-sandbox-capability-revalidate", "!services.sandboxFsContainedProvider(tool)"],
      ["permission-request-hook", "const permHook = await runScriptHook("],
      ["permission-ask-audit", "await auditCurrentPermissionAsk("],
      ["script-pre-tool-use", "const scriptPre = await runScriptHook("],
      ["rate-limit", "services.rateLimiter.check(toolUse.name, trust)"],
      ["permission-audit-writable-fail-closed", "services.auditLogger.assertPermissionAuditWritable()"],
      ["tool-start-emit-boundary", "  emitToolStart(callbacks, toolUse.name, finalInput, meta);\n\n  // ── Step 6: Execute"],
      ["during-execute-effect-gate-context", "runWithEffectGateContext("],
      ["tool-execute", "() => tool.execute(finalInput, ctx)"],
      ["effect-shadow-reconciliation", "const effectSummary = effectLedger.summary()"],
      ["post-tool-use-hooks", "const postFeedback = await services.hookRunner.runPostHooks("],
      ["post-failure-lifecycle", "\"PostToolUseFailure\","],
      ["post-exec-dlp-display-audit", "const dlpResult = maskSensitiveData(content)"],
      ["tool-end-emit", "callbacks?.onToolEnd?.(toolUse.name, displayContent"],
      ["final-permission-audit", "await auditCurrentToolCall(sessionId, toolUse.name, source, trust, finalInput, auditContent"],
    ] as const;
    let sourceCursor = -1;
    let contractCursor = -1;
    for (const [phase, marker] of sourceMarkers) {
      const sourceIndex = source.indexOf(marker, sourceCursor + 1);
      const contractIndex = RATIONALE_SECURITY_SUFFIX.indexOf(phase);
      expect(sourceIndex, phase + " source marker").toBeGreaterThan(sourceCursor);
      expect(contractIndex, phase + " contract phase").toBeGreaterThan(contractCursor);
      sourceCursor = sourceIndex;
      contractCursor = contractIndex;
    }
    const phaseIndex = (phase: (typeof RATIONALE_SECURITY_SUFFIX)[number]) =>
      RATIONALE_SECURITY_SUFFIX.indexOf(phase);
    const virtualInsertionSlots = [
      {
        phase: "resume-cas-validate",
        beforePhase: null,
        afterPhase: "current-invocation-scope-revalidate",
        lowerSourceMarker: "const target = extractSealedRationaleExecutionTarget(request);",
        upperSourceMarker: "createInvocationContext(permissionContext, executionCwd)",
      },
      {
        phase: "approval-allow-once-cas-consume",
        beforePhase: "permission-ask-audit",
        afterPhase: "script-pre-tool-use",
        lowerSourceMarker: "permissionResult = {\n          decision: \"allow\",\n          reason: `user approved approval request (${decision.choice})`,",
        upperSourceMarker: "const scriptPre = await runScriptHook(",
      },
      {
        phase: "host-invocation-start-cas",
        beforePhase: "permission-audit-writable-fail-closed",
        afterPhase: "tool-start-emit-boundary",
        lowerSourceMarker: "services.auditLogger.assertPermissionAuditWritable()",
        upperSourceMarker: "  emitToolStart(callbacks, toolUse.name, finalInput, meta);\n\n  // ── Step 6: Execute",
      },
      {
        phase: "invocation-audit-terminal",
        beforePhase: "final-permission-audit",
        afterPhase: null,
        lowerSourceMarker: "await auditCurrentToolCall(sessionId, toolUse.name, source, trust, finalInput, auditContent",
        upperSourceMarker: "  return withHostShellExecutionPlan({\n    tool_use_id: toolUse.id,",
      },
    ] as const;
    for (const slot of virtualInsertionSlots) {
      const lowerSourceIndex = source.indexOf(slot.lowerSourceMarker);
      const upperSourceIndex = source.indexOf(
        slot.upperSourceMarker,
        lowerSourceIndex + 1,
      );
      expect(lowerSourceIndex, slot.phase + " lower source anchor").toBeGreaterThan(-1);
      expect(upperSourceIndex, slot.phase + " upper source anchor").toBeGreaterThan(
        lowerSourceIndex,
      );
      const virtualContractIndex = phaseIndex(slot.phase);
      expect(virtualContractIndex, slot.phase + " contract phase").toBeGreaterThan(-1);
      if (slot.beforePhase !== null) {
        expect(virtualContractIndex, slot.phase + " lower contract anchor").toBeGreaterThan(
          phaseIndex(slot.beforePhase),
        );
      }
      if (slot.afterPhase !== null) {
        expect(virtualContractIndex, slot.phase + " upper contract anchor").toBeLessThan(
          phaseIndex(slot.afterPhase),
        );
      }
    }
    expect(RATIONALE_SECURITY_SUFFIX).not.toContain("dlp-effect-enforcement" as never);
    expect(RATIONALE_SECURITY_SUFFIX).not.toContain("sandbox-policy-revalidation" as never);
  });

  it("enforces ready↔fresh and failed↔reviewer-failure across UI and resume", () => {
    const control = fixture();
    const response = responseFor(control);
    const fresh = createReviewerScopeReevaluation({
      control, outcome: "fresh", scopeAlignment: "aligned",
      scopeReasons: ["sealed action matches"],
      reevaluatedVerdict: { level: "medium", reason: "same risk" }, now: NOW,
    });
    const review = createRationaleReviewRequiredRecord(control, NOW);
    const requested = transitionRationaleTicket(review, event(control, "request-rationale"));
    const ready = transitionRationaleTicket(requested, event(control, "rationale-ready"));
    const pendingReady = transitionRationaleTicket(ready, event(control, "prompt-user"));
    const allowedReady = transitionRationaleTicket(
      pendingReady, event(control, "allow-once"),
    );
    const readyReceipt = receiptFor(control, allowedReady);

    expect(() => createRationaleUiAuditProjection({
      control, response: null, reevaluation: fresh, ticket: allowedReady, now: NOW,
    })).toThrow(/sealed rationale response/);
    expect(() => createSealedRationaleResumeRequest({
      control, response: null, rationaleStatus: "ready", reevaluation: fresh,
      ticket: allowedReady, currentActionIdentity: control.action,
      currentEligibilityContext: eligibilityContext,
      hostConsumedAllowOnceReceipt: readyReceipt, now: NOW,
    })).toThrow(/invalid rationale response/);

    for (const outcome of [
      "unavailable", "error", "timeout", "malformed", "sandbox-state-changed",
    ] as const) {
      const failure = createReviewerScopeReevaluation({ control, outcome, now: NOW });
      expect(() => createRationaleTicketEvent(
        control, "rationale-ready", {
          generationOutcome: "accepted-rationale", reevaluationOutcome: outcome,
        },
      )).toThrow(/event\/outcome mismatch/);
      expect(() => createRationaleUiAuditProjection({
        control, response, reevaluation: failure, ticket: allowedReady, now: NOW,
      })).toThrow(/projection mismatch/);
      expect(() => createSealedRationaleResumeRequest({
        control, response, rationaleStatus: "ready", reevaluation: failure,
        ticket: allowedReady, currentActionIdentity: control.action,
        currentEligibilityContext: eligibilityContext,
        hostConsumedAllowOnceReceipt: readyReceipt, now: NOW,
      })).toThrow(/ticket binding mismatch/);

      const failed = transitionRationaleTicket(
        requested, createRationaleTicketEvent(control, "rationale-failed", {
          generationOutcome: "accepted-rationale", reevaluationOutcome: outcome,
        }),
      );
      const pendingFailed = transitionRationaleTicket(
        failed, event(control, "prompt-user"),
      );
      const allowedFailed = transitionRationaleTicket(
        pendingFailed, event(control, "allow-once"),
      );
      const failedReceipt = receiptFor(control, allowedFailed);
      expect(() => createRationaleUiAuditProjection({
        control, response: null, reevaluation: fresh, ticket: allowedFailed, now: NOW,
      })).toThrow(/projection mismatch/);
      expect(() => createSealedRationaleResumeRequest({
        control, response: null, rationaleStatus: "failed", reevaluation: fresh,
        ticket: allowedFailed, currentActionIdentity: control.action,
        currentEligibilityContext: eligibilityContext,
        hostConsumedAllowOnceReceipt: failedReceipt, now: NOW,
      })).toThrow(/ticket binding mismatch/);
      expect(() => createRationaleUiAuditProjection({
        control, response, reevaluation: failure, ticket: allowedFailed, now: NOW,
      })).toThrow(/null response/);
      expect(() => createSealedRationaleResumeRequest({
        control, response, rationaleStatus: "failed", reevaluation: failure,
        ticket: allowedFailed, currentActionIdentity: control.action,
        currentEligibilityContext: eligibilityContext,
        hostConsumedAllowOnceReceipt: failedReceipt, now: NOW,
      })).toThrow(/null response/);
    }
    expect(() => createRationaleTicketEvent(
      control, "rationale-failed", {
        generationOutcome: "accepted-rationale", reevaluationOutcome: "fresh",
      },
    )).toThrow(/event\/outcome mismatch/);
  });

  it("creates a DLP-safe 3OS projection and rejects malformed durable rows", () => {
    const rawEmail = "operator@example.com";
    const windowsHome = "C:\\Users\\alice";
    const macHome = "/Users/alice";
    const linuxHome = "/home/alice";
    const control = fixture({
      toolName: "bash<script>alert(1)</script>",
      canonicalTargets: [
        join(windowsHome, "private", "output"),
        macHome + "/private/output",
        linuxHome + "/private/output",
        "file:///Users/alice/private/output",
      ],
      affectedResources: [
        windowsHome + "\\private\\output",
        linuxHome + "/private/output",
      ],
      requiredAuthority: "shell " + rawEmail,
      initialVerdictReason:
        "Writes " + windowsHome + "\\private for " + rawEmail + "\u0000",
    });
    const response = parseRationaleResponse({
      ...responseFor(control),
      suggestion:
        "Use " + macHome + "/private/output for " + rawEmail +
        "<script>alert(1)</script>\u0000",
    }, control, NOW);
    if (!response) throw new Error("expected sanitized rationale response");
    const reevaluation = createReviewerScopeReevaluation({
      control,
      outcome: "fresh",
      scopeAlignment: "aligned",
      scopeReasons: [
        "Matches " + linuxHome + "/private/output and " + rawEmail,
      ],
      reevaluatedVerdict: {
        level: "high",
        reason: "Touches file:///home/alice/private/output for " + rawEmail,
      },
      now: NOW,
    });
    const requested = transitionRationaleTicket(
      createRationaleReviewRequiredRecord(control, NOW),
      event(control, "request-rationale"),
    );
    const ready = transitionRationaleTicket(
      requested,
      createRationaleTicketEvent(control, "rationale-ready", {
        generationOutcome: "accepted-rationale",
        reevaluationOutcome: "fresh",
      }),
    );
    const pending = transitionRationaleTicket(ready, event(control, "prompt-user"));
    const projection = createRationaleUiAuditProjection({
      control,
      response,
      reevaluation,
      ticket: pending,
      now: NOW,
    });
    const serialized = JSON.stringify(projection);

    expect(validateRationaleUiAuditProjection(projection)).toBe(true);
    expect(serialized).not.toContain(rawEmail);
    expect(serialized).not.toContain("<script>");
    expect(serialized).not.toContain("\u0000");
    expect(serialized).not.toContain(windowsHome);
    expect(serialized).not.toContain(macHome);
    expect(serialized).not.toContain(linuxHome);
    expect(serialized).toContain("[home]");
    expect(validateRationaleUiAuditProjection({
      ...projection,
      ticketId: "not-a-uuid",
    })).toBe(false);
    expect(validateRationaleUiAuditProjection({
      ...projection,
      effectiveVerdict: { level: "low", reason: "downgraded" },
    })).toBe(false);
    expect(validateRationaleUiAuditProjection({
      ...projection,
      suggestion: rawEmail,
    })).toBe(false);
    expect(validateRationaleUiAuditProjection({
      ...projection,
      unexpected: true,
    })).toBe(false);
  });

  it("allows exactly one host-CAS start and no replay after started or terminal", async () => {
    const control = fixture();
    const review = createRationaleReviewRequiredRecord(control, NOW);
    const requested = transitionRationaleTicket(review, event(control, "request-rationale"));
    const ready = transitionRationaleTicket(requested, event(control, "rationale-ready"));
    const pending = transitionRationaleTicket(ready, event(control, "prompt-user"));
    const allowed = transitionRationaleTicket(pending, event(control, "allow-once"));
    const receipt = receiptFor(control, allowed);
    expect(() => createAuthorizedInvocationAudit({
      control, ticket: allowed,
      hostConsumedAllowOnceReceipt: { ...receipt, invocationDigest: "0".repeat(64) },
      now: NOW,
    })).toThrow(/receipt binding mismatch/);
    expect(() => createAuthorizedInvocationAudit({
      control, ticket: { ...allowed, rationaleStatus: "not-requested" as never },
      hostConsumedAllowOnceReceipt: receipt, now: NOW,
    })).toThrow(/status\/generation\/reevaluation outcome mismatch/);

    const authorized = createAuthorizedInvocationAudit({
      control, ticket: allowed, hostConsumedAllowOnceReceipt: receipt, now: NOW,
    });
    expect(authorized).toMatchObject({
      state: "authorized", automaticRetry: "forbidden",
      authorizationReceiptId: receipt.receiptId,
      toolUseId: control.sealedAction.toolUseId,
    });
    expect(() => createInvocationAuditEvent(authorized, "evil" as never)).toThrow(
      /invalid invocation audit event/,
    );
    expect(() => createInvocationAuditEvent(
      { ...authorized, ticketId: "forged" }, "complete",
    )).toThrow(/invalid invocation audit record/);
    expect(() => createInvocationAuditEvent(authorized, "complete")).toThrow(
      /requires a started lease/,
    );

    const startStore = new InMemoryHostInvocationStartCasStore();
    await expect(startStore.commitStart({
      sessionId: control.anchor.sessionId,
      control,
      authorized, expectedInvocationVersion: 1 as never,
      persistAudit: () => {}, now: NOW,
    })).rejects.toThrow(/invalid invocation-start CAS expectation/);
    const startCommit = await startStore.commitStart({
      sessionId: control.anchor.sessionId,
      control,
      authorized, expectedInvocationVersion: 0,
      persistAudit: () => {}, now: NOW,
    });
    if (!startCommit) throw new Error("expected invocation start lease");
    const { lease: startLease, startedInvocationAudit: started } = startCommit;
    expect(() => createInvocationStartedAudit({
      authorized,
      startLease: { ...startLease, toolUseId: "forged-tool-use" },
      now: NOW,
    })).toThrow(/lease binding mismatch/);
    expect(() => createInvocationStartedAudit({
      authorized,
      startLease: { ...startLease, extra: true } as never,
      now: NOW,
    })).toThrow(/unexpected or missing fields/);
    expect(() => createInvocationStartedAudit({
      authorized, startLease, now: Number.NaN,
    })).toThrow(/lease binding mismatch/);
    expect(await startStore.commitStart({
      sessionId: control.anchor.sessionId,
      control,
      authorized, expectedInvocationVersion: 0,
      persistAudit: () => {}, now: NOW,
    })).toBeNull();
    expect(started).toMatchObject({ state: "started", version: 1,
      invocationStartLeaseId: startLease.leaseId });
    expect(createInvocationStartedAudit({
      authorized, startLease, now: NOW,
    })).toEqual(started);

    const concurrentStore = new InMemoryHostInvocationStartCasStore();
    const concurrent = await Promise.all([0, 1, 2, 3].map(async () => {
      await Promise.resolve();
      return concurrentStore.commitStart({
        sessionId: control.anchor.sessionId,
        control,
        authorized, expectedInvocationVersion: 0,
        persistAudit: () => {}, now: NOW,
      });
    }));
    expect(concurrent.filter((commit) => commit !== null)).toHaveLength(1);

    for (const terminalEvent of ["complete", "fail", "crash-recovery"] as const) {
      const terminal = transitionInvocationAudit(
        started, createInvocationAuditEvent(started, terminalEvent),
      );
      expect(terminal.state).toBe(terminalEvent === "complete" ? "completed"
        : terminalEvent === "fail" ? "failed" : "unknown-after-crash");
      expect(terminal.version).toBe(2);
      expect(() => createInvocationAuditEvent(terminal, "complete")).toThrow(
        /requires a started lease/,
      );
    }
    const completed = transitionInvocationAudit(
      started, createInvocationAuditEvent(started, "complete"),
    );
    expect(await startStore.commitTerminal({
      lease: startLease,
      terminal: completed,
      persistAudit: () => {},
    })).toBe(true);
    expect(await startStore.commitStart({
      sessionId: control.anchor.sessionId,
      control,
      authorized, expectedInvocationVersion: 0,
      persistAudit: () => {}, now: NOW,
    })).toBeNull();
  });

  it("requires exact current identity/context, host CAS, and ordered security suffix", async () => {
    const control = fixture();
    const response = responseFor(control);
    const reevaluation = createReviewerScopeReevaluation({
      control, outcome: "fresh", scopeAlignment: "aligned",
      scopeReasons: ["sealed action matches"],
      reevaluatedVerdict: { level: "low", reason: "bounded" }, now: NOW,
    });
    const review = createRationaleReviewRequiredRecord(control, NOW);
    const requested = transitionRationaleTicket(review, event(control, "request-rationale"));
    const ready = transitionRationaleTicket(requested, event(control, "rationale-ready"));
    const pending = transitionRationaleTicket(ready, event(control, "prompt-user"));
    const allowed = transitionRationaleTicket(pending, event(control, "allow-once"));
    const receipt = receiptFor(control, allowed);
    const resume = createSealedRationaleResumeRequest({
      control, response, rationaleStatus: "ready", reevaluation, ticket: allowed,
      currentActionIdentity: control.action, currentEligibilityContext: eligibilityContext,
      hostConsumedAllowOnceReceipt: receipt, now: NOW,
    });
    expect(resume.securitySuffix).toEqual(RATIONALE_SECURITY_SUFFIX);
    expect(resume.executionEntryPoint).toBe("tool-executor-security-suffix");
    expect(resume.directToolExecute).toBe("forbidden");
    expect(validateSealedRationaleResumeRequest(
      resume, control.action, eligibilityContext, receipt, NOW,
    )).toBe(true);
    const authorized = createAuthorizedInvocationAudit({
      control, ticket: allowed, hostConsumedAllowOnceReceipt: receipt, now: NOW,
    });
    const startStore = new InMemoryHostInvocationStartCasStore();
    const startCommit = await startStore.commitStart({
      sessionId: control.anchor.sessionId,
      control,
      authorized, expectedInvocationVersion: 0,
      persistAudit: () => {}, now: NOW,
    });
    if (!startCommit) throw new Error("expected start lease");
    const authorityEntry = createRationaleExecutionAuthorityEntry({
      resumeRequest: resume,
      currentActionIdentity: control.action,
      currentEligibilityContext: eligibilityContext,
      hostConsumedAllowOnceReceipt: receipt,
      authorizedInvocationAudit: authorized,
      hostInvocationStartLease: startCommit.lease,
      startedInvocationAudit: startCommit.startedInvocationAudit,
      now: NOW,
    });
    expect(authorityEntry).toMatchObject({
      executionAuthority: "single-host-cas-start-lease",
      invocationStartLeaseId: startCommit.lease.leaseId,
      directToolExecute: "forbidden",
      startedInvocationAudit: { state: "started", version: 1 },
    });
    expect(() => createRationaleExecutionAuthorityEntry({
      resumeRequest: resume,
      currentActionIdentity: control.action,
      currentEligibilityContext: eligibilityContext,
      hostConsumedAllowOnceReceipt: receipt,
      authorizedInvocationAudit: authorized,
      hostInvocationStartLease: startCommit.lease,
      startedInvocationAudit: {
        ...startCommit.startedInvocationAudit,
        toolUseId: "forged-tool-use",
      },
      now: NOW,
    })).toThrow(/started invocation audit/);
    expect(validateSealedRationaleResumeRequest(
      { ...resume, securitySuffix: [...RATIONALE_SECURITY_SUFFIX].reverse() },
      control.action, eligibilityContext, receipt, NOW,
    )).toBe(false);
    expect(() => createSealedRationaleResumeRequest({
      control, response, rationaleStatus: "ready", reevaluation, ticket: allowed,
      currentActionIdentity: { ...control.action, policyEpoch: "policy-2" },
      currentEligibilityContext: eligibilityContext,
      hostConsumedAllowOnceReceipt: receipt, now: NOW,
    })).toThrow(/ActionIdentity/);
    expect(() => createSealedRationaleResumeRequest({
      control, response, rationaleStatus: "ready", reevaluation, ticket: allowed,
      currentActionIdentity: control.action,
      currentEligibilityContext: { ...eligibilityContext, forceModal: true },
      hostConsumedAllowOnceReceipt: receipt, now: NOW,
    })).toThrow(/stale rationale control/);
    expect(() => createSealedRationaleResumeRequest({
      control, response, rationaleStatus: "ready", reevaluation, ticket: allowed,
      currentActionIdentity: control.action, currentEligibilityContext: eligibilityContext,
      hostConsumedAllowOnceReceipt: { ...receipt, invocationDigest: "0".repeat(64) },
      now: NOW,
    })).toThrow(/receipt binding mismatch/);

    expect(() => createSealedRationaleResumeRequest({
      control, response, rationaleStatus: "evil" as never, reevaluation, ticket: allowed,
      currentActionIdentity: control.action, currentEligibilityContext: eligibilityContext,
      hostConsumedAllowOnceReceipt: receipt, now: NOW,
    })).toThrow(/runtime rationaleStatus/);

    const forgedEmbeddedTicket = {
      ...allowed, rationaleStatus: "failed" as const,
      reevaluationOutcome: "timeout" as const,
    };
    expect(() => createSealedRationaleResumeRequest({
      control, response: null, rationaleStatus: "failed", reevaluation,
      ticket: forgedEmbeddedTicket, currentActionIdentity: control.action,
      currentEligibilityContext: eligibilityContext,
      hostConsumedAllowOnceReceipt: receipt, now: NOW,
    })).toThrow(/receipt binding mismatch/);
    expect(validateSealedRationaleResumeRequest(
      { ...resume, response: null, rationaleStatus: "failed", ticket: forgedEmbeddedTicket },
      control.action, eligibilityContext, receipt, NOW,
    )).toBe(false);

    const projection = createRationaleUiAuditProjection({
      control, response, reevaluation, ticket: allowed, now: NOW,
    });
    expect(projection).toMatchObject({
      canonicalTargets: control.action.canonicalTargets,
      requestedEffects: control.action.requestedEffects,
      affectedResources: control.action.affectedResources,
      reviewerOutcome: "fresh", reevaluationOutcome: "fresh",
      scopeAlignment: "aligned",
      rationaleStatus: "ready", terminalReason: "allowed-once",
    });
    expect(projection.effectiveVerdict.level).toBe("medium");
  });

  it("supports failed rationale only through modal fallback and sealed allow-once", () => {
    const control = fixture();
    const reevaluation = createReviewerScopeReevaluation({
      control, outcome: "timeout", now: NOW,
    });
    const review = createRationaleReviewRequiredRecord(control, NOW);
    const requested = transitionRationaleTicket(review, event(control, "request-rationale"));
    const failed = transitionRationaleTicket(requested, event(control, "rationale-failed"));
    const pending = transitionRationaleTicket(failed, event(control, "prompt-user"));
    const allowed = transitionRationaleTicket(pending, event(control, "allow-once"));
    const receipt = receiptFor(control, allowed);
    const resume = createSealedRationaleResumeRequest({
      control, response: null, rationaleStatus: "failed", reevaluation, ticket: allowed,
      currentActionIdentity: control.action, currentEligibilityContext: eligibilityContext,
      hostConsumedAllowOnceReceipt: receipt, now: NOW,
    });
    expect(resume.response).toBeNull();
    const projection = createRationaleUiAuditProjection({
      control, response: null, reevaluation, ticket: allowed, now: NOW,
    });
    expect(projection).toMatchObject({
      scopeAlignment: "unknown", modalFallbackRequired: true,
      reevaluationOutcome: "timeout",
      rationaleStatus: "failed", terminalReason: "allowed-once",
    });
    expect(projection.effectiveVerdict).toEqual(control.initialVerdict);
  });
  it("seals generation failure without a synthetic reviewer outcome", () => {
    const control = fixture();
    const requested = transitionRationaleTicket(
      createRationaleReviewRequiredRecord(control, NOW),
      event(control, "request-rationale"),
    );
    const failed = transitionRationaleTicket(
      requested,
      createRationaleGenerationProviderFailureEvent(control, "generation-error"),
    );
    const pending = transitionRationaleTicket(failed, event(control, "prompt-user"));
    const allowed = transitionRationaleTicket(pending, event(control, "allow-once"));
    const receipt = receiptFor(control, allowed);
    const resume = createSealedRationaleResumeRequest({
      control, response: null, rationaleStatus: "failed", reevaluation: null,
      ticket: allowed, currentActionIdentity: control.action,
      currentEligibilityContext: eligibilityContext,
      hostConsumedAllowOnceReceipt: receipt, now: NOW,
    });
    expect(resume).toMatchObject({
      generationOutcome: "generation-error", reevaluation: null, response: null,
    });
    expect(validateSealedRationaleResumeRequest(
      resume, control.action, eligibilityContext, receipt, NOW,
    )).toBe(true);

    const projection = createRationaleUiAuditProjection({
      control, response: null, reevaluation: null, ticket: allowed, now: NOW,
    });
    expect(projection).toMatchObject({
      generationOutcome: "generation-error", reevaluationOutcome: null,
      reevaluatedVerdict: control.initialVerdict,
      effectiveVerdict: control.initialVerdict,
      scopeAlignment: "unknown", modalFallbackRequired: true,
    });
  });

});
