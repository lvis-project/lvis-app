/**
 * Vercel AI SDK error → LVIS ClassifiedError mapper.
 *
 * Recognises AISDKError / APICallError subclasses from the `ai` package and
 * routes them through the existing `classifyProviderError()` so the
 * user-visible Korean messages stay consistent with legacy vendor providers.
 *
 * TODO(P3): tighter structured mapping (APICallError.statusCode → category
 *           without re-running the regex on .message).
 */
import { AISDKError, APICallError } from "ai";
import {
  classifyProviderError,
  type ClassifiedError,
} from "../error-classifier.js";
import {
  extractProviderErrorDiagnostics,
  providerErrorMessage,
  withProviderErrorClassification,
  type ProviderErrorDiagnostics,
} from "../provider-error-diagnostics.js";

export interface MappedError {
  classification: ClassifiedError["category"];
  userMessage: string;
  rawError: string;
  providerError: ProviderErrorDiagnostics;
}

export function mapAiSdkErrorToLvis(err: unknown): MappedError {
  const diagnostics = extractProviderErrorDiagnostics(err);
  let raw: string;

  if (APICallError.isInstance(err)) {
    // Combine status + message so the regex in classifyProviderError sees the
    // HTTP code (401/403/413/429/404/...) without us having to duplicate the
    // category table here.
    const status = err.statusCode ?? "";
    raw = `${status} ${providerErrorMessage(err)}`;
  } else if (AISDKError.isInstance(err)) {
    raw = providerErrorMessage(err);
  } else if (err instanceof Error) {
    raw = providerErrorMessage(err);
  } else if (typeof err === "string") {
    raw = err;
  } else {
    // JSON.stringify can throw on circular refs / BigInt; fall back to String().
    try {
      raw = JSON.stringify(err);
    } catch {
      raw = String(err);
    }
  }

  const classified = classifyProviderError(raw);
  return {
    classification: classified.category,
    userMessage: classified.userMessage,
    rawError: raw,
    providerError: withProviderErrorClassification(diagnostics, classified.category),
  };
}
