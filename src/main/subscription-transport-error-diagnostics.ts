/**
 * Safe recovery and failure metadata from an authenticated subscription transport.
 *
 * Remote runtimes are allowed to return arbitrary error text, which can contain
 * user content, paths, account information, or credentials. This module may
 * inspect a narrowly bounded portion of that response to recognize the three
 * recoveries LVIS supports, but it never returns server text or unrecognised
 * fields. Closed transport facts describe other failures without enabling new
 * recoveries. The result is suitable for `StreamEvent.providerError`.
 */
import { constants } from "node:os";
import {
  PROVIDER_RPC_OPERATIONS,
  type ProviderErrorDiagnostics,
  type ProviderRateLimitDiagnostics,
  type ProviderRpcOperation,
  type ProviderTransportDiagnostics,
} from "../engine/llm/provider-error-diagnostics.js";
import { isRecord } from "../shared/is-record.js";

const TRANSPORT_FAILURE_PREVIEW = "subscription runtime transport failure";
const TRANSPORT_PHASES: readonly ProviderTransportDiagnostics["phase"][] = [
  "process-start", "process-error", "stdout-parse", "stdout-frame", "stdout-read", "stdin-write",
  "stderr-read", "process-exit", "rpc-write", "rpc-timeout", "rpc-response",
  "turn-completion", "native-request",
];
const TRANSPORT_KINDS: readonly ProviderTransportDiagnostics["kind"][] = [
  "process", "protocol", "network", "timeout", "authentication", "rate-limit",
  "server", "model", "unknown",
];

/** Copy only closed labels and bounded process facts; never copy runtime text. */
function normalizeTransportDiagnostics(value: unknown): ProviderTransportDiagnostics | undefined {
  if (!isRecord(value)) return undefined;
  const { phase, kind, operation, statusCode, exitCode, signal } = value;
  if (!TRANSPORT_PHASES.some((candidate) => candidate === phase)
    || !TRANSPORT_KINDS.some((candidate) => candidate === kind)) return undefined;
  if (operation !== undefined && !PROVIDER_RPC_OPERATIONS.some((candidate) => candidate === operation)) return undefined;
  if (statusCode !== undefined && safeStatusCode(statusCode) === undefined) return undefined;
  if (exitCode !== undefined && exitCode !== null && (typeof exitCode !== "number"
    || !Number.isInteger(exitCode) || exitCode < -2_147_483_648 || exitCode > 4_294_967_295)) return undefined;
  if (signal !== undefined && signal !== null && (typeof signal !== "string"
    || !Object.hasOwn(constants.signals, signal))) return undefined;
  return {
    phase: phase as ProviderTransportDiagnostics["phase"],
    kind: kind as ProviderTransportDiagnostics["kind"],
    ...(operation === undefined ? {} : { operation: operation as ProviderRpcOperation }),
    ...(statusCode === undefined ? {} : { statusCode: statusCode as number }),
    ...(exitCode === undefined ? {} : { exitCode: exitCode as number | null }),
    ...(signal === undefined ? {} : { signal: signal as string | null }),
  };
}

export function subscriptionTransportFailure(
  transport: ProviderTransportDiagnostics,
): ProviderErrorDiagnostics {
  const normalized = normalizeTransportDiagnostics(transport);
  if (!normalized) throw new Error("Invalid subscription transport diagnostics");
  return { origin: "unknown", classification: "unknown", messagePreview: TRANSPORT_FAILURE_PREVIEW, transport: normalized };
}

const MAX_REMOTE_DIAGNOSTIC_TEXT_LENGTH = 8_192;
const MAX_RATE_LIMIT_VALUE = 1_000_000_000_000;
/**
 * Charset a tool name quoted in REMOTE error text may be echoed with. This is
 * an external boundary, not the host's tool-name rule: the runtime names
 * whatever function its own side rejected (which may be a provider-namespaced
 * `ns.tool`, hence the dot), and the match is only ever echoed into a bounded
 * `messagePreview` — never resolved against the registry.
 */
