import type { MarketplaceProviderModelDiscoveryPolicy } from "./marketplace-package-assets.js";

export type LlmModelListRequest = {
  vendor: string;
  /**
   * Optional draft endpoint from the settings UI. When omitted, the host reads
   * the persisted vendor block and provider defaults. The host must not attach
   * stored credentials unless this resolves to the persisted/default endpoint.
   */
  baseUrl?: string;
  /**
   * Optional marketplace provider preset id. Renderer uses this when multiple
   * installed OpenAI-compatible presets share one endpoint but must use
   * separate credential namespaces and cache entries.
   */
  credentialScope?: string;
  /**
   * Optional marketplace provider discovery policy. Static/manual providers
   * keep their seeded model list and must not be probed through /models.
   */
  modelDiscoveryPolicy?: MarketplaceProviderModelDiscoveryPolicy;
};

export const MAX_LLM_MODEL_LIST_CACHE_ENTRIES = 48;
export const MAX_CACHED_LLM_MODEL_IDS = 2_000;
export const MAX_CACHED_LLM_MODEL_ID_LENGTH = 256;

export type LlmModelListPricing = {
  prompt?: string;
  completion?: string;
  request?: string;
  image?: string;
  webSearch?: string;
  internalReasoning?: string;
  inputCacheRead?: string;
  inputCacheWrite?: string;
};

export type LlmModelListEntry = {
  id: string;
  name?: string;
  provider?: string;
  ownedBy?: string;
  description?: string;
  /**
   * The largest prompt this model accepts, as the provider reports it. The
   * host budgets compaction against this when the model is not in the pricing
   * catalog, so a self-hosted or gateway-served model is no longer stuck with
   * the conservative fallback window.
   */
  contextLength?: number;
  /**
   * The largest completion this model will produce, as the provider reports
   * it. Carried beside the window for a caller that needs an output ceiling;
   * nothing enforces a limit from it yet.
   */
  maxOutputTokens?: number;
  inputModalities?: string[];
  outputModalities?: string[];
  supportedParameters?: string[];
  pricing?: LlmModelListPricing;
  tags?: {
    free?: boolean;
    router?: boolean;
    local?: boolean;
  };
};

export type LlmModelListCacheEntry = {
  vendor: string;
  baseUrl?: string;
  credentialScope?: string;
  endpoint: string;
  models: string[];
  modelEntries?: LlmModelListEntry[];
  fetchedAt: string;
};

export type LlmModelListCache = Record<string, LlmModelListCacheEntry>;

export function llmModelListCacheKey(
  vendor: string,
  baseUrl?: string,
  credentialScope?: string,
): string {
  return `${vendor.trim()}\n${baseUrl?.trim() ?? ""}\n${credentialScope?.trim() ?? ""}`;
}

/**
 * The catalogue row a route's model was last reported under, when that route's
 * `/models` handshake is in the cache and named this model.
 *
 * `undefined` covers every "the provider never told us" case — no handshake for
 * this endpoint, a handshake that predates entry metadata, or a catalogue that
 * does not list the configured model. Callers treat that as an absent input and
 * ask the next source, never as an error.
 */
export function cachedModelListEntry(
  cache: LlmModelListCache | undefined,
  params: {
    vendor: string;
    model: string;
    baseUrl?: string;
    credentialScope?: string;
  },
): LlmModelListEntry | undefined {
  if (!cache || !params.model) return undefined;
  const key = llmModelListCacheKey(params.vendor, params.baseUrl, params.credentialScope);
  return cache[key]?.modelEntries?.find((row) => row.id === params.model);
}

export type LlmModelListError =
  | "invalid-provider"
  | "provider-not-installed"
  | "model-list-not-supported"
  | "invalid-model-list-endpoint"
  | "model-list-fetch-failed"
  | "model-list-response-too-large"
  | "invalid-model-list-response";

export type LlmModelListResult =
  | {
      ok: true;
      vendor: string;
      endpoint: string;
      models: string[];
      modelEntries?: LlmModelListEntry[];
      fetchedAt: string;
    }
  | {
      ok: false;
      error: LlmModelListError;
      message?: string;
      endpoint?: string;
      status?: number;
    };
