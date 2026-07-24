import { canonicalStringify } from "../../permissions/user-approval-store.js";
import type { RiskVerdict } from "../../permissions/reviewer/risk-classifier.js";
import { redactHomePathsInText } from "../../audit/dlp-filter.js";
import {
  createRationaleApprovalDisplay,
  normalizeRationaleApprovalDisplayText,
  type RationaleApprovalDisplay,
} from "../../shared/rationale-approval-display.js";
import {
  RATIONALE_CONTROL_CONTRACT_VERSION,
  assertRationaleCanonicalJson,
  cloneRationaleCanonicalJson,
  normalizeRationaleRiskVerdict,
  parseRationaleResponse,
  sanitizeDisplayText,
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
  type RationaleGenerationOutcome,
  type ReviewerScopeAlignment,
  type ReviewerReevaluationOutcome,
  type ReviewerScopeReevaluation,
} from "./rationale-pr1-contract.js";
import {
  createInvocationStartedAudit,
  isRationaleOutcomeBinding,
  validateHostInvocationStartLease,
  validateInvocationAuditRecord,
  validateHostConsumedAllowOnceReceipt,
  validateRationaleTicketRecord,
  type HostConsumedAllowOnceReceipt,
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
  generationOutcome: RationaleGenerationOutcome;
  reevaluationOutcome: ReviewerReevaluationOutcome | null;
  initialVerdict: RiskVerdict;
  reevaluatedVerdict: RiskVerdict;
  effectiveVerdict: RiskVerdict;
  scopeAlignment: ReviewerScopeAlignment;
  scopeReasons: readonly string[];
  rationaleStatus: RationaleStatus;
  terminalReason: RationaleTerminalReason | null;
  suggestion: string | null;
  modalFallbackRequired: boolean;
  /**
   * Reviewer auto-approve provenance. `true` only on the fresh + aligned +
   * non-high reviewer terminal that skips the user modal; `false` for every
   * user-driven allow-once and every modal-fallback projection. Forensics use
   * this (with scopeAlignment/initialVerdict/reevaluatedVerdict, already
   * carried above) to distinguish reviewer-auto from user-allow.
   */
  autoApproved: boolean;
}

const PROJECTION_GENERATION_OUTCOMES: readonly RationaleGenerationOutcome[] = [
  "accepted-rationale",
  "generation-unavailable",
  "generation-error",
  "generation-timeout",
  "missing-rationale-call",
  "ordinary-tool-call-rejected",
  "multiple-calls-rejected",
  "malformed-rationale",
];
const PROJECTION_REEVALUATION_OUTCOMES: readonly ReviewerReevaluationOutcome[] = [
  "fresh",
  ...REVIEWER_REEVALUATION_FAILURE_OUTCOMES,
];
const PROJECTION_SCOPE_ALIGNMENTS: readonly ReviewerScopeAlignment[] = [
  "aligned",
  "unclear",
  "outside",
  "unknown",
];
const PROJECTION_TERMINAL_REASONS: readonly RationaleTerminalReason[] = [
  "allowed-once",
  "user-deny",
  "user-cancel",
  "modal-timeout",
  "caller-abort",
  "session-close",
  "identity-mismatch",
  "stale-replay",
  "expired",
];
const PROJECTION_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function sanitizeProjectionDisplayText(value: string, maxLength: number): string {
  // The renderer display contract rejects angle brackets outright. The
  // generic sanitizer removes balanced HTML-like tags, but a lone bracket
  // would otherwise survive projection validation and make the later
  // projection-to-display conversion throw after the ticket is user_pending.
  // normalizeRationaleApprovalDisplayText removes Cc/Cf directional and
  // formatting characters both before and after home-path redaction, so every
  // validated projection is convertible while forged rows remain fail-closed.
  const sanitized = sanitizeDisplayText(value, 4_096)
    .replace(/[<>]/gu, " ");
  return normalizeRationaleApprovalDisplayText(
    redactHomePathsInText(sanitized),
  ).slice(0, maxLength);
}

function isBoundedProjectionText(
  value: unknown,
  maxLength: number,
): value is string {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maxLength;
}

function isSanitizedProjectionText(
  value: unknown,
  maxLength: number,
): value is string {
  return isBoundedProjectionText(value, maxLength) &&
    sanitizeProjectionDisplayText(value, maxLength) === value;
}