const REMOTE_ERROR_TOOL_NAME_ECHO_CHARSET = "[A-Za-z0-9_.-]{1,128}";
const REMOTE_ERROR_TOOL_NAME_ECHO = new RegExp(`^${REMOTE_ERROR_TOOL_NAME_ECHO_CHARSET}$`, "u");
const SCHEMA_SIGNAL = /invalid[_ -]function[_ -]parameters|invalid schema for (?:function|tool)/iu;
const NAMED_FUNCTION = new RegExp(`(?:function|tool)\\s+['"\`]?(${REMOTE_ERROR_TOOL_NAME_ECHO_CHARSET})['"\`]?`, "iu");
const INVALID_SCHEMA_PREVIEW = new RegExp(`^Invalid schema for function '${REMOTE_ERROR_TOOL_NAME_ECHO_CHARSET}'\\.$`, "u");
const CONTEXT_SIGNAL = /context[_ -]?(?:length|window)|maximum context length|prompt is too long|too many tokens/iu;
const TPM_SIGNAL = /tokens?[_ -]?(?:per[_ -]?minute|per min)|\btpm\b/iu;
const RATE_LIMIT_SIGNAL = /rate[_ -]?limit|too many requests|\b429\b/iu;

/** An error may carry this private, pre-sanitized diagnostic between main-process layers. */
export interface SubscriptionTransportDiagnosticError extends Error {
  readonly providerError?: ProviderErrorDiagnostics;
}

function ownValue(record: Record<string, unknown>, key: string): unknown {
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

function directRecords(root: Record<string, unknown>): readonly Record<string, unknown>[] {
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

function diagnosticText(records: readonly Record<string, unknown>[]): readonly string[] {
  const values: string[] = [];
  for (const record of records) {
    for (const key of ["code", "type", "kind", "classification", "message", "reason"] as const) {
      const text = boundedText(ownValue(record, key));
      if (text) values.push(text);
    }
  }
  return values;
}

function diagnosticStatus(records: readonly Record<string, unknown>[]): number | undefined {
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
    if (name && REMOTE_ERROR_TOOL_NAME_ECHO.test(name)) return name;
  }
  return undefined;
}

function rateLimitRecord(records: readonly Record<string, unknown>[]): Record<string, unknown> | undefined {
  for (const record of records) {
    for (const key of ["rateLimit", "rate_limit", "limits"] as const) {
      const candidate = ownValue(record, key);
      if (isRecord(candidate)) return candidate;
    }
  }
  return undefined;
}

function rateLimitDiagnostics(
  records: readonly Record<string, unknown>[],
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
 * Project the exact recovery cases that the engine can act on. When a failure
 * phase is supplied, other errors retain diagnostic facts with no new recovery.
 */
export function projectSubscriptionTransportErrorDiagnostics(
  error: unknown,
  phase?: "rpc-response" | "turn-completion",
): ProviderErrorDiagnostics | undefined {
  if (!isRecord(error)) return phase ? subscriptionTransportFailure({ phase, kind: "unknown" }) : undefined;
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

  if (!phase) return undefined;
  // Keep HTTP status inside the diagnostic, so it cannot alter retry behavior.
  const codes = records.flatMap((record) => [ownValue(record, "code"), ownValue(record, "type")]);
  const kind: ProviderTransportDiagnostics["kind"] = statusCode === 401 || statusCode === 403 ? "authentication"
    : statusCode === 429 ? "rate-limit"
    : statusCode === 408 || statusCode === 504 || codes.includes("ETIMEDOUT") ? "timeout"
    : statusCode !== undefined && statusCode >= 500 ? "server"
    : codes.some((code) => typeof code === "string" && ["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EPIPE"].includes(code)) ? "network"
    : codes.some((code) => code === "model_not_found" || code === "invalid_model") ? "model"
    : "unknown";
  return subscriptionTransportFailure({ phase, kind, ...(statusCode === undefined ? {} : { statusCode }) });
}

/** Revalidate an error-carried diagnostic before it crosses another local layer. */
export function projectedSubscriptionTransportDiagnosticsFromError(
  error: unknown,
): ProviderErrorDiagnostics | undefined {
  if (!isRecord(error)) return undefined;
  const candidate = ownValue(error, "providerError");
  if (isRecord(candidate) && candidate.origin === "unknown"
    && candidate.classification === "unknown" && candidate.messagePreview === TRANSPORT_FAILURE_PREVIEW) {
    const transport = normalizeTransportDiagnostics(ownValue(candidate, "transport"));
    return transport ? subscriptionTransportFailure(transport) : undefined;
  }
  if (!isRecord(candidate) || candidate.origin !== "provider" || typeof candidate.messagePreview !== "string") {
    return undefined;
  }
  const messagePreview = candidate.messagePreview;
  if (
    candidate.providerCode === "invalid_function_parameters"
    && candidate.classification === "unknown"
    && INVALID_SCHEMA_PREVIEW.test(messagePreview)
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
