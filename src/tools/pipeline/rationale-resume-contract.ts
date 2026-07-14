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
  validateReviewerScopeReevaluation,
  type ReviewerScopeAlignment,
  type ReviewerScopeReevaluation,
} from "./rationale-pr1-contract.js";
import {
  validateHostConsumedAllowOnceReceipt,
  validateRationaleTicketRecord,
  type HostConsumedAllowOnceReceipt,
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
      input.ticket.actionDigest !== input.control.action.actionDigest) {
    throw new Error("ticket/action projection mismatch");
  }
  let suggestion: string | null = null;
  if (input.ticket.rationaleStatus === "ready") {
    const parsed = parseRationaleResponse(input.response, input.control, now);
    if (!parsed || !equal(parsed, input.response)) {
      throw new Error("ready projection requires sealed rationale response");
    }
    suggestion = parsed.suggestion;
  } else if (input.response !== null) {
    throw new Error("non-ready projection must not carry main-LLM response");
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
    initialVerdict: input.control.initialVerdict,
    reevaluatedVerdict: input.reevaluation.reevaluatedVerdict,
    effectiveVerdict: input.reevaluation.effectiveVerdict,
    scopeAlignment: input.reevaluation.scopeAlignment,
    scopeReasons: input.reevaluation.scopeReasons,
    rationaleStatus: input.ticket.rationaleStatus, terminalReason: input.ticket.terminalReason,
    suggestion, modalFallbackRequired: input.reevaluation.modalFallbackRequired,
  }, "RationaleUiAuditProjection");
}

export const RATIONALE_SECURITY_SUFFIX = [
  "permission-hook",
  "permission-ask-audit",
  "approval-gate-allow-once",
  "script-pre-tool-use",
  "dlp-effect-enforcement",
  "sandbox-policy-revalidation",
] as const;

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
      input.ticket.rationaleStatus !== input.rationaleStatus) {
    throw new Error("allow-once ticket binding mismatch");
  }
  let response: RationaleResponse | null;
  if (input.rationaleStatus === "ready") {
    response = parseRationaleResponse(input.response, input.control, now);
    if (!response) throw new Error("invalid rationale response");
  } else {
    if (input.response !== null) {
      throw new Error("failed rationale handoff must not carry a response");
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
      "securitySuffix", "executionEntryPoint", "directToolExecute"],
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
      request.executionEntryPoint !== "tool-executor-security-suffix" ||
      request.directToolExecute !== "forbidden" ||
      !verifyActionIdentity(currentActionIdentity) || !equal(currentActionIdentity, control.action) ||
      !equal(request.currentActionIdentity, currentActionIdentity) ||
      !equal(request.currentEligibilityContext, currentEligibilityContext) ||
      !equal(request.securitySuffix, RATIONALE_SECURITY_SUFFIX) ||
      !validateReviewerScopeReevaluation(request.reevaluation, control, now)) return false;
    if (request.rationaleStatus === "failed") return request.response === null;
    if (request.rationaleStatus !== "ready") return false;
    const response = parseRationaleResponse(request.response, control, now);
    return response !== null && equal(response, request.response);
  } catch {
    return false;
  }
}
