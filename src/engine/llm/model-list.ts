import type { SettingsService } from "../../data/settings-store.js";
import type {
  LlmModelListRequest,
  LlmModelListResult,
} from "../../shared/llm-model-list.js";
import {
  getLlmVendorSettings,
  isLLMVendor,
  type LLMVendor,
} from "../../shared/llm-vendor-defaults.js";
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

export function parseStandardModelListResponse(payload: unknown): string[] {
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

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const id = candidateId(row);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= MAX_MODEL_IDS) break;
  }

  if (ids.length === 0) {
    throw new ModelListError(
      "invalid-model-list-response",
      "model list response did not contain model ids",
    );
  }
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

  const apiKey = resolved.mayUseStoredCredential
    ? settingsService.getSecret(secretKeyFor(request.vendor)) ?? ""
    : "";
  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  let requestEndpoint = endpoint;
  try {
    // Model-list sync intentionally sends a user/provider-configured LLM URL
    // to the network. Validate every stored or draft endpoint through the same
    // DNS-aware SSRF guard before the request wrapper revalidates redirect hops.
    requestEndpoint = (await (options.ensurePublicUrl ?? ensurePublicHttpUrl)(
      endpoint,
    )).toString();
    const response = await (
      options.fetchPublicHttpResponseImpl ?? fetchPublicHttpResponse
    )(requestEndpoint, {
      method: "GET",
      headers,
      fetchImpl: options.fetchImpl,
      maxRedirects: 0,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
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
    return {
      ok: true,
      vendor: request.vendor,
      endpoint: requestEndpoint,
      models: parseStandardModelListResponse(payload),
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
