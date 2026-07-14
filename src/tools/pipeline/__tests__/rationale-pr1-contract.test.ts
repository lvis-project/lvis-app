import { describe, expect, it } from "vitest";
import type { PermissionCheckResult } from "../../../permissions/permission-manager.js";
import {
  RATIONALE_RESPONSE_SCHEMA,
  createActionIdentity,
  createRationaleRequiredControl,
  createRequestAnchor,
  parseRationaleResponse,
  type RationaleRequiredControl,
} from "../rationale-control.js";
import {
  createRationaleExecutorControlOutcome,
  createRationaleOnlyRoundContract,
  createReviewerScopeReevaluation,
  evaluateRationaleOnlyBatch,
  validateReviewerScopeReevaluation,
} from "../rationale-pr1-contract.js";
import {
  createAuthorizedInvocationAudit,
  createInvocationAuditEvent,
  createRationaleReviewRequiredRecord,
  createRationaleTicketEvent,
  transitionInvocationAudit,
  transitionRationaleTicket,
  type HostConsumedAllowOnceReceipt,
  type RationaleTicketEventName,
  type RationaleTicketStateRecord,
} from "../rationale-ticket-lifecycle.js";
import {
  RATIONALE_SECURITY_SUFFIX,
  createRationaleUiAuditProjection,
  createSealedRationaleResumeRequest,
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

function fixture(): RationaleRequiredControl {
  const anchor = createRequestAnchor({
    sessionId: "session-1", turnId: "turn-1", inputMessageId: "message-1",
    inputOrigin: "user-keyboard", rawIntent: "빌드 산출물을 정리해줘",
    now: NOW, ttlMs: 60_000,
  });
  if (!anchor) throw new Error("expected anchor");
  const finalInput = { command: "Remove-Item -Recurse build" };
  const action = createActionIdentity({
    anchorId: anchor.anchorId,
    invocationTrustOrigin: "llm-tool-arg",
    rationaleProvenance: { startedFromUserKeyboard: true, taint: "none" },
    toolName: "bash", toolVersion: "1", source: "builtin", category: "shell",
    finalInput, canonicalTargets: ["workspace/build"],
    requestedEffects: ["delete-files"], affectedResources: ["workspace/build"],
    requiredAuthority: "shell", policyEpoch: "policy-1",
    registryGeneration: "registry-1", sandboxGeneration: "sandbox-1",
    sandboxExecutionPlan: { cwd: "workspace", filesystem: "workspace-only" },
  });
  return createRationaleRequiredControl({
    anchor, action, eligibilityContext, permission, now: NOW,
    sealedAction: {
      toolUseId: "tool-use-1", toolName: "bash",
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
  return createRationaleTicketEvent(control, name);
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

    const round = createRationaleOnlyRoundContract(control, NOW);
    expect(round.anchorRoundBudget).toBe(1);
    expect(round.schemas).toEqual([RATIONALE_RESPONSE_SCHEMA]);
    expect(round.ordinaryToolSchemas).toBe("forbidden");
    expect(round.executionAuthority).toBe("none");
  });

  it("accepts one permission_rationale call and rejects ordinary calls with sibling cancel", () => {
    const control = fixture();
    const response = responseFor(control);
    const accepted = evaluateRationaleOnlyBatch(control, [{
      id: "rationale-1", name: "permission_rationale", input: response,
    }], NOW);
    expect(accepted).toMatchObject({
      accepted: true, ticketCreationAllowed: true, sideEffectsAllowed: false,
      reason: "accepted-rationale",
    });

    const rejected = evaluateRationaleOnlyBatch(control, [
      { id: "rationale-2", name: "permission_rationale", input: response },
      { id: "shell-1", name: "bash", input: { command: "whoami" } },
      { id: "write-1", name: "write_file", input: { path: "x" } },
    ], NOW);
    expect(rejected).toMatchObject({
      accepted: false, ticketCreationAllowed: false, sideEffectsAllowed: false,
      reason: "ordinary-tool-call-rejected", rejectedCallIds: ["shell-1"],
      cancelledSiblingCallIds: ["rationale-2", "write-1"],
    });
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
      "allow-once", "deny", "cancel", "modal-timeout", "abort", "session-close",
      "identity-mismatch", "stale-replay", "expire",
    ];
    const universal = new Set<RationaleTicketEventName>([
      "cancel", "abort", "session-close", "identity-mismatch", "stale-replay", "expire",
    ]);
    const specific: Record<string, readonly RationaleTicketEventName[]> = {
      review_required: ["request-rationale"],
      rationale_requested: ["rationale-ready", "rationale-failed"],
      rationale_ready: ["prompt-user"],
      rationale_failed: ["prompt-user"],
      user_pending: ["allow-once", "deny", "modal-timeout"],
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

  it("rejects ticket/action mismatches and binds terminal reasons", () => {
    const control = fixture();
    const review = createRationaleReviewRequiredRecord(control, NOW);
    expect(() => createRationaleTicketEvent(control, "evil" as never)).toThrow(
      /invalid rationale ticket event/,
    );
    expect(() => transitionRationaleTicket(review, {
      ...event(control, "request-rationale"), actionDigest: "0".repeat(64),
    })).toThrow(/binding mismatch/);
    expect(transitionRationaleTicket(review, event(control, "abort"))).toMatchObject({
      state: "cancelled", terminalReason: "caller-abort",
    });
    expect(transitionRationaleTicket(review, event(control, "identity-mismatch"))).toMatchObject({
      state: "rejected", terminalReason: "identity-mismatch",
    });
  });
});

describe("invocation audit and sealed resume", () => {
  it("tracks authorized→started→completed|failed|unknown-after-crash with no terminal retry", () => {
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
    })).toThrow(/reviewed rationale status/);

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
      { ...authorized, ticketId: "forged" }, "start",
    )).toThrow(/invalid invocation audit record/);
    expect(() => transitionInvocationAudit(
      authorized, createInvocationAuditEvent(authorized, "complete"),
    )).toThrow(/invalid invocation audit transition/);
    const started = transitionInvocationAudit(
      authorized, createInvocationAuditEvent(authorized, "start"),
    );
    for (const terminalEvent of ["complete", "fail", "crash-recovery"] as const) {
      const terminal = transitionInvocationAudit(
        started, createInvocationAuditEvent(started, terminalEvent),
      );
      expect(terminal.state).toBe(terminalEvent === "complete" ? "completed"
        : terminalEvent === "fail" ? "failed" : "unknown-after-crash");
      expect(() => transitionInvocationAudit(
        terminal, createInvocationAuditEvent(terminal, "start"),
      )).toThrow();
    }
  });

  it("requires exact current identity/context, host CAS, and ordered security suffix", () => {
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

    const forgedEmbeddedTicket = { ...allowed, rationaleStatus: "failed" as const };
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
      reviewerOutcome: "fresh", scopeAlignment: "aligned",
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
      rationaleStatus: "failed", terminalReason: "allowed-once",
    });
    expect(projection.effectiveVerdict).toEqual(control.initialVerdict);
  });
});
