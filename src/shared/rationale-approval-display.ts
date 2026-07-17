/**
 * Narrow, renderer-safe view of a host-audited foreground rationale.
 *
 * This object is explanatory data only. It contains no ticket, nonce, action
 * digest, or executable input and can never grant permission by itself. The
 * main process HMAC-binds this exact display object to the one-shot approval
 * request before it crosses the renderer boundary.
 */
export const RATIONALE_APPROVAL_DISPLAY_VERSION = 1 as const;
export const RATIONALE_APPROVAL_DISPLAY_KIND =
  "rationale-approval-display" as const;

export type RationaleApprovalDisplayStatus = "ready" | "failed";
export type RationaleApprovalDisplayRiskLevel = "low" | "medium" | "high";
export type RationaleApprovalDisplayScopeAlignment =
  | "aligned"
  | "unclear"
  | "outside"
  | "unknown";

export interface RationaleApprovalDisplay {
  readonly contractVersion: typeof RATIONALE_APPROVAL_DISPLAY_VERSION;
  readonly display: typeof RATIONALE_APPROVAL_DISPLAY_KIND;
  readonly toolName: string;
  readonly canonicalTargets: readonly string[];
  readonly requestedEffects: readonly string[];
  readonly affectedResources: readonly string[];
  readonly requiredAuthority: string;
  readonly effectiveVerdict: Readonly<{
    level: RationaleApprovalDisplayRiskLevel;
    reason: string;
  }>;
  readonly scopeAlignment: RationaleApprovalDisplayScopeAlignment;
  readonly scopeReasons: readonly string[];
  readonly rationaleStatus: RationaleApprovalDisplayStatus;
  readonly suggestion: string | null;
  readonly modalFallbackRequired: boolean;
}

export interface RationaleApprovalDisplayInput {
  readonly toolName: string;
  readonly canonicalTargets: readonly string[];
  readonly requestedEffects: readonly string[];
  readonly affectedResources: readonly string[];
  readonly requiredAuthority: string;
  readonly effectiveVerdict: Readonly<{
    level: RationaleApprovalDisplayRiskLevel;
    reason: string;
  }>;
  readonly scopeAlignment: RationaleApprovalDisplayScopeAlignment;
  readonly scopeReasons: readonly string[];
  readonly rationaleStatus: RationaleApprovalDisplayStatus;
  readonly suggestion: string | null;
  readonly modalFallbackRequired: boolean;
}

const RISK_LEVELS = new Set<RationaleApprovalDisplayRiskLevel>([
  "low",
  "medium",
  "high",
]);
const SCOPE_ALIGNMENTS = new Set<RationaleApprovalDisplayScopeAlignment>([
  "aligned",
  "unclear",
  "outside",
  "unknown",
]);

/**
 * Unicode Cc covers the C0/C1 control ranges; Cf covers invisible format
 * characters, including directional overrides and isolates. Neither belongs
 * in a sealed approval fact because it can visually reorder or hide the
 * surrounding consent context. Zl/Zp are rejected too: a renderer card is a
 * bounded single-line fact/list surface, not a second layout channel.
 */
const UNSAFE_RATIONALE_APPROVAL_DISPLAY_UNICODE =
  /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const HAS_UNSAFE_RATIONALE_APPROVAL_DISPLAY_UNICODE =
  /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/**
 * Normalize host-projected explanation text before it is sealed for display.
 *
 * This deliberately preserves ordinary Unicode (including Korean) while
 * replacing controls and invisible format characters with ordinary spacing.
 * The parser below rejects those characters if they arrive in a forged or
 * otherwise unnormalized renderer payload instead of silently widening it.
 */
export function normalizeRationaleApprovalDisplayText(value: string): string {
  return value
    .normalize("NFC")
    .replace(UNSAFE_RATIONALE_APPROVAL_DISPLAY_UNICODE, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function hasUnsafeRationaleApprovalDisplayUnicode(value: string): boolean {
  return HAS_UNSAFE_RATIONALE_APPROVAL_DISPLAY_UNICODE.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

function isDisplayText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maxLength &&
    !/[<>]/u.test(value) &&
    !hasUnsafeRationaleApprovalDisplayUnicode(value)
  );
}

function isDisplayList(
  value: unknown,
  maxItems: number,
  maxLength: number,
): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= maxItems &&
    value.every((item) => isDisplayText(item, maxLength))
  );
}

