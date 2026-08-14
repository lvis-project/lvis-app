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

/**
 * Field caps shared by the parser and the emission-side sealer. One definition:
 * a cap the sealer trims to but the parser rejects at (or vice versa) would be
 * exactly the silent divergence that produced unrenderable sealed displays.
 */
export const RATIONALE_DISPLAY_CAPS = Object.freeze({
  toolName: 256,
  targetItems: 32,
  targetLength: 1_024,
  listItems: 8,
  listLength: 160,
  authorityLength: 160,
  reasonLength: 500,
  suggestionLength: 500,
});

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
    !isDisplayText(value.toolName, RATIONALE_DISPLAY_CAPS.toolName) ||
    !isDisplayList(value.canonicalTargets, RATIONALE_DISPLAY_CAPS.targetItems, RATIONALE_DISPLAY_CAPS.targetLength) ||
    !isDisplayList(value.requestedEffects, RATIONALE_DISPLAY_CAPS.listItems, RATIONALE_DISPLAY_CAPS.listLength) ||
    !isDisplayList(value.affectedResources, RATIONALE_DISPLAY_CAPS.listItems, RATIONALE_DISPLAY_CAPS.listLength) ||
    !isDisplayText(value.requiredAuthority, RATIONALE_DISPLAY_CAPS.authorityLength) ||
    !isRecord(verdict) ||
    !hasExactKeys(verdict, ["level", "reason"]) ||
    !RISK_LEVELS.has(verdict.level as RationaleApprovalDisplayRiskLevel) ||
    !isDisplayText(verdict.reason, RATIONALE_DISPLAY_CAPS.reasonLength) ||
    !SCOPE_ALIGNMENTS.has(
      value.scopeAlignment as RationaleApprovalDisplayScopeAlignment,
    ) ||
    !isDisplayList(value.scopeReasons, RATIONALE_DISPLAY_CAPS.listItems, RATIONALE_DISPLAY_CAPS.listLength) ||
    (value.rationaleStatus !== "ready" && value.rationaleStatus !== "failed") ||
    typeof value.modalFallbackRequired !== "boolean"
  ) {
    return null;
  }

  if (value.rationaleStatus === "ready") {
    if (
      value.modalFallbackRequired !== false ||
      value.scopeAlignment === "unknown" ||
      !isDisplayText(value.suggestion, RATIONALE_DISPLAY_CAPS.suggestionLength)
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

/** Substitute for a field the DLP mask rendered invalid; always parses. */
const REDACTED_DISPLAY_TEXT = "[redacted]";

function sealText(
  value: string,
  maxLength: number,
  maskText: (value: string) => string,
): string {
  // Normalize BEFORE masking so the DLP detectors see canonical text, then
  // never re-normalize after — the mask token is plain ASCII and a second
  // pass could only disturb what the detectors already approved.
  const masked = maskText(normalizeRationaleApprovalDisplayText(value));
  // Plain boolean, not the type-guard: `isDisplayText` narrows its argument to
  // string, so on a value that is ALREADY a string the false branch narrows to
  // `never` and the length check below stops compiling.
  const fits = (candidate: string): boolean => isDisplayText(candidate, maxLength);
  if (fits(masked)) return masked;
  // Visible truncation repairs LENGTH violations only. Any other invalidity
  // (emptied, unsafe characters) is total loss, and dressing total loss as a
  // truncation — "…" — would claim a prefix survived when nothing did.
  if (masked.length > maxLength) {
    const truncated = truncateVisibly(masked, maxLength);
    if (fits(truncated)) return truncated;
  }
  return REDACTED_DISPLAY_TEXT;
}

/**
 * Cap an over-long masked string WITHOUT hiding that it was cut.
 *
 * A silent tail cut is a distortion, not a repair: a truncated path or URL
 * reads as a COMPLETE, different value, and the user approves that other
 * value (review MAJOR-1). The ellipsis makes every cut visible. The character
 * before it is checked for a lone high surrogate so a code point is never
 * split in half (review NIT-2) — a lone surrogate would render as U+FFFD and
 * read as corruption rather than truncation.
 */
function truncateVisibly(value: string, maxLength: number): string {
  let head = value.slice(0, Math.max(0, maxLength - 1));
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
  return head.trimEnd() + "…";
}

function sealList(
  values: readonly string[],
  maxItems: number,
  maxLength: number,
  maskText: (value: string) => string,
): readonly string[] {
  // Input lists are parse-guaranteed (constructor throws past the cap), so
  // this slice drops nothing today. It exists for the day that guarantee
  // weakens — and if that day comes, silent item-dropping is the same failure
  // shape as silent truncation and must gain a visible marker too.
  const sealed = values
    .slice(0, maxItems)
    .map((value) => sealText(value, maxLength, maskText));
  return sealed.length >= 1 ? sealed : [REDACTED_DISPLAY_TEXT];
}

/**
 * DLP-mask a display WITHOUT ever producing one the renderer cannot parse.
 *
 * The display entering emission is parse-guaranteed (built by
 * `createRationaleApprovalDisplay`, which throws otherwise) — masking was the
 * one mutation applied after that guarantee, and the mask token
 * ("[REDACTED:TOKEN]", 16 chars) can push a near-cap field over its length
 * limit, at which point the renderer's parse returned null and the approval
 * card rendered with no tool identity at all.
 *
 * Masking is therefore applied per FIELD and re-validated with the same
 * validators the parser uses; a field the mask rendered invalid degrades to
 * `REDACTED_DISPLAY_TEXT` rather than degrading the whole card. Enum, boolean
 * and status fields are never free text, never masked, and pass through
 * verbatim — host-determined facts stay exactly as the host wrote them. The
 * closing `createRationaleApprovalDisplay` makes totality a construction
 * guarantee: if this function can return, its result parses.
 */
export function sealMaskedRationaleApprovalDisplay(
  display: RationaleApprovalDisplay,
  maskText: (value: string) => string,
): RationaleApprovalDisplay {
  const caps = RATIONALE_DISPLAY_CAPS;
  return createRationaleApprovalDisplay({
    toolName: sealText(display.toolName, caps.toolName, maskText),
    canonicalTargets: sealList(display.canonicalTargets, caps.targetItems, caps.targetLength, maskText),
    requestedEffects: sealList(display.requestedEffects, caps.listItems, caps.listLength, maskText),
    affectedResources: sealList(display.affectedResources, caps.listItems, caps.listLength, maskText),
    requiredAuthority: sealText(display.requiredAuthority, caps.authorityLength, maskText),
    effectiveVerdict: {
      level: display.effectiveVerdict.level,
      reason: sealText(display.effectiveVerdict.reason, caps.reasonLength, maskText),
    },
    scopeAlignment: display.scopeAlignment,
    scopeReasons: sealList(display.scopeReasons, caps.listItems, caps.listLength, maskText),
    rationaleStatus: display.rationaleStatus,
    // The ready/failed invariants (suggestion text XOR null) are preserved
    // from the input display, which already satisfies them.
    suggestion: display.rationaleStatus === "ready"
      ? sealText(display.suggestion ?? "", caps.suggestionLength, maskText)
      : null,
    modalFallbackRequired: display.modalFallbackRequired,
  });
}
