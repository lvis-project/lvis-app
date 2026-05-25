import type { ErrorCategory } from "./error-classifier.js";

export interface ProviderRateLimitDiagnostics {
  kind: "tokens-per-minute" | "requests-per-minute" | "unknown";
  limit?: number;
  used?: number;
  requested?: number;
  retryAfterSeconds?: number;
}

export interface ProviderErrorDiagnostics {
  origin: "provider" | "ai-sdk" | "unknown";
  providerType?: string;
  providerCode?: string;
  statusCode?: number;
  isRetryable?: boolean;
  urlHost?: string;
  urlPath?: string;
  messagePreview: string;
  classification?: ErrorCategory;
  rateLimit?: ProviderRateLimitDiagnostics;
}

interface ApiCallErrorLike {
  message?: unknown;
  statusCode?: unknown;
  responseHeaders?: unknown;
  responseBody?: unknown;
  isRetryable?: unknown;
  url?: unknown;
  data?: unknown;
}

const ORG_ID_RE = /\borg-[A-Za-z0-9_-]+\b/g;
const LONG_SECRETISH_TOKEN_RE = /\b[A-Za-z0-9_-]{48,}\b/g;

export function extractProviderErrorDiagnostics(
  error: unknown,
): ProviderErrorDiagnostics {
  const apiError = asApiCallErrorLike(error);
  const nested = extractNestedProviderError(error);
  const responseBodyError = parseResponseBodyError(apiError?.responseBody);
  const providerError = responseBodyError ?? nested;
  const rawMessage =
    stringValue(providerError?.message) ??
    stringValue(apiError?.message) ??
    errorMessage(error);
  const responseHeaders = recordValue(apiError?.responseHeaders);
  const rateLimit = parseRateLimitDiagnostics(rawMessage, responseHeaders);
  const urlParts = parseUrlParts(stringValue(apiError?.url));
  const providerType =
    stringValue(providerError?.type) ??
    stringValue(nested?.type);
  const providerCode =
    stringValue(providerError?.code) ??
    stringValue(nested?.code);
  const statusCode = numberValue(apiError?.statusCode);
  const isRetryable =
    typeof apiError?.isRetryable === "boolean" ? apiError.isRetryable : undefined;

  return {
    origin: apiError ? "provider" : providerError ? "provider" : "unknown",
    ...(providerType ? { providerType } : {}),
    ...(providerCode ? { providerCode } : {}),
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(isRetryable !== undefined ? { isRetryable } : {}),
    ...(urlParts?.host ? { urlHost: urlParts.host } : {}),
    ...(urlParts?.path ? { urlPath: urlParts.path } : {}),
    messagePreview: sanitizeMessage(rawMessage),
    ...(rateLimit ? { rateLimit } : {}),
  };
}

export function withProviderErrorClassification(
  diagnostics: ProviderErrorDiagnostics,
  classification: ErrorCategory,
): ProviderErrorDiagnostics {
  return { ...diagnostics, classification };
}

export function providerErrorMessage(error: unknown): string {
  const nested = extractNestedProviderError(error);
  return stringValue(nested?.message) ?? errorMessage(error);
}

function asApiCallErrorLike(error: unknown): ApiCallErrorLike | null {
  if (!isRecord(error)) return null;
  if (
    "statusCode" in error ||
    "responseHeaders" in error ||
    "responseBody" in error ||
    "isRetryable" in error ||
    "url" in error
  ) {
    return error as ApiCallErrorLike;
  }
  return null;
}

function extractNestedProviderError(error: unknown): Record<string, unknown> | null {
  if (!isRecord(error)) return null;
  const inner = error.error;
  if (isRecord(inner)) return inner;
  const hasProviderShape =
    typeof error.type === "string" &&
    (typeof error.code === "string" || typeof error.message === "string");
  return hasProviderShape ? error : null;
}

function parseResponseBodyError(responseBody: unknown): Record<string, unknown> | null {
  const raw = stringValue(responseBody);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return null;
    const inner = parsed.error;
    return isRecord(inner) ? inner : parsed;
  } catch {
    return null;
  }
}

function parseRateLimitDiagnostics(
  message: string,
  responseHeaders?: Record<string, unknown>,
): ProviderRateLimitDiagnostics | undefined {
  const lower = message.toLowerCase();
  const isRateLimit =
    /rate[_ -]?limit|too many requests|tokens per min|tokens per minute|\btpm\b|requests per minute|\brpm\b/.test(lower);
  if (!isRateLimit) return undefined;

  const retryAfterHeader = headerNumber(responseHeaders, "retry-after");
  const retryAfterText = numberFromRegex(message, /try again in\s*([\d.]+)\s*s/i);
  const limit = integerFromRegex(message, /\bLimit\s+([\d,]+)/i);
  const used = integerFromRegex(message, /\bUsed\s+([\d,]+)/i);
  const requested = integerFromRegex(message, /\bRequested\s+([\d,]+)/i);
  const kind = /tokens per min|tokens per minute|\btpm\b/i.test(message)
    ? "tokens-per-minute"
    : /requests per minute|\brpm\b/i.test(message)
      ? "requests-per-minute"
      : "unknown";

  return {
    kind,
    ...(limit !== undefined ? { limit } : {}),
    ...(used !== undefined ? { used } : {}),
    ...(requested !== undefined ? { requested } : {}),
    ...(retryAfterHeader !== undefined
      ? { retryAfterSeconds: retryAfterHeader }
      : retryAfterText !== undefined
        ? { retryAfterSeconds: retryAfterText }
        : {}),
  };
}

function parseUrlParts(rawUrl: string | undefined): { host: string; path: string } | null {
  if (!rawUrl) return null;
  try {
    const parsed = new URL(rawUrl);
    return { host: parsed.host, path: parsed.pathname };
  } catch {
    return null;
  }
}

function headerNumber(
  headers: Record<string, unknown> | undefined,
  name: string,
): number | undefined {
  if (!headers) return undefined;
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  if (!found) return undefined;
  const value = Number.parseFloat(String(found[1]));
  return Number.isFinite(value) ? value : undefined;
}

function integerFromRegex(message: string, re: RegExp): number | undefined {
  const match = message.match(re);
  if (!match?.[1]) return undefined;
  const value = Number.parseInt(match[1].replace(/,/g, ""), 10);
  return Number.isFinite(value) ? value : undefined;
}

function numberFromRegex(message: string, re: RegExp): number | undefined {
  const match = message.match(re);
  if (!match?.[1]) return undefined;
  const value = Number.parseFloat(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

function sanitizeMessage(message: string): string {
  return message
    .replace(ORG_ID_RE, "org-***")
    .replace(LONG_SECRETISH_TOKEN_RE, "[redacted-token]")
    .slice(0, 500);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (isRecord(error) && typeof error.message === "string") return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
