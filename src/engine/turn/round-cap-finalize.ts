/**
 * Round-cap finalization — one bounded, tool-free model call issued when a turn
 * exhausts its round budget.
 *
 * Without it, `round-cap` returns the last assistant message verbatim. When the
 * final round was a pure tool-call round that text is empty or a mid-thought
 * fragment, so a sub-agent that ran out of budget mid-investigation returns
 * nothing its parent can act on — the "agent stopped without reporting" symptom.
 * The budget is spent either way; what is missing is a readable hand-off.
 *
 * Deliberately NOT a normal round: no tools are offered, so it cannot extend the
 * work it is summarizing, and `outputTokenLimit` bounds it. It reports; it does
 * not continue.
 */
import type { LLMProvider, GenericMessage, TokenUsage } from "../llm/types.js";
import { createLogger } from "../../lib/logger.js";
import { t } from "../../i18n/index.js";

const log = createLogger("lvis");

/** Enough for a dense hand-off, small enough that the call cannot run away. */
const FINALIZE_OUTPUT_TOKEN_LIMIT = 1024;

export interface RoundCapFinalizeParams {
  provider: LLMProvider;
  model: string;
  systemPrompt: string;
  /** Turn history as it stood when the budget ran out. */
  messages: GenericMessage[];
  abortSignal?: AbortSignal;
}

export interface RoundCapFinalizeResult {
  text: string;
  usage?: TokenUsage;
}

/**
 * Ask the model to state what it established and what remains.
 *
 * Returns `null` when the call cannot produce text — provider error, abort, or
 * an empty completion. The caller keeps whatever partial text it already had;
 * a failed hand-off must never be worse than no hand-off.
 */
export async function finalizeAfterRoundCap(
  params: RoundCapFinalizeParams,
): Promise<RoundCapFinalizeResult | null> {
  if (params.abortSignal?.aborted) return null;

  const messages: GenericMessage[] = [
    ...params.messages,
    { role: "user", content: t("be_conversationLoop.roundCapFinalizePrompt") },
  ];

  let text = "";
  let usage: TokenUsage | undefined;
  try {
    for await (const event of params.provider.streamTurn({
      model: params.model,
      systemPrompt: params.systemPrompt,
      messages,
      // No `tools`: the call must summarize the work, never extend it.
      outputTokenLimit: FINALIZE_OUTPUT_TOKEN_LIMIT,
      ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
    })) {
      if (event.type === "text_delta") text += event.text;
      else if (event.type === "message_complete") usage = event.usage;
      else if (event.type === "error") {
        log.warn({ error: event.error }, "round-cap finalize: provider error");
        return null;
      }
    }
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "round-cap finalize: call failed",
    );
    return null;
  }

  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  return usage ? { text: trimmed, usage } : { text: trimmed };
}

/**
 * What a round-capped turn returns, in order of preference:
 *
 *  1. the finalize hand-off — written knowing the work stopped, so it states
 *     findings and remaining steps rather than trailing off mid-thought;
 *  2. the last assistant message verbatim — the pre-existing behavior, kept as
 *     the fallback because a real partial answer beats a synthetic notice;
 *  3. the round-cap notice — only when there is no assistant text at all, which
 *     is exactly the tool-only-final-round case that read as silent failure.
 */
export function resolveRoundCapText(
  finalized: RoundCapFinalizeResult | null,
  messages: readonly GenericMessage[],
  roundCapNotice: string,
): string {
  if (finalized?.text) return finalized.text;
  const lastAssistant = messages
    .filter((m) => m.role === "assistant")
    .slice(-1)[0]?.content ?? "";
  return lastAssistant.length > 0 ? lastAssistant : roundCapNotice;
}

/** Fold the finalize call's usage into the turn total. Identity when absent. */
export function mergeFinalizeUsage(
  turnUsage: TokenUsage | undefined,
  finalized: RoundCapFinalizeResult | null,
): TokenUsage | undefined {
  const extra = finalized?.usage;
  if (!extra) return turnUsage;
  return {
    inputTokens: (turnUsage?.inputTokens ?? 0) + extra.inputTokens,
    outputTokens: (turnUsage?.outputTokens ?? 0) + extra.outputTokens,
    cacheReadTokens: (turnUsage?.cacheReadTokens ?? 0) + (extra.cacheReadTokens ?? 0),
    cacheWriteTokens: (turnUsage?.cacheWriteTokens ?? 0) + (extra.cacheWriteTokens ?? 0),
  };
}
