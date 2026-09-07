/**
 * Usable context budget — LVIS model-tier fixed reservations.
 *
 * Browser-safe (no Node imports) so both the renderer hook
 * (`use-context-budget`) and engine paths can derive the same usable
 * denominator.
 *
 * Why fixed buffers not a percentage:
 *   Small models (64K) need proportionally more reservation for output.
 *   With 32K typical max output, 0.85× of 64K (= 54K) leaves only 10K
 *   headroom — single tool-result rounds blow past it. LVIS reserves fixed
 *   output/safety buffers (27K / 30K / 40K) to prevent this asymmetric pinch.
 */
import {
  effectiveContextWindow,
  FALLBACK_PRICING,
  lookupPricingOptional,
} from "./pricing-data.js";

/**
 * Reserve buffer for output + safety, return the *usable* portion of the
 * context window. Caller divides used-tokens by this to get the displayed
 * percentage.
 *
 * - 64,000     → 37,000 (reserved 27K — small models, output-heavy reasoning)
 * - 128,000    → 98,000 (reserved 30K)
 * - 200,000    → 160,000 (reserved 40K — Anthropic default tier)
 * - any other  → max(ctx − 40,000, 0.8 × ctx)
 *               picks the larger of "−40K floor" and "20% reservation",
 *               so 1M ⇒ 960K usable, 32K ⇒ ~25.6K, ≤40K ⇒ 80% (avoids
 *               negative usable on tiny windows).
 */
export function getUsableContext(contextWindow: number): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return 0;
  if (contextWindow === 64_000) return contextWindow - 27_000;
  if (contextWindow === 128_000) return contextWindow - 30_000;
  if (contextWindow === 200_000) return contextWindow - 40_000;
  return Math.max(contextWindow - 40_000, Math.floor(contextWindow * 0.8));
}




export function getPreflightThreshold(contextWindow: number): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return 0;
  const usable = getUsableContext(contextWindow);
  return Math.floor(usable * 0.8);
}

/**
 * Which input the resolved context window came from, in priority order.
 *
 * `fallback` means nothing knew the model's real capacity and the conservative
 * {@link FALLBACK_PRICING} window is in use. That is the case worth reporting:
 * a served model whose true window is larger gets compacted far earlier than it
 * needs to be, and one whose true window is smaller is never compacted early
 * enough.
 */
export type ContextWindowSource =
  | "vendor-setting"
  | "provider-reported"
  | "pricing-catalog"
  | "fallback";

export interface ResolvedContextWindow {
  readonly contextWindow: number;
  readonly source: ContextWindowSource;
}

/** A token count only counts as an answer when it is a usable positive integer. */
function positiveTokenCount(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return undefined;
  return value;
}

/**
 * The context window to budget a model against, and where that number came
 * from. The single place the four possible answers are ordered.
 *
 * 1. `configured` — an explicit `llm.vendors.<vendor>.contextWindow`. The user
 *    declared the capacity of the endpoint they own; nothing outranks that.
 * 2. `reported` — what the provider itself said about this model in its
 *    `/v1/models` handshake. An external value, so the caller parses it
 *    defensively and passes `undefined` when the field was absent or malformed.
 * 3. The pricing catalog's entry for the model.
 * 4. The conservative fallback window.
 */
export function resolveModelContextWindow(params: {
  vendor: string;
  model: string;
  configured?: number;
  reported?: number;
}): ResolvedContextWindow {
  const configured = positiveTokenCount(params.configured);
  if (configured !== undefined) {
    return { contextWindow: configured, source: "vendor-setting" };
  }
  const reported = positiveTokenCount(params.reported);
  if (reported !== undefined) {
    return { contextWindow: reported, source: "provider-reported" };
  }
  const catalog = lookupPricingOptional(params.vendor, params.model);
  if (catalog) {
    return { contextWindow: effectiveContextWindow(catalog), source: "pricing-catalog" };
  }
  return { contextWindow: FALLBACK_PRICING.contextWindow, source: "fallback" };
}
