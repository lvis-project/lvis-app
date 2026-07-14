import { canonicalStringify } from "../../permissions/user-approval-store.js";
import type { RiskVerdict } from "../../permissions/reviewer/risk-classifier.js";
import {
  RATIONALE_CONTROL_CONTRACT_VERSION,
  assertRationaleCanonicalJson,
  cloneRationaleCanonicalJson,
  parseRationaleResponse,
  verifyActionIdentity,
  verifyRationaleRequiredControl,
  type ActionIdentity,
  type HostRationaleEligibilityContext,
  type RationaleRequiredControl,
  type RationaleResponse,
} from "./rationale-control.js";
import {
  REVIEWER_REEVALUATION_FAILURE_OUTCOMES,
  validateReviewerScopeReevaluation,
  type ReviewerScopeAlignment,
  type ReviewerReevaluationOutcome,
  type ReviewerScopeReevaluation,
} from "./rationale-pr1-contract.js";
import {
  createInvocationStartedAudit,
  validateHostInvocationStartLease,
  validateInvocationAuditRecord,
  validateHostConsumedAllowOnceReceipt,
  validateRationaleTicketRecord,
  type HostConsumedAllowOnceReceipt,
  type HostInvocationStartCas,
  type HostInvocationStartLease,
  type InvocationAuditRecord,
  type RationaleStatus,
  type RationaleTerminalReason,
  type RationaleTicketStateRecord,
} from "./rationale-ticket-lifecycle.js";

function seal<T>(value: T, label: string): T {
  return cloneRationaleCanonicalJson(value, label) as T;
}

function equal(a: unknown, b: unknown): boolean {
  return canonicalStringify(a) === canonicalStringify(b);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exact(value: object, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((v, i) => v !== wanted[i])) {
    throw new TypeError(label + " contains unexpected or missing fields");
  }
}

export interface RationaleUiAuditProjection {
  contractVersion: typeof RATIONALE_CONTROL_CONTRACT_VERSION;
  projection: "rationale-ui-audit";
  ticketId: string; anchorId: string; actionDigest: string; round: 1;
  reasonCode: "foreground-reviewer-threshold";
  toolName: string;
  canonicalTargets: readonly string[];
  requestedEffects: readonly string[];
  affectedResources: readonly string[];
  requiredAuthority: string;
  reviewerOutcome: "fresh" | "cache";
  reevaluationOutcome: ReviewerReevaluationOutcome;
  initialVerdict: RiskVerdict;
  reevaluatedVerdict: RiskVerdict;
  effectiveVerdict: RiskVerdict;
  scopeAlignment: ReviewerScopeAlignment;
  scopeReasons: readonly string[];
  rationaleStatus: RationaleStatus;
  terminalReason: RationaleTerminalReason | null;
  suggestion: string | null;
  modalFallbackRequired: boolean;
}

export function createRationaleUiAuditProjection(input: {
  control: RationaleRequiredControl;
  response: RationaleResponse | null;
  reevaluation: ReviewerScopeReevaluation;
  ticket: RationaleTicketStateRecord;
  now?: number;
}): RationaleUiAuditProjection {
  const now = input.now ?? Date.now();
  if (!verifyRationaleRequiredControl(input.control, { now }) ||
      !validateReviewerScopeReevaluation(input.reevaluation, input.control, now)) {
    throw new Error("invalid rationale UI/audit binding");
  }
  validateRationaleTicketRecord(input.ticket);
  if (input.ticket.ticketId !== input.control.ticketId ||
      input.ticket.actionDigest !== input.control.action.actionDigest ||
      input.ticket.reevaluationOutcome !== input.reevaluation.outcome) {
    throw new Error("ticket/action projection mismatch");
  }
  let suggestion: string | null = null;
  if (input.ticket.rationaleStatus === "ready") {
    if (input.reevaluation.outcome !== "fresh" ||
        input.reevaluation.modalFallbackRequired !== false) {
      throw new Error("ready rationale requires fresh reviewer reevaluation");
    }
    const parsed = parseRationaleResponse(input.response, input.control, now);
    if (!parsed || !equal(parsed, input.response)) {
      throw new Error("ready projection requires sealed rationale response");
    }
    suggestion = parsed.suggestion;
  } else if (input.ticket.rationaleStatus === "failed") {
    if (!REVIEWER_REEVALUATION_FAILURE_OUTCOMES.includes(
      input.reevaluation.outcome as never,
    ) || input.reevaluation.modalFallbackRequired !== true || input.response !== null) {
      throw new Error("failed rationale requires reviewer failure and modal fallback");
    }
  } else {
    throw new Error("UI/audit projection requires ready or failed rationale status");
  }
  return seal({ contractVersion: RATIONALE_CONTROL_CONTRACT_VERSION,
    projection: "rationale-ui-audit", ticketId: input.control.ticketId,
    anchorId: input.control.anchor.anchorId,
    actionDigest: input.control.action.actionDigest, round: 1,
    reasonCode: input.control.reasonCode, toolName: input.control.action.toolName,
    canonicalTargets: input.control.action.canonicalTargets,
    requestedEffects: input.control.action.requestedEffects,
    affectedResources: input.control.action.affectedResources,
    requiredAuthority: input.control.action.requiredAuthority,
    reviewerOutcome: input.control.reviewerOutcome,
    reevaluationOutcome: input.reevaluation.outcome,
    initialVerdict: input.control.initialVerdict,
    reevaluatedVerdict: input.reevaluation.reevaluatedVerdict,
    effectiveVerdict: input.reevaluation.effectiveVerdict,
    scopeAlignment: input.reevaluation.scopeAlignment,
    scopeReasons: input.reevaluation.scopeReasons,
    rationaleStatus: input.ticket.rationaleStatus, terminalReason: input.ticket.terminalReason,
    suggestion, modalFallbackRequired: input.reevaluation.modalFallbackRequired,
  }, "RationaleUiAuditProjection");
}

