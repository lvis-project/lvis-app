import type { SettingsService } from "../../data/settings-store.js";
import type {
  LlmModelListEntry,
  LlmModelListPricing,
  LlmModelListRequest,
  LlmModelListResult,
} from "../../shared/llm-model-list.js";
import {
  getLlmVendorSettings,
  isLLMVendor,
  type LLMVendor,
} from "../../shared/llm-vendor-defaults.js";
import {
  isMarketplaceProviderPresetId,
  marketplaceProviderPresetSecretKey,
  type MarketplaceInstalledProviderPreset,
} from "../../shared/marketplace-package-assets.js";
import {
  ensurePublicHttpUrl,
  fetchPublicHttpResponse,
  NetworkGuardError,
} from "../../core/network-guard.js";
import { secretKeyFor } from "./provider-factory.js";

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_MODEL_IDS = 2_000;
const MAX_MODEL_ID_LENGTH = 256;

const STANDARD_MODEL_LIST_BASE_URLS: Partial<Record<LLMVendor, string>> = {
  openai: "https://api.openai.com/v1",
  copilot: "https://models.github.ai/inference",
};

export type LlmModelListFetchOptions = {
  fetchImpl?: typeof fetch;
  fetchPublicHttpResponseImpl?: typeof fetchPublicHttpResponse;
  timeoutMs?: number;
  maxResponseBytes?: number;
  ensurePublicUrl?: typeof ensurePublicHttpUrl;
};

class ModelListError extends Error {
  constructor(
    readonly code: Exclude<LlmModelListResult, { ok: true }>["error"],
    message: string,
  ) {
    super(message);
    this.name = "ModelListError";
  }
}

type ResolvedModelListBaseUrl = {
  baseUrl: string | null;
  mayUseStoredCredential: boolean;
  isDraftEndpoint: boolean;
};

function configuredModelListBaseUrl(
  settingsService: SettingsService,
  vendor: LLMVendor,
): string | null {
  const llm = settingsService.get("llm");
  const block = getLlmVendorSettings(llm.vendors, vendor);
  if (block.baseUrl?.trim()) return block.baseUrl.trim();
  return STANDARD_MODEL_LIST_BASE_URLS[vendor] ?? null;
}

function sameModelListEndpoint(a: string, b: string): boolean {
  try {
    return modelListEndpointFromBaseUrl(a) === modelListEndpointFromBaseUrl(b);
  } catch {
    return false;
  }
}