function isBoundedProjectionList(
  value: unknown,
  maxItems: number,
  maxLength: number,
): value is readonly string[] {
  return Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= maxItems &&
    value.every((item) => isSanitizedProjectionText(item, maxLength));
}

function normalizedProjectionVerdict(value: unknown, label: string): RiskVerdict {
  const normalized = normalizeRationaleRiskVerdict(value as RiskVerdict, label);
  if (!equal(normalized, value)) {
    throw new TypeError(label + " is not canonical");
  }
  return normalized;
}

export function validateRationaleUiAuditProjection(
  value: unknown,
): value is RationaleUiAuditProjection {
  try {
    assertRationaleCanonicalJson(value, "RationaleUiAuditProjection");
    if (!isRecord(value)) return false;
    exact(value, [
      "contractVersion", "projection", "ticketId", "anchorId", "actionDigest",
      "round", "reasonCode", "toolName", "canonicalTargets", "requestedEffects",
      "affectedResources", "requiredAuthority", "reviewerOutcome",
      "generationOutcome", "reevaluationOutcome", "initialVerdict",
      "reevaluatedVerdict", "effectiveVerdict", "scopeAlignment", "scopeReasons",
      "rationaleStatus", "terminalReason", "suggestion", "modalFallbackRequired",
      "autoApproved",
    ], "RationaleUiAuditProjection");
    if (
      value.contractVersion !== RATIONALE_CONTROL_CONTRACT_VERSION ||
      value.projection !== "rationale-ui-audit" ||
      typeof value.ticketId !== "string" ||
      !PROJECTION_UUID_RE.test(value.ticketId) ||
      typeof value.anchorId !== "string" ||
      !PROJECTION_UUID_RE.test(value.anchorId) ||
      typeof value.actionDigest !== "string" ||
      !/^[0-9a-f]{64}$/u.test(value.actionDigest) ||
      value.round !== 1 ||
      value.reasonCode !== "foreground-reviewer-threshold" ||
      !isSanitizedProjectionText(value.toolName, 256) ||
      !isBoundedProjectionList(value.canonicalTargets, 32, 1_024) ||
      !isBoundedProjectionList(value.requestedEffects, 8, 160) ||
      !isBoundedProjectionList(value.affectedResources, 8, 160) ||
      !isSanitizedProjectionText(value.requiredAuthority, 160) ||
      (value.reviewerOutcome !== "fresh" && value.reviewerOutcome !== "cache") ||
      !PROJECTION_GENERATION_OUTCOMES.includes(
        value.generationOutcome as RationaleGenerationOutcome,
      ) ||
      (value.reevaluationOutcome !== null &&
        !PROJECTION_REEVALUATION_OUTCOMES.includes(
          value.reevaluationOutcome as ReviewerReevaluationOutcome,
        )) ||
      !PROJECTION_SCOPE_ALIGNMENTS.includes(
        value.scopeAlignment as ReviewerScopeAlignment,
      ) ||
      !isBoundedProjectionList(value.scopeReasons, 8, 160) ||
      (value.rationaleStatus !== "ready" && value.rationaleStatus !== "failed") ||
      (value.terminalReason !== null &&
        !PROJECTION_TERMINAL_REASONS.includes(
          value.terminalReason as RationaleTerminalReason,
        )) ||
      typeof value.modalFallbackRequired !== "boolean" ||
      typeof value.autoApproved !== "boolean"
    ) {
      return false;
    }

    const initial = normalizedProjectionVerdict(value.initialVerdict, "initialVerdict");
    const reevaluated = normalizedProjectionVerdict(
      value.reevaluatedVerdict,
      "reevaluatedVerdict",
    );
    const effective = normalizedProjectionVerdict(
      value.effectiveVerdict,
      "effectiveVerdict",
    );
    if (
      !isSanitizedProjectionText(initial.reason, 500) ||
      !isSanitizedProjectionText(reevaluated.reason, 500) ||
      !isSanitizedProjectionText(effective.reason, 500)
    ) {
      return false;
    }
    const rank: Record<RiskVerdict["level"], number> = {
      low: 0,
      medium: 1,
      high: 2,
    };
    const expectedEffective =
      rank[reevaluated.level] > rank[initial.level] ? reevaluated : initial;
    if (!equal(effective, expectedEffective)) return false;

    if (value.rationaleStatus === "ready") {
      const readyOk = value.generationOutcome === "accepted-rationale" &&
        value.reevaluationOutcome === "fresh" &&
        value.scopeAlignment !== "unknown" &&
        value.modalFallbackRequired === false &&
        isSanitizedProjectionText(value.suggestion, 500);
      if (!readyOk) return false;
      // autoApproved=true is a POSITIVE terminal: it requires the reviewer to
      // have judged the sealed action in-scope (aligned) and not intrinsically
      // dangerous (reevaluatedVerdict <= medium), and the ticket to have reached
      // the one-shot allowed_once terminal. Everything else is autoApproved=false.
      if (value.autoApproved) {
        return value.scopeAlignment === "aligned" &&
          value.terminalReason === "allowed-once" &&
          reevaluated.level !== "high";
      }
      return true;
    }

    const acceptedThenReviewerFailed =
      value.generationOutcome === "accepted-rationale" &&
      value.reevaluationOutcome !== null &&
      value.reevaluationOutcome !== "fresh";
    const generationFailed =
      value.generationOutcome !== "accepted-rationale" &&
      value.reevaluationOutcome === null;
    return (acceptedThenReviewerFailed || generationFailed) &&
      value.scopeAlignment === "unknown" &&
      value.modalFallbackRequired === true &&
      value.suggestion === null &&
      value.autoApproved === false &&
      equal(reevaluated, initial) &&
      equal(effective, initial);
  } catch {
    return false;
  }
}

