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

export interface MappedError {
  classification: ClassifiedError["category"];
  userMessage: string;
}

export function mapAiSdkErrorToLvis(err: unknown): MappedError {
  let raw: string;

  if (APICallError.isInstance(err)) {
    // Combine status + message so the regex in classifyProviderError sees the
    // HTTP code (401/403/413/429/404/...) without us having to duplicate the
    // category table here.
    const status = err.statusCode ?? "";
    raw = `${status} ${err.message}`;
  } else if (AISDKError.isInstance(err)) {
    raw = err.message;
  } else if (err instanceof Error) {
    raw = err.message;
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
  };
}
