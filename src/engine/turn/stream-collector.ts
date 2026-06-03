/**
 * §4.5.3 LLM stream collection — round 단위 스트리밍을 순수 비동기 함수로 감쌌다.
 *
 * 한 round 동안 `LLMProvider.streamTurn()` 이 뿜는 이벤트를 누적해
 * text / reasoning / thinkingBlocks / tool_call / usage / stopReason 을 모은다.
 *
 * 호출자는:
 *   - `history` append (assistant round commit)
 *   - context_error / stream_error / interrupted 결과 처리 (token preflight 후 도달 시 사용자 안내)
 *   - callbacks 트리거 (onAssistantRound 등)
 * 를 담당한다. 본 모듈은 LLM 추상화 + 에러 분류 + abort 처리만 관여.
 *
 * Reactive compact retry is intentionally absent —
 * token preflight (`runPreflightGuard`) 가 사전 차단하므로 mid-loop 압축 retry 불필요.
 * estimator drift 로 도달 시 호출자가 사용자 안내 + turn 종료.
 */
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
  /** stream 이벤트 콜백 — UI 로 delta 방출. */
  onReasoningDelta?: (text: string) => void;
  onTextDelta?: (text: string) => void;
}

export type StreamCollectResult =
  /** 정상 round — assistant 응답 및 tool_use 목록 포함. */
  | {
      kind: "ok";
      text: string;
      thought: string;
      thinkingBlocks: ThinkingBlock[];
      toolCalls: ToolCallBlock[];
      stopReason: "end_turn" | "tool_use";
      usage?: TokenUsage;
    }
  /** 외부 abort 로 중단됨 — 부분 텍스트 반환. */
  | { kind: "interrupted"; text: string }
  /** stream 중 context-length error — 호출자가 compact 후 재시도. */
  | { kind: "context_error"; errorMessage: string }
  /**
   * 그 외 스트림 에러 — classifyProviderError 결과 문자열 포함.
   * 호출자가 history + onError 처리.
   */
  | {
      kind: "stream_error";
      userMessage: string;
      classification: string;
      providerError: ProviderErrorDiagnostics;
    };

/**
 * 한 round 의 stream 을 소비한다.
 *
 * 이 함수는 usage 토큰을 **자체 누적하지 않는다** (호출자가 `usage` 필드를
 * 받아 cumulativeUsage 에 반영) — turn 단위 합산 책임을 호출자에게 둠.
 */
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
  let stopReason: "end_turn" | "tool_use" = "end_turn";
  let usage: TokenUsage | undefined;
  let sawMessageComplete = false;

  // Provider 호출 직전에 marked tool_result 를 stub 으로 변환.
  // memory 의 verbatim history 와 wire format 을 분리 — single source of truth.
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
            // Token preflight 가 사전 차단하지만 estimator drift 시 도달.
            // 호출자 (queryLoop) 는 사용자 안내 후 turn 종료 — retry 없음.
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
