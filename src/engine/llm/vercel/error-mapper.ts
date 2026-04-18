/**
 * Vercel AI SDK error → LVIS ClassifiedError mapper — P0 stub.
 *
 * P0: passes raw string through to the existing `classifyProviderError`.
 * This preserves current user-visible error text while we wire the adapter.
 *
 * TODO(P3): Recognise Vercel-specific error classes (AISDKError, APICallError,
 *           NoContentGeneratedError, InvalidResponseDataError, ToolCallError)
 *           and map their `.name` / `.statusCode` to our ErrorCategory so we
 *           don't lose structured info to string-matching.
 */
import { classifyProviderError, type ClassifiedError } from "../error-classifier.js";

export interface MappedError {
  classification: ClassifiedError["category"];
  userMessage: string;
}

export function mapAiSdkErrorToLvis(err: unknown): MappedError {
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : JSON.stringify(err);
  const classified = classifyProviderError(raw);
  return {
    classification: classified.category,
    userMessage: classified.userMessage,
  };
}