function projectUiText(value: string, maxLength: number, label: string): string {
  const projected = sanitizeProjectionDisplayText(value, maxLength);
  if (!projected) throw new TypeError(label + " has no safe display text");
  return projected;
}

function projectUiList(
  values: readonly string[],
  maxLength: number,
  label: string,
): readonly string[] {
  const projected = values.map((value, index) =>
    projectUiText(value, maxLength, label + "[" + index + "]"));
  return seal(projected, label);
}

function projectUiVerdict(value: RiskVerdict, label: string): RiskVerdict {
  const normalized = normalizeRationaleRiskVerdict(value, label);
  return seal({
    level: normalized.level,
    reason: projectUiText(normalized.reason, 500, label + ".reason"),
  }, label);
}

export function createRationaleUiAuditProjection(input: {
  control: RationaleRequiredControl;
  response: RationaleResponse | null;
  reevaluation: ReviewerScopeReevaluation | null;
  ticket: RationaleTicketStateRecord;
  now?: number;
  /** Reviewer auto-approve provenance; defaults to false (user/modal path). */
  autoApproved?: boolean;
}): RationaleUiAuditProjection {
  const now = input.now ?? Date.now();
  if (!verifyRationaleRequiredControl(input.control, { now }) ||
      (input.reevaluation !== null &&
        !validateReviewerScopeReevaluation(input.reevaluation, input.control, now))) {
    throw new Error("invalid rationale UI/audit binding");
  }
  validateRationaleTicketRecord(input.ticket);
  const autoApproved = input.autoApproved ?? false;
  if (autoApproved && (
    input.ticket.rationaleStatus !== "ready" ||
    input.ticket.state !== "allowed_once" ||
    input.ticket.terminalReason !== "allowed-once" ||
    input.reevaluation === null ||
    input.reevaluation.outcome !== "fresh" ||
    input.reevaluation.scopeAlignment !== "aligned" ||
    input.reevaluation.reevaluatedVerdict.level === "high"
  )) {
    throw new Error(
      "auto-approved projection requires an aligned non-high reviewer allow-once terminal",
    );
  }
  const generationOutcome = input.ticket.generationOutcome;
  if (input.ticket.ticketId !== input.control.ticketId ||
      input.ticket.actionDigest !== input.control.action.actionDigest ||
      generationOutcome === null ||
      input.ticket.reevaluationOutcome !== (input.reevaluation?.outcome ?? null) ||
      !isRationaleOutcomeBinding(
        input.ticket.rationaleStatus, generationOutcome, input.ticket.reevaluationOutcome,
      )) {
    throw new Error("ticket/action projection mismatch");
  }

  let suggestion: string | null = null;
  let reevaluatedVerdict = seal(input.control.initialVerdict, "reevaluatedVerdict");
  let effectiveVerdict = seal(input.control.initialVerdict, "effectiveVerdict");
  let scopeAlignment: ReviewerScopeAlignment = "unknown";
  let scopeReasons: readonly string[] = ["rationale-generation-" + generationOutcome];
  let modalFallbackRequired = true;

  if (input.ticket.rationaleStatus === "ready") {
    if (input.reevaluation === null || input.reevaluation.outcome !== "fresh" ||
        input.reevaluation.modalFallbackRequired !== false) {
      throw new Error("ready rationale requires fresh reviewer reevaluation");
    }
    const parsed = parseRationaleResponse(input.response, input.control, now);
    if (!parsed || !equal(parsed, input.response)) {
      throw new Error("ready projection requires sealed rationale response");
    }
    suggestion = projectUiText(parsed.suggestion, 500, "suggestion");
    reevaluatedVerdict = input.reevaluation.reevaluatedVerdict;
    effectiveVerdict = input.reevaluation.effectiveVerdict;
    scopeAlignment = input.reevaluation.scopeAlignment;
    scopeReasons = input.reevaluation.scopeReasons;
    modalFallbackRequired = false;
  } else if (input.ticket.rationaleStatus === "failed") {
    if (input.response !== null) {
      throw new Error("failed rationale requires null response and modal fallback");
    }
    if (generationOutcome === "accepted-rationale") {
      if (input.reevaluation === null ||
          !REVIEWER_REEVALUATION_FAILURE_OUTCOMES.includes(
            input.reevaluation.outcome as never,
          ) || input.reevaluation.modalFallbackRequired !== true) {
        throw new Error("failed reevaluation requires reviewer failure and modal fallback");
      }
      reevaluatedVerdict = input.reevaluation.reevaluatedVerdict;
      effectiveVerdict = input.reevaluation.effectiveVerdict;
      scopeAlignment = input.reevaluation.scopeAlignment;
      scopeReasons = input.reevaluation.scopeReasons;
    } else if (input.reevaluation !== null) {
      throw new Error("generation failure must not contain reviewer reevaluation");
    }
  } else {
    throw new Error("UI/audit projection requires ready or failed rationale status");
  }
  const initialVerdict = projectUiVerdict(input.control.initialVerdict, "initialVerdict");
  reevaluatedVerdict = projectUiVerdict(reevaluatedVerdict, "reevaluatedVerdict");
  effectiveVerdict = projectUiVerdict(effectiveVerdict, "effectiveVerdict");
  return seal({ contractVersion: RATIONALE_CONTROL_CONTRACT_VERSION,
    projection: "rationale-ui-audit", ticketId: input.control.ticketId,
    anchorId: input.control.anchor.anchorId,
    actionDigest: input.control.action.actionDigest, round: 1,
    reasonCode: input.control.reasonCode,
    toolName: projectUiText(input.control.action.toolName, 256, "toolName"),
    canonicalTargets: projectUiList(
      input.control.action.canonicalTargets,
      1_024,
      "canonicalTargets",
    ),
    requestedEffects: projectUiList(
      input.control.action.requestedEffects,
      160,
      "requestedEffects",
    ),
    affectedResources: projectUiList(
      input.control.action.affectedResources,
      160,
      "affectedResources",
    ),
    requiredAuthority: projectUiText(
      input.control.action.requiredAuthority,
      160,
      "requiredAuthority",
    ),
    reviewerOutcome: input.control.reviewerOutcome, generationOutcome,
    reevaluationOutcome: input.reevaluation?.outcome ?? null,
    initialVerdict, reevaluatedVerdict, effectiveVerdict,
    scopeAlignment,
    scopeReasons: projectUiList(scopeReasons, 160, "scopeReasons"),
    rationaleStatus: input.ticket.rationaleStatus, terminalReason: input.ticket.terminalReason,
    suggestion, modalFallbackRequired, autoApproved,
  }, "RationaleUiAuditProjection");
}

