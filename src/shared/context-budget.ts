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
import {
  activeLlmRouteModel,
  getLlmVendorSettings,
  type LLMVendor,
  type LLMVendorSettingsMap,
} from "./llm-vendor-defaults.js";
import { cachedModelListEntry, type LlmModelListCache } from "./llm-model-list.js";
import type { MarketplaceProviderModelDiscoveryPolicy } from "./marketplace-package-assets.js";

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

/**
 * The largest window a declared or reported value is believed at.
 *
 * Above this the number is far likelier to be a typo or a malformed field than
 * a real deployment: an extra digit on 229,376 reads as 2,293,760, whose
 * preflight threshold no conversation ever reaches, so compaction never runs
 * again and the turn dies on a provider context error instead. The largest
 * window the pricing catalog carries today is 2M, so this admits every real
 * model while refusing an order of magnitude past it.
 */
export const MAX_CREDIBLE_CONTEXT_WINDOW = 4_000_000;

/**
 * A token count only counts as an answer when it is a usable positive integer
 * within {@link MAX_CREDIBLE_CONTEXT_WINDOW}. Anything else is treated as
 * absent, so the next source answers instead.
 */
function positiveTokenCount(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return undefined;
  if (value > MAX_CREDIBLE_CONTEXT_WINDOW) return undefined;
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

/** The settings a route's context window is read out of. */
export interface LlmRouteSettings {
  readonly provider: LLMVendor;
  readonly vendors: LLMVendorSettingsMap;
  readonly marketplaceProviderPresetId?: string;
  readonly modelListCache?: LlmModelListCache;
}

/** A marketplace preset, as far as finding its catalogue row needs to know. */
export interface LlmRouteProviderPreset {
  readonly providerId: string;
  readonly baseUrl: string;
  /**
   * Whether the preset discovers its models or declares them. A caller that
   * refreshes the catalogue has to honour this: a preset declaring a static or
   * manual list is saying its endpoint must not be probed.
   */
  readonly modelDiscoveryPolicy?: MarketplaceProviderModelDiscoveryPolicy;
}

export interface RouteContextWindow extends ResolvedContextWindow {
  /** The model this route runs on — `activeLlmRouteModel`'s answer. */
  readonly model: string;
  /**
   * The provider's own ceiling on a completion for this model, when it
   * reported one. Carried beside the window for a caller that needs an output
   * ceiling; the budget math does not use it.
   */
  readonly maxOutputTokens?: number;
}

/**
 * The window the ACTIVE route should be budgeted against, read straight from
 * the settings both the engine and the renderer already hold.
 *
 * This exists so there is one answer to "how big is this model's context". The
 * engine budgets compaction against it and the renderer's context-fill ring
 * divides by it; resolving it separately on each side is how the ring came to
 * show a 128K denominator for a model the gateway had reported at 229,376.
 *
 * The declared window comes off the vendor block. The reported one comes off
 * the catalogue row that route's last `/models` handshake left in the cache —
 * keyed by the address the row actually synced, which for a marketplace preset
 * is the preset's own endpoint rather than the generic custom-provider block's.
 */
/**
 * Where a route's `/models` answer lives in the cache: the vendor, the address
 * that row actually synced against, and the preset scope it synced under.
 *
 * Exported because a caller that wants to REFRESH that row has to name the
 * same coordinates the reader looks it up by — key it differently and the
 * refreshed answer is never found, so the probe repeats forever.
 */
export interface LlmRouteCatalogAddress {
  readonly vendor: LLMVendor;
  readonly baseUrl?: string;
  readonly credentialScope?: string;
}

export function llmRouteCatalogAddress(
  llm: LlmRouteSettings,
  installedProviderPresets?: readonly LlmRouteProviderPreset[],
): LlmRouteCatalogAddress {
  const block = getLlmVendorSettings(llm.vendors, llm.provider);
  const presetId = llm.provider === "openai-compatible"
    ? llm.marketplaceProviderPresetId?.trim()
    : undefined;
  // A preset is a provider in its own right reached through the
  // openai-compatible vendor: its catalogue synced against its own endpoint,
  // not the generic custom-provider block's.
  const preset = presetId
    ? installedProviderPresets?.find((installed) => installed.providerId === presetId)
    : undefined;
  return {
    vendor: llm.provider,
    ...(preset?.baseUrl ?? block.baseUrl ? { baseUrl: preset?.baseUrl ?? block.baseUrl } : {}),
    ...(presetId ? { credentialScope: presetId } : {}),
  };
}

export function resolveContextWindowForRoute(
  llm: LlmRouteSettings,
  installedProviderPresets?: readonly LlmRouteProviderPreset[],
): RouteContextWindow {
  const model = activeLlmRouteModel(llm);
  const block = getLlmVendorSettings(llm.vendors, llm.provider);
  const address = llmRouteCatalogAddress(llm, installedProviderPresets);
  const entry = cachedModelListEntry(llm.modelListCache, { ...address, model });
  const resolved = resolveModelContextWindow({
    vendor: llm.provider,
    model,
    ...(block.contextWindow !== undefined ? { configured: block.contextWindow } : {}),
    ...(entry?.contextLength !== undefined ? { reported: entry.contextLength } : {}),
  });
  const maxOutputTokens = positiveTokenCount(entry?.maxOutputTokens);
  return {
    ...resolved,
    model,
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
  };
}
