/**
 * Safe recovery metadata from an authenticated subscription transport.
 *
 * Remote runtimes are allowed to return arbitrary error text, which can contain
 * user content, paths, account information, or credentials. This module may
 * inspect a narrowly bounded portion of that response to recognize the three
 * recoveries LVIS supports, but it never returns server text or unrecognised
 * fields. The result is deliberately suitable for `StreamEvent.providerError`.
 */
import type {
  ProviderErrorDiagnostics,
  ProviderRateLimitDiagnostics,
} from "../engine/llm/provider-error-diagnostics.js";
import { isRecord } from "../shared/is-record.js";

type JsonRecord = Record<string, unknown>;

const MAX_REMOTE_DIAGNOSTIC_TEXT_LENGTH = 8_192;
const MAX_RATE_LIMIT_VALUE = 1_000_000_000_000;
const SAFE_TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/u;
const SCHEMA_SIGNAL = /invalid[_ -]function[_ -]parameters|invalid schema for (?:function|tool)/iu;
const NAMED_FUNCTION = /(?:function|tool)\s+['"`]?([A-Za-z0-9_.-]{1,128})['"`]?/iu;
const CONTEXT_SIGNAL = /context[_ -]?(?:length|window)|maximum context length|prompt is too long|too many tokens/iu;
const TPM_SIGNAL = /tokens?[_ -]?(?:per[_ -]?minute|per min)|\btpm\b/iu;
const RATE_LIMIT_SIGNAL = /rate[_ -]?limit|too many requests|\b429\b/iu;

/** An error may carry this private, pre-sanitized diagnostic between main-process layers. */
export interface SubscriptionTransportDiagnosticError extends Error {
  readonly providerError?: ProviderErrorDiagnostics;
}

function ownValue(record: JsonRecord, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function boundedText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0
    ? value.slice(0, MAX_REMOTE_DIAGNOSTIC_TEXT_LENGTH)
    : undefined;
}

function safeStatusCode(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 400 && value <= 599
    ? value
    : undefined;
}

function safeRateValue(value: unknown): number | undefined {
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= 0
    && value <= MAX_RATE_LIMIT_VALUE
    ? value
    : undefined;
}

function directRecords(root: JsonRecord): readonly JsonRecord[] {
  const firstLevel = [
    root,
    ownValue(root, "error"),
    ownValue(root, "data"),
    ownValue(root, "details"),
    ownValue(root, "failure"),
  ].filter(isRecord);
  return [
    ...firstLevel,
    ...firstLevel.flatMap((record) => [
      ownValue(record, "data"),
      ownValue(record, "details"),
      ownValue(record, "failure"),
    ].filter(isRecord)),
  ];
}

function diagnosticText(records: readonly JsonRecord[]): readonly string[] {
  const values: string[] = [];
  for (const record of records) {
    for (const key of ["code", "type", "kind", "classification", "message", "reason"] as const) {
      const text = boundedText(ownValue(record, key));
      if (text) values.push(text);
    }
  }
  return values;
}

function diagnosticStatus(records: readonly JsonRecord[]): number | undefined {
  for (const record of records) {
    for (const key of ["status", "statusCode", "httpStatus", "http_status"] as const) {
      const status = safeStatusCode(ownValue(record, key));
      if (status !== undefined) return status;
    }
  }
  return undefined;
}

function namedSchemaTool(texts: readonly string[]): string | undefined {
  for (const text of texts) {
    const name = text.match(NAMED_FUNCTION)?.[1];
    if (name && SAFE_TOOL_NAME.test(name)) return name;
  }
  return undefined;
}

function rateLimitRecord(records: readonly JsonRecord[]): JsonRecord | undefined {
  for (const record of records) {
    for (const key of ["rateLimit", "rate_limit", "limits"] as const) {
      const candidate = ownValue(record, key);
      if (isRecord(candidate)) return candidate;
    }
  }
  return undefined;
}

function rateLimitDiagnostics(
  records: readonly JsonRecord[],
  texts: readonly string[],
): ProviderRateLimitDiagnostics | undefined {
  const record = rateLimitRecord(records);
  const recordTexts = record ? diagnosticText([record]) : [];
  const isTpm = [...texts, ...recordTexts].some((text) => TPM_SIGNAL.test(text));
  if (!isTpm) return undefined;

  const source = record ?? records[0];
  if (!source) return { kind: "tokens-per-minute" };
  const result: ProviderRateLimitDiagnostics = { kind: "tokens-per-minute" };
  const limit = safeRateValue(ownValue(source, "limit"));
  const used = safeRateValue(ownValue(source, "used"));
  const requested = safeRateValue(ownValue(source, "requested"));
  const retryAfterSeconds = safeRateValue(
    ownValue(source, "retryAfterSeconds")
      ?? ownValue(source, "retry_after_seconds")
      ?? ownValue(source, "retry_after"),
  );
  if (limit !== undefined) result.limit = limit;
  if (used !== undefined) result.used = used;
  if (requested !== undefined) result.requested = requested;
  if (retryAfterSeconds !== undefined) result.retryAfterSeconds = retryAfterSeconds;
  return result;
}

/**
 * Project only the exact recovery cases that the engine can act on. Unknown
 * errors return `undefined` and keep the transport's existing generic failure.
 */
export function projectSubscriptionTransportErrorDiagnostics(
  error: unknown,
): ProviderErrorDiagnostics | undefined {
  if (!isRecord(error)) return undefined;
  const records = directRecords(error);
  const texts = diagnosticText(records);
  const statusCode = diagnosticStatus(records);

  const toolName = namedSchemaTool(texts);
  if (toolName && texts.some((text) => SCHEMA_SIGNAL.test(text))) {
    return {
      origin: "provider",
      statusCode: statusCode ?? 400,
      providerCode: "invalid_function_parameters",
      classification: "unknown",
      messagePreview: `Invalid schema for function '${toolName}'.`,
    };
  }

  if (texts.some((text) => CONTEXT_SIGNAL.test(text))) {
    return {
      origin: "provider",
      ...(statusCode === undefined ? {} : { statusCode }),
      classification: "context-length",
      messagePreview: "context window exceeded",
    };
  }

  const rateLimit = rateLimitDiagnostics(records, texts);
  if (rateLimit && (statusCode === 429 || texts.some((text) => RATE_LIMIT_SIGNAL.test(text)))) {
    return {
      origin: "provider",
      ...(statusCode === undefined ? {} : { statusCode }),
      providerType: "tokens",
      providerCode: "rate_limit_exceeded",
      classification: "rate-limit",
      messagePreview: "subscription runtime tokens-per-minute rate limit",
      rateLimit,
    };
  }

  return undefined;
}

/** Revalidate an error-carried diagnostic before it crosses another local layer. */
export function projectedSubscriptionTransportDiagnosticsFromError(
  error: unknown,
): ProviderErrorDiagnostics | undefined {
  if (!isRecord(error)) return undefined;
  const candidate = ownValue(error, "providerError");
  if (!isRecord(candidate) || candidate.origin !== "provider" || typeof candidate.messagePreview !== "string") {
    return undefined;
  }
  const messagePreview = candidate.messagePreview;
  if (
    candidate.providerCode === "invalid_function_parameters"
    && candidate.classification === "unknown"
    && /^Invalid schema for function '[A-Za-z0-9_.-]{1,128}'\.$/u.test(messagePreview)
  ) {
    return {
      origin: "provider",
      statusCode: 400,
      providerCode: "invalid_function_parameters",
      classification: "unknown",
      messagePreview,
    };
  }
  if (candidate.classification === "context-length" && messagePreview === "context window exceeded") {
    return {
      origin: "provider",
      ...(candidate.statusCode === 413 ? { statusCode: 413 } : {}),
      classification: "context-length",
      messagePreview,
    };
  }
  if (
    candidate.providerType === "tokens"
    && candidate.providerCode === "rate_limit_exceeded"
    && candidate.classification === "rate-limit"
    && messagePreview === "subscription runtime tokens-per-minute rate limit"
    && isRecord(candidate.rateLimit)
    && candidate.rateLimit.kind === "tokens-per-minute"
  ) {
    const rateLimit = rateLimitDiagnostics([candidate.rateLimit], ["tokens per minute"]);
    if (!rateLimit) return undefined;
    return {
      origin: "provider",
      ...(candidate.statusCode === 429 ? { statusCode: 429 } : {}),
      providerType: "tokens",
      providerCode: "rate_limit_exceeded",
      classification: "rate-limit",
      messagePreview,
      rateLimit,
    };
  }
  return undefined;
}