export const RATIONALE_SECURITY_SUFFIX_VERSION = 2 as const;

export const RATIONALE_SECURITY_SUFFIX = Object.freeze([
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
] as const);

export type RationaleSecuritySuffixStep = (typeof RATIONALE_SECURITY_SUFFIX)[number];

export interface SealedRationaleResumeRequest {
  contractVersion: typeof RATIONALE_CONTROL_CONTRACT_VERSION;
  kind: "sealed-rationale-resume";
  ticketId: string; actionDigest: string; invocationDigest: string;
  authorizationReceiptId: string;
  control: RationaleRequiredControl;
  response: RationaleResponse | null;
  rationaleStatus: Extract<RationaleStatus, "ready" | "failed">;
  reevaluation: ReviewerScopeReevaluation;
  ticket: RationaleTicketStateRecord;
  currentActionIdentity: ActionIdentity;
  currentEligibilityContext: HostRationaleEligibilityContext;
  securitySuffixVersion: typeof RATIONALE_SECURITY_SUFFIX_VERSION;
  securitySuffix: readonly RationaleSecuritySuffixStep[];
  executionEntryPoint: "tool-executor-security-suffix";
  directToolExecute: "forbidden";
}

export function createSealedRationaleResumeRequest(input: {
  control: RationaleRequiredControl;
  response: unknown | null;
  rationaleStatus: "ready" | "failed";
  reevaluation: ReviewerScopeReevaluation;
  ticket: RationaleTicketStateRecord;
  currentActionIdentity: ActionIdentity;
  currentEligibilityContext: HostRationaleEligibilityContext;
  hostConsumedAllowOnceReceipt: HostConsumedAllowOnceReceipt;
  now?: number;
}): SealedRationaleResumeRequest {
  const now = input.now ?? Date.now();
  if (input.rationaleStatus !== "ready" && input.rationaleStatus !== "failed") {
    throw new TypeError("invalid runtime rationaleStatus");
  }
  if (!verifyRationaleRequiredControl(input.control, {
    now, currentEligibilityContext: input.currentEligibilityContext,
  })) throw new Error("invalid, expired, or stale rationale control");
  if (!verifyActionIdentity(input.currentActionIdentity) ||
      !equal(input.currentActionIdentity, input.control.action)) {
    throw new Error("current ActionIdentity does not match sealed action");
  }
  if (!validateReviewerScopeReevaluation(input.reevaluation, input.control, now)) {
    throw new Error("reviewer reevaluation binding mismatch");
  }
  validateRationaleTicketRecord(input.ticket);
  validateHostConsumedAllowOnceReceipt(
    input.hostConsumedAllowOnceReceipt, input.control, input.ticket, now,
  );
  if (input.ticket.ticketId !== input.control.ticketId ||
      input.ticket.actionDigest !== input.control.action.actionDigest ||
      input.ticket.state !== "allowed_once" || input.ticket.terminalReason !== "allowed-once" ||
      input.ticket.rationaleStatus !== input.rationaleStatus ||
      input.ticket.reevaluationOutcome !== input.reevaluation.outcome) {
    throw new Error("allow-once ticket binding mismatch");
  }
  let response: RationaleResponse | null;
  if (input.rationaleStatus === "ready") {
    if (input.reevaluation.outcome !== "fresh" ||
        input.reevaluation.modalFallbackRequired !== false) {
      throw new Error("ready rationale requires fresh reviewer reevaluation");
    }
    response = parseRationaleResponse(input.response, input.control, now);
    if (!response) throw new Error("invalid rationale response");
  } else {
    if (!REVIEWER_REEVALUATION_FAILURE_OUTCOMES.includes(
      input.reevaluation.outcome as never,
    ) || input.reevaluation.modalFallbackRequired !== true || input.response !== null) {
      throw new Error("failed rationale requires reviewer failure and null response");
    }
    response = null;
  }
  return seal({ contractVersion: RATIONALE_CONTROL_CONTRACT_VERSION,
    kind: "sealed-rationale-resume", ticketId: input.control.ticketId,
    actionDigest: input.control.action.actionDigest,
    invocationDigest: input.control.invocationDigest,
    authorizationReceiptId: input.hostConsumedAllowOnceReceipt.receiptId,
    control: seal(input.control, "control"), response,
    rationaleStatus: input.rationaleStatus, reevaluation: input.reevaluation,
    ticket: input.ticket, currentActionIdentity: seal(input.currentActionIdentity, "currentActionIdentity"),
    currentEligibilityContext: seal(input.currentEligibilityContext, "currentEligibilityContext"),
    securitySuffixVersion: RATIONALE_SECURITY_SUFFIX_VERSION,
    securitySuffix: RATIONALE_SECURITY_SUFFIX,
    executionEntryPoint: "tool-executor-security-suffix", directToolExecute: "forbidden",
  }, "SealedRationaleResumeRequest");
}