function usesHttpsEndpoint(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function sameOriginScopeFor(value: string): false | ((url: URL) => boolean) {
  try {
    const origin = new URL(value).origin;
    return (candidate) => candidate.origin === origin;
  } catch {
    return false;
  }
}

function resolveModelListBaseUrl(
  settingsService: SettingsService,
  vendor: LLMVendor,
  requestBaseUrl: unknown,
): ResolvedModelListBaseUrl {
  const configuredBaseUrl = configuredModelListBaseUrl(settingsService, vendor);
  if (typeof requestBaseUrl === "string" && requestBaseUrl.trim()) {
    const baseUrl = requestBaseUrl.trim();
    return {
      baseUrl,
      mayUseStoredCredential:
        configuredBaseUrl !== null &&
        sameModelListEndpoint(baseUrl, configuredBaseUrl),
      isDraftEndpoint:
        configuredBaseUrl === null ||
        !sameModelListEndpoint(baseUrl, configuredBaseUrl),
    };
  }

  return {
    baseUrl: configuredBaseUrl,
    mayUseStoredCredential: configuredBaseUrl !== null,
    isDraftEndpoint: false,
  };
}

function storedCredentialForModelList(
  settingsService: SettingsService,
  vendor: LLMVendor,
  resolved: ResolvedModelListBaseUrl,
  credentialScope?: string,
): string {
  if (!resolved.mayUseStoredCredential) return "";
  const requestedPresetId = vendor === "openai-compatible" && isMarketplaceProviderPresetId(credentialScope)
    ? credentialScope
    : undefined;
  if (requestedPresetId) {
    const installedPreset = settingsService
      .get("marketplace")
      .installedProviderPresets ?? [];
    const requestedPreset = installedPreset
      .find((preset) => preset.providerId === requestedPresetId);
    if (requestedPreset) {
      if (!resolved.baseUrl || !sameModelListEndpoint(resolved.baseUrl, requestedPreset.baseUrl)) {
        return "";
      }
      return settingsService.getSecret(
        marketplaceProviderPresetSecretKey(requestedPreset.providerId),
      ) ?? "";
    }
    return "";
  }
  const llm = settingsService.get("llm");
  if (
    vendor === "openai-compatible" &&
    llm.provider === "openai-compatible" &&
    llm.marketplaceProviderPresetId
  ) {
    const installedPreset = settingsService
      .get("marketplace")
      .installedProviderPresets ?? [];
    const activePreset = installedPreset
      .find((preset) => preset.providerId === llm.marketplaceProviderPresetId);
    if (activePreset) {
      if (!resolved.baseUrl || !sameModelListEndpoint(resolved.baseUrl, activePreset.baseUrl)) {
        return "";
      }
      return settingsService.getSecret(
        marketplaceProviderPresetSecretKey(activePreset.providerId),
      ) ?? "";
    }
  }
  return settingsService.getSecret(secretKeyFor(vendor)) ?? "";
}

function installedProviderPresetForScope(
  settingsService: SettingsService,
  providerId: string,
): MarketplaceInstalledProviderPreset | undefined {
  return (settingsService.get("marketplace").installedProviderPresets ?? [])
    .find((preset) => preset.providerId === providerId);
}

function validateModelListCredentialScope(
  settingsService: SettingsService,
  vendor: LLMVendor,
  resolved: ResolvedModelListBaseUrl,
  credentialScope?: string,
): LlmModelListResult | null {
  if (vendor !== "openai-compatible" || !credentialScope) return null;
  if (!isMarketplaceProviderPresetId(credentialScope)) {
    return {
      ok: false,
      error: "provider-not-installed",
      message: "Install this marketplace provider before syncing its models.",
    };
  }
  const installedPreset = installedProviderPresetForScope(settingsService, credentialScope);
  if (!installedPreset) {
    return {
      ok: false,
      error: "provider-not-installed",
      message: "Install this marketplace provider before syncing its models.",
    };
  }
  const llm = settingsService.get("llm");
  if (
    llm.provider !== "openai-compatible" ||
    llm.marketplaceProviderPresetId !== credentialScope
  ) {
    return {
      ok: false,
      error: "provider-not-installed",
      message: "Only the active marketplace provider can sync models with its stored credential.",
    };
  }
  if (!resolved.baseUrl || !sameModelListEndpoint(resolved.baseUrl, installedPreset.baseUrl)) {
    return {
      ok: false,
      error: "invalid-model-list-endpoint",
      message: "Model list endpoint must match the active marketplace provider preset.",
    };
  }
  return null;
}

function privateNetworkScopeForKeylessModelList(
  settingsService: SettingsService,
  vendor: LLMVendor,
  resolved: ResolvedModelListBaseUrl,
  apiKey: string,
  credentialScope?: string,
): false | ((url: URL) => boolean) {
  if (apiKey || vendor !== "openai-compatible" || !resolved.baseUrl) return false;
  const llm = settingsService.get("llm");
  const providerPresetId = isMarketplaceProviderPresetId(credentialScope)
    ? credentialScope
    : llm.provider === "openai-compatible"
      ? llm.marketplaceProviderPresetId
      : undefined;
  if (!providerPresetId) return false;
  const preset = installedProviderPresetForScope(settingsService, providerPresetId);
  if (!preset || preset.requiresApiKey !== false) return false;
  if (!sameModelListEndpoint(resolved.baseUrl, preset.baseUrl)) return false;
  return sameOriginScopeFor(resolved.baseUrl);
}

export function modelListEndpointFromBaseUrl(baseUrl: string): string {
  let url: URL;
  try {
    const normalizedBase = baseUrl.trim().replace(/\/+$/, "");
    url = new URL(`${normalizedBase}/`);
  } catch {
    throw new ModelListError(
      "invalid-model-list-endpoint",
      "baseUrl is not a valid URL",
    );
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ModelListError(
      "invalid-model-list-endpoint",
      "baseUrl must use http or https",
    );
  }
  if (url.username || url.password) {
    throw new ModelListError(
      "invalid-model-list-endpoint",
      "baseUrl must not include embedded credentials",
    );
  }

  const pathname = url.pathname.replace(/\/+$/, "");
  url.pathname = pathname.endsWith("/models") ? pathname : `${pathname}/models`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function isValidModelId(value: string): boolean {
  const id = value.trim();
  return (
    id.length > 0 &&
    id.length <= MAX_MODEL_ID_LENGTH &&
    !/[\u0000-\u001f\u007f]/.test(id)
  );
}

function candidateId(value: unknown): string | null {
  if (typeof value === "string") {
    const id = value.trim();
    return isValidModelId(id) ? id : null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of ["id", "name", "model"]) {
    const raw = record[key];
    if (typeof raw !== "string") continue;
    const id = raw.trim();
    if (isValidModelId(id)) return id;
  }
  return null;
}

function modelListRows(payload: unknown): unknown[] {
  const record =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : null;
  const rows = Array.isArray(record?.data)
    ? record.data
    : Array.isArray(record?.models)
      ? record.models
      : Array.isArray(payload)
        ? payload
        : null;

  if (!rows) {
    throw new ModelListError(
      "invalid-model-list-response",
      "model list response must contain data[] or models[]",
    );
  }
  return rows;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value >= 0 ? value : undefined;
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value
    .map(optionalString)
    .filter((entry): entry is string => Boolean(entry));
  return entries.length > 0 ? [...new Set(entries)] : undefined;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function pricingValue(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return String(value);
  }
  return optionalString(value);
}

function pricingFromRecord(value: unknown): LlmModelListPricing | undefined {
  const record = optionalRecord(value);
  if (!record) return undefined;
  const pricing: LlmModelListPricing = {};
  const fields: Array<[keyof LlmModelListPricing, string[]]> = [
    ["prompt", ["prompt", "input"]],
    ["completion", ["completion", "output"]],
    ["request", ["request"]],
    ["image", ["image"]],
    ["webSearch", ["web_search", "webSearch"]],
    ["internalReasoning", ["internal_reasoning", "internalReasoning"]],
    ["inputCacheRead", ["input_cache_read", "inputCacheRead"]],
    ["inputCacheWrite", ["input_cache_write", "inputCacheWrite"]],
  ];
  for (const [target, keys] of fields) {
    for (const key of keys) {
      const value = pricingValue(record[key]);
      if (value !== undefined) {
        pricing[target] = value;
        break;
      }
    }
  }
  return Object.keys(pricing).length > 0 ? pricing : undefined;
}

function isZeroPrice(value: string | undefined): boolean {
  if (value === undefined) return false;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed === 0;
}

function hasFreePricing(pricing: LlmModelListPricing | undefined): boolean {
  if (!pricing) return false;
  return isZeroPrice(pricing.prompt) && isZeroPrice(pricing.completion);
}

function modelEntryTags(
  id: string,
  record: Record<string, unknown> | undefined,
  pricing: LlmModelListPricing | undefined,
): LlmModelListEntry["tags"] | undefined {
  const lowerId = id.toLocaleLowerCase();
  const provider = optionalString(record?.provider)?.toLocaleLowerCase()
    ?? optionalString(record?.owned_by)?.toLocaleLowerCase()
    ?? optionalString(optionalRecord(record?.top_provider)?.name)?.toLocaleLowerCase()
    ?? "";
  const free = lowerId === "openrouter/free" || lowerId.endsWith(":free") || hasFreePricing(pricing);
  const router = lowerId === "openrouter/auto"
    || lowerId === "openrouter/free"
    || lowerId.startsWith("openrouter/")
    || provider.includes("router")
    || Boolean(record?.route)
    || Boolean(record?.routing);
  const local = lowerId.startsWith("ollama/")
    || lowerId.startsWith("lmstudio/")
    || lowerId.startsWith("lm-studio/")
    || provider.includes("ollama")
    || provider.includes("lm studio");
  const tags: LlmModelListEntry["tags"] = {};
  if (free) tags.free = true;
  if (router) tags.router = true;
  if (local) tags.local = true;
  return Object.keys(tags).length > 0 ? tags : undefined;
}

function modelEntryFromRow(row: unknown): LlmModelListEntry | null {
  const id = candidateId(row);
  if (!id) return null;
  const record = optionalRecord(row);
  if (!record) return { id };
  const architecture = optionalRecord(record.architecture);
  const topProvider = optionalRecord(record.top_provider);
  const pricing = pricingFromRecord(record.pricing);
  const name = optionalString(record.name);
  const provider = optionalString(record.provider);
  const ownedBy = optionalString(record.owned_by);
  const description = optionalString(record.description);
  const contextLength = optionalNumber(record.context_length)
    ?? optionalNumber(record.contextLength)
    ?? optionalNumber(topProvider?.context_length);
  const inputModalities = optionalStringArray(architecture?.input_modalities);
  const outputModalities = optionalStringArray(architecture?.output_modalities);
  const supportedParameters = optionalStringArray(record.supported_parameters);
  const entry: LlmModelListEntry = {
    id,
    ...(name && name !== id ? { name } : {}),
    ...(provider ? { provider } : {}),
    ...(ownedBy ? { ownedBy } : {}),
    ...(description ? { description } : {}),
    ...(contextLength !== undefined ? { contextLength } : {}),
    ...(inputModalities ? { inputModalities } : {}),
    ...(outputModalities ? { outputModalities } : {}),
    ...(supportedParameters ? { supportedParameters } : {}),
    ...(pricing ? { pricing } : {}),
  };
  const tags = modelEntryTags(id, record, pricing);
  if (tags) entry.tags = tags;
  return entry;
}

export function parseStandardModelListEntries(payload: unknown): LlmModelListEntry[] {
  const rows = modelListRows(payload);

  const entries: LlmModelListEntry[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const entry = modelEntryFromRow(row);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    entries.push(entry);
    if (entries.length >= MAX_MODEL_IDS) break;
  }

  if (entries.length === 0) {
    throw new ModelListError(
      "invalid-model-list-response",
      "model list response did not contain model ids",
    );
  }
  return entries;
}

export function parseStandardModelListResponse(payload: unknown): string[] {
  const ids = parseStandardModelListEntries(payload).map((entry) => entry.id);
  return ids;
}

async function readResponseTextLimited(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const parsed = Number(contentLength);
    if (Number.isFinite(parsed) && parsed > maxBytes) {
      throw new ModelListError(
        "model-list-response-too-large",
        "model list response is too large",
      );
    }
  }

  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new ModelListError(
        "model-list-response-too-large",
        "model list response is too large",
      );
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ModelListError(
          "model-list-response-too-large",
          "model list response is too large",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

export async function listLlmModelsFromSettings(
  settingsService: SettingsService,
  request: LlmModelListRequest,
  options: LlmModelListFetchOptions = {},
): Promise<LlmModelListResult> {
  if (!isLLMVendor(request.vendor)) {
    return {
      ok: false,
      error: "invalid-provider",
      message: "Unknown LLM provider.",
    };
  }
  const resolved = resolveModelListBaseUrl(
    settingsService,
    request.vendor,
    request.baseUrl,
  );
  if (!resolved.baseUrl) {
    return {
      ok: false,
      error: "model-list-not-supported",
      message: "This provider does not expose a standard model list endpoint.",
    };
  }

  let endpoint: string;
  try {
    endpoint = modelListEndpointFromBaseUrl(resolved.baseUrl);
  } catch (err) {
    if (err instanceof ModelListError) {
      return { ok: false, error: err.code, message: err.message };
    }
    throw err;
  }

  const credentialScopeError = validateModelListCredentialScope(
    settingsService,
    request.vendor,
    resolved,
    request.credentialScope,
  );
  if (credentialScopeError) return credentialScopeError;

  const apiKey = storedCredentialForModelList(
    settingsService,
    request.vendor,
    resolved,
    request.credentialScope,
  );
  if (apiKey && !usesHttpsEndpoint(endpoint)) {
    return {
      ok: false,
      error: "invalid-model-list-endpoint",
      endpoint,
      message: "Credentialed model list endpoints must use https.",
    };
  }
  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const privateNetworkScope = privateNetworkScopeForKeylessModelList(
    settingsService,
    request.vendor,
    resolved,
    apiKey,
    request.credentialScope,
  );

  let requestEndpoint = endpoint;
  try {
    // Model-list sync intentionally sends a user/provider-configured LLM URL
    // to the network. Validate every stored or draft endpoint through the same
    // DNS-aware SSRF guard before the request wrapper revalidates redirect hops.
    requestEndpoint = (await (options.ensurePublicUrl ?? ensurePublicHttpUrl)(
      endpoint,
      {
        allowLoopback: privateNetworkScope,
      },
    )).toString();
    const response = await (
      options.fetchPublicHttpResponseImpl ?? fetchPublicHttpResponse
    )(requestEndpoint, {
      method: "GET",
      headers,
      fetchImpl: options.fetchImpl,
      maxRedirects: 0,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      allowLoopback: privateNetworkScope,
    });
    if (!response.ok) {
      return {
        ok: false,
        error: "model-list-fetch-failed",
        endpoint: requestEndpoint,
        status: response.status,
        message: `Model list request failed with HTTP ${response.status}.`,
      };
    }

    const text = await readResponseTextLimited(
      response,
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    );
    let payload: unknown;
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      throw new ModelListError(
        "invalid-model-list-response",
        "model list response must be valid JSON",
      );
    }
    const modelEntries = parseStandardModelListEntries(payload);
    return {
      ok: true,
      vendor: request.vendor,
      endpoint: requestEndpoint,
      models: modelEntries.map((entry) => entry.id),
      modelEntries,
      fetchedAt: new Date().toISOString(),
    };
  } catch (err) {
    if (err instanceof ModelListError) {
      return { ok: false, error: err.code, endpoint, message: err.message };
    }
    if (err instanceof NetworkGuardError) {
      return {
        ok: false,
        error: "invalid-model-list-endpoint",
        endpoint,
        message: err.message,
      };
    }
    return {
      ok: false,
      error: "model-list-fetch-failed",
      endpoint: requestEndpoint,
      message:
        err instanceof Error && err.name === "AbortError"
          ? "Model list request timed out."
          : err instanceof Error
            ? err.message
            : String(err),
    };
  }
}