/**
 * Derive the only rationale payload that may cross into the renderer.
 *
 * The full projection remains the host/audit record and deliberately keeps
 * replay-sensitive bindings such as ticket, anchor, and action digests. The
 * display contract contains only bounded explanatory facts, and is rebuilt
 * through its strict parser so an invalid projection never widens the modal
 * surface.
 */
export function createRationaleApprovalDisplayFromProjection(
  projection: RationaleUiAuditProjection,
): RationaleApprovalDisplay {
  if (!validateRationaleUiAuditProjection(projection)) {
    throw new TypeError("invalid rationale UI/audit projection");
  }
  // validateRationaleUiAuditProjection proves this dynamically, but the
  // audit projection's static status type is intentionally broader because
  // audit records also model pre-terminal lifecycle states. Keep the narrow
  // renderer contract explicit rather than relying on an unchecked cast.
  const rationaleStatus = projection.rationaleStatus;
  if (rationaleStatus !== "ready" && rationaleStatus !== "failed") {
    throw new TypeError("projection has no renderer-safe rationale status");
  }
  return createRationaleApprovalDisplay({
    toolName: projection.toolName,
    canonicalTargets: projection.canonicalTargets,
    requestedEffects: projection.requestedEffects,
    affectedResources: projection.affectedResources,
    requiredAuthority: projection.requiredAuthority,
    effectiveVerdict: {
      level: projection.effectiveVerdict.level,
      reason: projection.effectiveVerdict.reason,
    },
    scopeAlignment: projection.scopeAlignment,
    scopeReasons: projection.scopeReasons,
    rationaleStatus,
    suggestion: projection.suggestion,
    modalFallbackRequired: projection.modalFallbackRequired,
  });
}