export function validateSealedRationaleResumeRequest(
  request: unknown,
  currentActionIdentity: ActionIdentity,
  currentEligibilityContext: HostRationaleEligibilityContext,
  hostConsumedAllowOnceReceipt: HostConsumedAllowOnceReceipt,
  now = Date.now(),
): request is SealedRationaleResumeRequest {
  try {
    assertRationaleCanonicalJson(request, "SealedRationaleResumeRequest");
    if (!isRecord(request)) return false;
    exact(request, ["contractVersion", "kind", "ticketId", "actionDigest",
      "invocationDigest", "authorizationReceiptId", "control", "response", "rationaleStatus",
      "reevaluation", "ticket", "currentActionIdentity", "currentEligibilityContext",
      "securitySuffixVersion", "securitySuffix", "executionEntryPoint", "directToolExecute"],
      "SealedRationaleResumeRequest");
    const control = request.control as RationaleRequiredControl;
    if (!verifyRationaleRequiredControl(control, { now, currentEligibilityContext })) return false;
    const ticket = request.ticket as RationaleTicketStateRecord;
    validateRationaleTicketRecord(ticket);
    validateHostConsumedAllowOnceReceipt(
      hostConsumedAllowOnceReceipt, control, ticket, now,
    );
    if (request.contractVersion !== RATIONALE_CONTROL_CONTRACT_VERSION ||
      request.kind !== "sealed-rationale-resume" || request.ticketId !== control.ticketId ||
      request.actionDigest !== control.action.actionDigest ||
      request.invocationDigest !== control.invocationDigest ||
      request.authorizationReceiptId !== hostConsumedAllowOnceReceipt.receiptId ||
      ticket.ticketId !== control.ticketId || ticket.actionDigest !== control.action.actionDigest ||
      ticket.state !== "allowed_once" || ticket.terminalReason !== "allowed-once" ||
      ticket.rationaleStatus !== request.rationaleStatus ||
      ticket.reevaluationOutcome !==
        (request.reevaluation as ReviewerScopeReevaluation).outcome ||
      request.executionEntryPoint !== "tool-executor-security-suffix" ||
      request.securitySuffixVersion !== RATIONALE_SECURITY_SUFFIX_VERSION ||
      request.directToolExecute !== "forbidden" ||
      !verifyActionIdentity(currentActionIdentity) || !equal(currentActionIdentity, control.action) ||
      !equal(request.currentActionIdentity, currentActionIdentity) ||
      !equal(request.currentEligibilityContext, currentEligibilityContext) ||
      !equal(request.securitySuffix, RATIONALE_SECURITY_SUFFIX) ||
      !validateReviewerScopeReevaluation(request.reevaluation, control, now)) return false;
    if (request.rationaleStatus === "failed") {
      const reevaluation = request.reevaluation as ReviewerScopeReevaluation;
      return request.response === null && reevaluation.modalFallbackRequired === true &&
        REVIEWER_REEVALUATION_FAILURE_OUTCOMES.includes(reevaluation.outcome as never);
    }
    if (request.rationaleStatus !== "ready") return false;
    const reevaluation = request.reevaluation as ReviewerScopeReevaluation;
    if (reevaluation.outcome !== "fresh" || reevaluation.modalFallbackRequired !== false) {
      return false;
    }
    const response = parseRationaleResponse(request.response, control, now);
    return response !== null && equal(response, request.response);
  } catch {
    return false;
  }
}

