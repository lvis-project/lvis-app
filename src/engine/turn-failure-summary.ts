/**
 * Share-safe summary of one failed conversation turn.
 *
 * A turn failure crosses trust boundaries with very different clearances: the
 * owner renderer may see the raw provider message, but a remote/shared surface
 * (chat-platform bridges) must only ever see this closed summary. Both the
 * category union and every summary sentence are fixed tables, so a stack
 * trace, raw provider payload, secret, or filesystem path can never flow
 * through this type regardless of what the underlying error contained.
 *
 * This module is the single source of truth for that summary: derivation
 * happens once where the turn error is published, and every boundary that
 * re-admits a summary revalidates it through {@link toSafeTurnFailureSummary}.
 */

/** Closed set of user-displayable failure categories. */
export const TURN_FAILURE_CATEGORIES = Object.freeze([
  "provider",
  "auth",
  "rate-limit",
  "context",
  "network",
  "model",
  "internal",
] as const);

export type TurnFailureCategory = (typeof TURN_FAILURE_CATEGORIES)[number];

/** Share-safe failure detail carried alongside a failed-turn event. */
export interface TurnFailureSummary {
  readonly category: TurnFailureCategory;
  /** Short, user-displayable English sentence; never raw error text. */
  readonly summary: string;
}

/** Defensive bound applied wherever a summary is re-admitted. */
export const MAX_TURN_FAILURE_SUMMARY_CHARS = 200;

/**
 * The only sentences a shared surface can ever receive for a failed turn.
 * Fixed table on purpose: the raw error message is classified, never copied.
 */
const TURN_FAILURE_SUMMARY_TEXT: Readonly<Record<TurnFailureCategory, string>> = Object.freeze({
  provider: "The model provider returned an error.",
  auth: "The model API key was rejected. Check the key in settings.",
  "rate-limit": "The model rate limit was hit. Retry shortly.",
  context: "The conversation exceeded the model context limit.",
  network: "The model request failed over the network.",
  model: "The configured model was not found.",
  internal: "An internal error stopped the turn.",
});

/**
 * Provider error-classifier category → share-safe failure category. Keys are
 * the closed `ErrorCategory` values from `llm/error-classifier.ts`; an
 * unrecognized value deliberately falls through to the notice-based default.
 */
const CLASSIFIER_CATEGORY_TO_FAILURE: Readonly<Record<string, TurnFailureCategory>> = Object.freeze({
  "api-key": "auth",
  "rate-limit": "rate-limit",
  "context-length": "context",
  model: "model",
  network: "network",
  unknown: "provider",
});

/** Turn-engine system notice → failure category when no classification exists. */
const SYSTEM_NOTICE_TO_FAILURE: Readonly<
  Record<NonNullable<DeriveTurnFailureSummaryInput["systemNotice"]>, TurnFailureCategory>
> = Object.freeze({
  "context-error": "context",
  "stream-error": "provider",
});

export interface DeriveTurnFailureSummaryInput {
  /** The turn engine's system notice attached to the error callback. */
  readonly systemNotice?: "context-error" | "stream-error";
  /**
   * The provider error classification computed where the raw error object
   * exists (`classifyProviderError` in the stream collector). Passed as an
   * opaque string and validated against the closed map here so a drifting or
   * forged value can never widen the output union.
   */
  readonly classifierCategory?: string;
}

/**
 * Derive the one share-safe failure summary for a failed turn. Pure table
 * lookup over closed unions: no field of the input error message is copied.
 */
export function deriveTurnFailureSummary(
  input: DeriveTurnFailureSummaryInput,
): TurnFailureSummary {
  const category = resolveTurnFailureCategory(input);
  return { category, summary: TURN_FAILURE_SUMMARY_TEXT[category] };
}

function resolveTurnFailureCategory(
  input: DeriveTurnFailureSummaryInput,
): TurnFailureCategory {
  const classified = input.classifierCategory !== undefined
    && Object.hasOwn(CLASSIFIER_CATEGORY_TO_FAILURE, input.classifierCategory)
    ? CLASSIFIER_CATEGORY_TO_FAILURE[input.classifierCategory]
    : undefined;
  const noticed = input.systemNotice !== undefined
    ? SYSTEM_NOTICE_TO_FAILURE[input.systemNotice]
    : undefined;
  return classified ?? noticed ?? "internal";
}

/**
 * Fail-closed re-admission of a summary that crossed a serialization or
 * projection boundary. Only the two whitelisted fields flow onward; an unknown
 * category drops the whole summary, and the sentence is control-stripped and
 * truncated defensively even though the producer only emits table text.
 */
export function toSafeTurnFailureSummary(value: unknown): TurnFailureSummary | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as { readonly category?: unknown; readonly summary?: unknown };
  const category = candidate.category;
  if (
    typeof category !== "string"
    || !(TURN_FAILURE_CATEGORIES as readonly string[]).includes(category)
  ) {
    return undefined;
  }
  if (typeof candidate.summary !== "string") return undefined;
  const summary = boundedSummaryText(candidate.summary);
  if (summary.length === 0) return undefined;
  return { category: category as TurnFailureCategory, summary };
}

/**
 * Strip control characters and keep at most
 * {@link MAX_TURN_FAILURE_SUMMARY_CHARS} UTF-16 units, never splitting a
 * surrogate pair.
 */
function boundedSummaryText(value: string): string {
  let output = "";
  for (let index = 0; index < value.length && output.length < MAX_TURN_FAILURE_SUMMARY_CHARS;) {
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) break;
    const width = codePoint > 0xffff ? 2 : 1;
    const isControl = (codePoint >= 0 && codePoint <= 0x1f) || codePoint === 0x7f;
    const isLoneSurrogate = codePoint >= 0xd800 && codePoint <= 0xdfff;
    if (!isControl && !isLoneSurrogate) {
      if (output.length + width > MAX_TURN_FAILURE_SUMMARY_CHARS) break;
      output += value.slice(index, index + width);
    }
    index += width;
  }
  return output.trim();
}
