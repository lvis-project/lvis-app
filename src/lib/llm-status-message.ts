import { t } from "../i18n/index.js";

/**
 * The renderer-safe detail emitted when a provider retries or changes over
 * before it has produced assistant content.
 *
 * This is deliberately a structural subset of both `ChatStreamEvent` and the
 * engine's provider callback so each transcript consumer shares visible retry
 * wording.
 */
export interface LlmStatusMessageInput {
  phase?: "attempt" | "retry" | "fallback";
  attempt?: number;
  maxAttempts?: number;
  to?: string;
}

function retryCounts(status: LlmStatusMessageInput): { attempt: number; max: number } | null {
  const { attempt, maxAttempts } = status;
  if (
    typeof attempt !== "number" ||
    !Number.isSafeInteger(attempt) ||
    attempt < 1 ||
    typeof maxAttempts !== "number" ||
    !Number.isSafeInteger(maxAttempts) ||
    maxAttempts < attempt
  ) {
    return null;
  }
  return { attempt, max: maxAttempts };
}

/**
 * Returns no entry for an ordinary provider attempt; the generic progress UI
 * remains authoritative. Retry counts must come from the provider status
 * contract rather than an invented renderer default.
 */
export function formatLlmStatusMessage(status: LlmStatusMessageInput): string {
  if (status.phase === "fallback") {
    const to = status.to ? ` (${status.to})` : "";
    return t("useChatState.llmStatusFallback", { to });
  }
  if (status.phase === "retry") {
    const counts = retryCounts(status);
    if (!counts) return "";
    return t("useChatState.llmStatusRetry", counts);
  }
  return "";
}