/**
 * Strict parser shared by the main process and renderer. Invalid display data
 * must never be treated as an approval-capable rationale card.
 */
export function parseRationaleApprovalDisplay(
  value: unknown,
): RationaleApprovalDisplay | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "contractVersion",
      "display",
      "toolName",
      "canonicalTargets",
      "requestedEffects",
      "affectedResources",
      "requiredAuthority",
      "effectiveVerdict",
      "scopeAlignment",
      "scopeReasons",
      "rationaleStatus",
      "suggestion",
      "modalFallbackRequired",
    ])
  ) {
    return null;
  }

  const verdict = value.effectiveVerdict;
  if (
    value.contractVersion !== RATIONALE_APPROVAL_DISPLAY_VERSION ||
    value.display !== RATIONALE_APPROVAL_DISPLAY_KIND ||
    !isDisplayText(value.toolName, 256) ||
    !isDisplayList(value.canonicalTargets, 32, 1_024) ||
    !isDisplayList(value.requestedEffects, 8, 160) ||
    !isDisplayList(value.affectedResources, 8, 160) ||
    !isDisplayText(value.requiredAuthority, 160) ||
    !isRecord(verdict) ||
    !hasExactKeys(verdict, ["level", "reason"]) ||
    !RISK_LEVELS.has(verdict.level as RationaleApprovalDisplayRiskLevel) ||
    !isDisplayText(verdict.reason, 500) ||
    !SCOPE_ALIGNMENTS.has(
      value.scopeAlignment as RationaleApprovalDisplayScopeAlignment,
    ) ||
    !isDisplayList(value.scopeReasons, 8, 160) ||
    (value.rationaleStatus !== "ready" && value.rationaleStatus !== "failed") ||
    typeof value.modalFallbackRequired !== "boolean"
  ) {
    return null;
  }

  if (value.rationaleStatus === "ready") {
    if (
      value.modalFallbackRequired !== false ||
      value.scopeAlignment === "unknown" ||
      !isDisplayText(value.suggestion, 500)
    ) {
      return null;
    }
  } else if (
    value.modalFallbackRequired !== true ||
    value.scopeAlignment !== "unknown" ||
    value.suggestion !== null
  ) {
    return null;
  }

  return Object.freeze({
    contractVersion: RATIONALE_APPROVAL_DISPLAY_VERSION,
    display: RATIONALE_APPROVAL_DISPLAY_KIND,
    toolName: value.toolName,
    canonicalTargets: Object.freeze([...value.canonicalTargets]),
    requestedEffects: Object.freeze([...value.requestedEffects]),
    affectedResources: Object.freeze([...value.affectedResources]),
    requiredAuthority: value.requiredAuthority,
    effectiveVerdict: Object.freeze({
      level: verdict.level as RationaleApprovalDisplayRiskLevel,
      reason: verdict.reason as string,
    }),
    scopeAlignment:
      value.scopeAlignment as RationaleApprovalDisplayScopeAlignment,
    scopeReasons: Object.freeze([...value.scopeReasons]),
    rationaleStatus: value.rationaleStatus as RationaleApprovalDisplayStatus,
    suggestion: value.suggestion as string | null,
    modalFallbackRequired: value.modalFallbackRequired,
  });
}

/** Host-only construction helper. Throws rather than widening malformed data. */
export function createRationaleApprovalDisplay(
  input: Readonly<RationaleApprovalDisplayInput>,
): RationaleApprovalDisplay {
  const parsed = parseRationaleApprovalDisplay({
    contractVersion: RATIONALE_APPROVAL_DISPLAY_VERSION,
    display: RATIONALE_APPROVAL_DISPLAY_KIND,
    ...input,
  });
  if (parsed === null) {
    throw new TypeError("invalid rationale approval display");
  }
  return parsed;
}