export interface RationaleExecutionAuthorityEntry {
  contractVersion: typeof RATIONALE_CONTROL_CONTRACT_VERSION;
  kind: "rationale-execution-authority-entry";
  ticketId: string;
  actionDigest: string;
  invocationDigest: string;
  toolUseId: string;
  authorizationReceiptId: string;
  invocationStartLeaseId: string;
  securitySuffixVersion: typeof RATIONALE_SECURITY_SUFFIX_VERSION;
  resumeRequest: SealedRationaleResumeRequest;
  startLease: HostInvocationStartLease;
  startedInvocationAudit: InvocationAuditRecord;
  executionAuthority: "single-host-cas-start-lease";
  directToolExecute: "forbidden";
}

export function createRationaleExecutionAuthorityEntry(input: {
  resumeRequest: SealedRationaleResumeRequest;
  currentActionIdentity: ActionIdentity;
  currentEligibilityContext: HostRationaleEligibilityContext;
  hostConsumedAllowOnceReceipt: HostConsumedAllowOnceReceipt;
  authorizedInvocationAudit: InvocationAuditRecord;
  hostInvocationStartLease: HostInvocationStartLease;
  hostStartCas: HostInvocationStartCas;
  now?: number;
}): RationaleExecutionAuthorityEntry {
  const now = input.now ?? Date.now();
  if (!validateSealedRationaleResumeRequest(
    input.resumeRequest,
    input.currentActionIdentity,
    input.currentEligibilityContext,
    input.hostConsumedAllowOnceReceipt,
    now,
  )) throw new Error("invalid sealed rationale resume authority input");
  validateInvocationAuditRecord(input.authorizedInvocationAudit);
  validateHostInvocationStartLease(
    input.hostInvocationStartLease, input.authorizedInvocationAudit, now,
  );
  const control = input.resumeRequest.control;
  if (input.authorizedInvocationAudit.state !== "authorized" ||
      input.authorizedInvocationAudit.ticketId !== control.ticketId ||
      input.authorizedInvocationAudit.actionDigest !== control.action.actionDigest ||
      input.authorizedInvocationAudit.invocationDigest !== control.invocationDigest ||
      input.authorizedInvocationAudit.toolUseId !== control.sealedAction.toolUseId ||
      input.authorizedInvocationAudit.authorizationReceiptId !==
        input.resumeRequest.authorizationReceiptId) {
    throw new Error("authorized invocation does not match resume request");
  }
  const startedInvocationAudit = createInvocationStartedAudit({
    authorized: input.authorizedInvocationAudit,
    startLease: input.hostInvocationStartLease,
    hostStartCas: input.hostStartCas,
    now,
  });
  return seal({
    contractVersion: RATIONALE_CONTROL_CONTRACT_VERSION,
    kind: "rationale-execution-authority-entry",
    ticketId: control.ticketId,
    actionDigest: control.action.actionDigest,
    invocationDigest: control.invocationDigest,
    toolUseId: control.sealedAction.toolUseId,
    authorizationReceiptId: input.resumeRequest.authorizationReceiptId,
    invocationStartLeaseId: input.hostInvocationStartLease.leaseId,
    securitySuffixVersion: RATIONALE_SECURITY_SUFFIX_VERSION,
    resumeRequest: input.resumeRequest,
    startLease: input.hostInvocationStartLease,
    startedInvocationAudit,
    executionAuthority: "single-host-cas-start-lease",
    directToolExecute: "forbidden",
  }, "RationaleExecutionAuthorityEntry");
}
