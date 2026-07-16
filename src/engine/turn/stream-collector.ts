



import type { LLMProvider, StreamEvent, ToolCallBlock, ToolSchema, GenericMessage, TokenUsage, ThinkingBlock } from "../llm/types.js";
import { isContextLengthError } from "../auto-compact.js";
import { stubMarkedToolResults } from "../wire-serialize.js";
import { classifyProviderError } from "../llm/error-classifier.js";
import {
  extractProviderErrorDiagnostics,
  withProviderErrorClassification,
  type ProviderErrorDiagnostics,
} from "../llm/provider-error-diagnostics.js";
import { t } from "../../i18n/index.js";
import { isValidToolUseId } from "../../shared/tool-use-id.js";

export interface StreamCollectParams {
  provider: LLMProvider;
  model: string;
  systemPrompt: string;
  messages: GenericMessage[];
  toolSchemas: ToolSchema[];
  /**
   * Generation policy for this turn. ConversationLoop passes the active
   * vendor block (`llm.vendors[provider]`) merged with the cross-vendor
   * `streamSmoothing` setting from the top-level LLMSettings — this is
   * the only place those two scopes meet.
   *
   * CTRL simplification: per-vendor sampling controls removed. Vendor SDK
   * defaults govern temperature / max output / etc. Only stream smoothing
   * (UX), thinking toggle, and thinking budget remain user-configurable.
   */
  llmSettings: {
    streamSmoothing: "none" | "word" | "char";
    enableThinking: boolean;
    thinkingBudgetTokens: number;
  };
  abortSignal?: AbortSignal;
  /**
   * Forwarded to StreamTurnParams.continuationPrefill — when true the trailing
   * assistant message in `messages` is a partial turn to be CONTINUED (vLLM
   * continue_final_message).
   */
  continuationPrefill?: boolean;

  onReasoningDelta?: (text: string) => void;
  onTextDelta?: (text: string) => void;
}

export type StreamCollectResult =

  | {
      kind: "ok";
      text: string;
      thought: string;
      thinkingBlocks: ThinkingBlock[];
      toolCalls: ToolCallBlock[];
      stopReason: "end_turn" | "tool_use" | "max_tokens";
      usage?: TokenUsage;
    }

  | { kind: "interrupted"; text: string }

  | { kind: "context_error"; errorMessage: string }



  | {
      kind: "stream_error";
      userMessage: string;
      classification: string;
      providerError: ProviderErrorDiagnostics;
    };




export async function collectRoundStream(
  params: StreamCollectParams,
): Promise<StreamCollectResult> {
  const {
    provider,
    model,
    systemPrompt,
    messages,
    toolSchemas,
    llmSettings,
    abortSignal,
    continuationPrefill,
    onReasoningDelta,
    onTextDelta,
  } = params;

  if (abortSignal?.aborted) {
    return { kind: "interrupted", text: "" };
  }

  let text = "";
  let thought = "";
  let thinkingBlocks: ThinkingBlock[] = [];
  const toolCalls: ToolCallBlock[] = [];
  const toolCallIds = new Set<string>();
  let stopReason: "end_turn" | "tool_use" | "max_tokens" = "end_turn";
  let usage: TokenUsage | undefined;
  let sawMessageComplete = false;



  const wireMessages = stubMarkedToolResults(messages);

  try {
    for await (const event of provider.streamTurn({
      model,
      systemPrompt,
      messages: wireMessages,
      tools: toolSchemas.length > 0 ? toolSchemas : undefined,
      streamSmoothing: llmSettings.streamSmoothing as never,
      enableThinking: llmSettings.enableThinking,
      thinkingBudgetTokens: llmSettings.thinkingBudgetTokens,
      ...(continuationPrefill ? { continuationPrefill: true } : {}),
      abortSignal,
    }) as AsyncIterable<StreamEvent>) {
      if (abortSignal?.aborted) return { kind: "interrupted", text };
      switch (event.type) {
        case "reasoning_delta":
          thought += event.text;
          onReasoningDelta?.(event.text);
          break;
        case "text_delta":
          text += event.text;
          onTextDelta?.(event.text);
          break;
        case "tool_call":
          if (!isValidToolUseId(event.id)) {
            return {
              kind: "stream_error",
              userMessage: t("be_streamCollector.streamError", {
                userMessage: "Provider returned an invalid tool call ID.",
              }),
              classification: "unknown",
              providerError: {
                origin: "unknown",
                classification: "unknown",
                messagePreview: "invalid tool_call id in assistant response",
              },
            };
          }
          if (toolCallIds.has(event.id)) {
            return {
              kind: "stream_error",
              userMessage: t("be_streamCollector.streamError", {
                userMessage: "Provider returned duplicate tool call IDs.",
              }),
              classification: "unknown",
              providerError: {
                origin: "unknown",
                classification: "unknown",
                messagePreview: "duplicate tool_call id in one assistant response",
              },
            };
          }
          toolCallIds.add(event.id);
          toolCalls.push({ id: event.id, name: event.name, input: event.input });
          break;
        case "message_complete":
          sawMessageComplete = true;
          stopReason = event.stopReason;
          if (event.thinkingBlocks && event.thinkingBlocks.length > 0) {
            thinkingBlocks = event.thinkingBlocks;
          }
          if (event.usage) usage = event.usage;
          break;
        case "error": {
          if (abortSignal?.aborted) return { kind: "interrupted", text };
          const rawForClassification = event.providerError?.messagePreview ?? event.error;
          if (isContextLengthError(rawForClassification)) {


            return { kind: "context_error", errorMessage: rawForClassification };
          }
          const classified = classifyProviderError(rawForClassification);
          const classification = event.providerError?.classification ?? classified.category;
          const providerError = withProviderErrorClassification(
            event.providerError ?? extractProviderErrorDiagnostics(event.error),
            classification,
          );
          return {
            kind: "stream_error",
            userMessage: t("be_streamCollector.streamError", { userMessage: classified.userMessage }),
            classification,
            providerError,
          };
        }
      }
    }
  } catch (err) {
    if (abortSignal?.aborted || (err instanceof Error && err.name === "AbortError")) {
      return { kind: "interrupted", text };
    }
    if (isContextLengthError(err)) {
      return { kind: "context_error", errorMessage: (err as Error)?.message ?? String(err) };
    }
    const raw = err instanceof Error ? err.message : String(err);
    const classified = classifyProviderError(raw);
    return {
      kind: "stream_error",
      userMessage: t("be_streamCollector.streamError", { userMessage: classified.userMessage }),
      classification: classified.category,
      providerError: withProviderErrorClassification(
        extractProviderErrorDiagnostics(err),
        classified.category,
      ),
    };
  }

  if (abortSignal?.aborted) return { kind: "interrupted", text };
  if (!sawMessageComplete && toolCalls.length > 0) {
    return {
      kind: "stream_error",
      userMessage: t("be_streamCollector.streamEndedWithoutCompletion"),
      classification: "unknown",
      providerError: {
        origin: "unknown",
        classification: "unknown",
        messagePreview: "model stream ended without message_complete after tool_call",
      },
    };
  }

  return {
    kind: "ok",
    text,
    thought,
    thinkingBlocks,
    toolCalls,
    stopReason,
    usage,
  };
}