export const RATIONALE_SECURITY_SUFFIX_VERSION = 3 as const;

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
  "final-permission-audit",
  "invocation-audit-terminal",
  "tool-end-emit",
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
  generationOutcome: RationaleGenerationOutcome;
  reevaluation: ReviewerScopeReevaluation | null;
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
  reevaluation: ReviewerScopeReevaluation | null;
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
  if (input.reevaluation !== null &&
      !validateReviewerScopeReevaluation(input.reevaluation, input.control, now)) {
    throw new Error("reviewer reevaluation binding mismatch");
  }
  validateRationaleTicketRecord(input.ticket);
  validateHostConsumedAllowOnceReceipt(
    input.hostConsumedAllowOnceReceipt, input.control, input.ticket, now,
  );
  const generationOutcome = input.ticket.generationOutcome;
  if (input.ticket.ticketId !== input.control.ticketId ||
      input.ticket.actionDigest !== input.control.action.actionDigest ||
      input.ticket.state !== "allowed_once" || input.ticket.terminalReason !== "allowed-once" ||
      input.ticket.rationaleStatus !== input.rationaleStatus ||
      generationOutcome === null ||
      input.ticket.reevaluationOutcome !== (input.reevaluation?.outcome ?? null) ||
      !isRationaleOutcomeBinding(
        input.rationaleStatus, generationOutcome, input.ticket.reevaluationOutcome,
      )) {
    throw new Error("allow-once ticket binding mismatch");
  }
  let response: RationaleResponse | null;
  if (input.rationaleStatus === "ready") {
    if (generationOutcome !== "accepted-rationale" ||
        input.reevaluation === null || input.reevaluation.outcome !== "fresh" ||
        input.reevaluation.modalFallbackRequired !== false) {
      throw new Error("ready rationale requires fresh reviewer reevaluation");
    }
    response = parseRationaleResponse(input.response, input.control, now);
    if (!response) throw new Error("invalid rationale response");
  } else {
    if (input.response !== null) {
      throw new Error("failed rationale requires null response");
    }
    if (generationOutcome === "accepted-rationale") {
      if (input.reevaluation === null ||
          !REVIEWER_REEVALUATION_FAILURE_OUTCOMES.includes(
            input.reevaluation.outcome as never,
          ) || input.reevaluation.modalFallbackRequired !== true) {
        throw new Error("failed reevaluation requires reviewer failure");
      }
    } else if (input.reevaluation !== null) {
      throw new Error("generation failure must not contain reviewer reevaluation");
    }
    response = null;
  }
  return seal({ contractVersion: RATIONALE_CONTROL_CONTRACT_VERSION,
    kind: "sealed-rationale-resume", ticketId: input.control.ticketId,
    actionDigest: input.control.action.actionDigest,
    invocationDigest: input.control.invocationDigest,
    authorizationReceiptId: input.hostConsumedAllowOnceReceipt.receiptId,
    control: seal(input.control, "control"), response,
    rationaleStatus: input.rationaleStatus, generationOutcome,
    reevaluation: input.reevaluation,
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
      "generationOutcome", "reevaluation", "ticket", "currentActionIdentity",
      "currentEligibilityContext", "securitySuffixVersion", "securitySuffix",
      "executionEntryPoint", "directToolExecute"], "SealedRationaleResumeRequest");
    const control = request.control as RationaleRequiredControl;
    if (!verifyRationaleRequiredControl(control, { now, currentEligibilityContext })) return false;
    const ticket = request.ticket as RationaleTicketStateRecord;
    validateRationaleTicketRecord(ticket);
    validateHostConsumedAllowOnceReceipt(
      hostConsumedAllowOnceReceipt, control, ticket, now,
    );
    const generationOutcome = request.generationOutcome as RationaleGenerationOutcome;
    const reevaluation = request.reevaluation === null
      ? null : request.reevaluation as ReviewerScopeReevaluation;
    const reevaluationOutcome = reevaluation?.outcome ?? null;
    if (request.contractVersion !== RATIONALE_CONTROL_CONTRACT_VERSION ||
      request.kind !== "sealed-rationale-resume" || request.ticketId !== control.ticketId ||
      request.actionDigest !== control.action.actionDigest ||
      request.invocationDigest !== control.invocationDigest ||
      request.authorizationReceiptId !== hostConsumedAllowOnceReceipt.receiptId ||
      ticket.ticketId !== control.ticketId || ticket.actionDigest !== control.action.actionDigest ||
      ticket.state !== "allowed_once" || ticket.terminalReason !== "allowed-once" ||
      ticket.rationaleStatus !== request.rationaleStatus ||
      ticket.generationOutcome !== generationOutcome ||
      ticket.reevaluationOutcome !== reevaluationOutcome ||
      !isRationaleOutcomeBinding(
        request.rationaleStatus as RationaleStatus,
        generationOutcome, reevaluationOutcome,
      ) ||
      request.executionEntryPoint !== "tool-executor-security-suffix" ||
      request.securitySuffixVersion !== RATIONALE_SECURITY_SUFFIX_VERSION ||
      request.directToolExecute !== "forbidden" ||
      !verifyActionIdentity(currentActionIdentity) || !equal(currentActionIdentity, control.action) ||
      !equal(request.currentActionIdentity, currentActionIdentity) ||
      !equal(request.currentEligibilityContext, currentEligibilityContext) ||
      !equal(request.securitySuffix, RATIONALE_SECURITY_SUFFIX) ||
      (reevaluation !== null &&
        !validateReviewerScopeReevaluation(reevaluation, control, now))) return false;
    if (request.rationaleStatus === "failed") {
      if (request.response !== null) return false;
      return generationOutcome === "accepted-rationale"
        ? reevaluation !== null && reevaluation.modalFallbackRequired === true &&
            REVIEWER_REEVALUATION_FAILURE_OUTCOMES.includes(reevaluation.outcome as never)
        : reevaluation === null;
    }
    if (request.rationaleStatus !== "ready" ||
        generationOutcome !== "accepted-rationale" ||
        reevaluation === null || reevaluation.outcome !== "fresh" ||
        reevaluation.modalFallbackRequired !== false) return false;
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
  startedInvocationAudit: InvocationAuditRecord;
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
  validateInvocationAuditRecord(input.startedInvocationAudit);
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
  const expectedStartedInvocationAudit = createInvocationStartedAudit({
    authorized: input.authorizedInvocationAudit,
    startLease: input.hostInvocationStartLease,
    now,
  });
  if (!equal(expectedStartedInvocationAudit, input.startedInvocationAudit)) {
    throw new Error("started invocation audit does not match committed start");
  }
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
    startedInvocationAudit: input.startedInvocationAudit,
    executionAuthority: "single-host-cas-start-lease",
    directToolExecute: "forbidden",
  }, "RationaleExecutionAuthorityEntry");
}
