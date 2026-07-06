export type LlmModelListRequest = {
  vendor: string;
  /**
   * Optional draft endpoint from the settings UI. When omitted, the host reads
   * the persisted vendor block and provider defaults. The host must not attach
   * stored credentials unless this resolves to the persisted/default endpoint.
   */
  baseUrl?: string;
};

export const MAX_LLM_MODEL_LIST_CACHE_ENTRIES = 48;
export const MAX_CACHED_LLM_MODEL_IDS = 2_000;
export const MAX_CACHED_LLM_MODEL_ID_LENGTH = 256;

export type LlmModelListCacheEntry = {
  vendor: string;
  baseUrl?: string;
  endpoint: string;
  models: string[];
  fetchedAt: string;
};

export type LlmModelListCache = Record<string, LlmModelListCacheEntry>;

export function llmModelListCacheKey(vendor: string, baseUrl?: string): string {
  return `${vendor.trim()}\n${baseUrl?.trim() ?? ""}`;
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
      fetchedAt: string;
    }
  | {
      ok: false;
      error: LlmModelListError;
      message?: string;
      endpoint?: string;
      status?: number;
    };
