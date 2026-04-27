/**
 * §4.5.3 LLM stream collection — round 단위 스트리밍을 순수 비동기 함수로 감쌌다.
 *
 * 한 round 동안 `LLMProvider.streamTurn()` 이 뿜는 이벤트를 누적해
 * text / reasoning / thinkingBlocks / tool_call / usage / stopReason 을 모은다.
 *
 * 호출자는:
 *   - `history` append (assistant round commit)
 *   - reactive compact 재시도 분기
 *   - callbacks 트리거 (onAssistantRound 등)
 * 를 담당한다. 본 모듈은 LLM 추상화 + 에러 분류 + abort 처리만 관여.
 */
import type { LLMProvider, StreamEvent, ToolCallBlock, ToolSchema, GenericMessage, TokenUsage, ThinkingBlock } from "../llm/types.js";
import { isContextLengthError } from "../auto-compact.js";
import { classifyProviderError } from "../llm/error-classifier.js";

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
   */
  llmSettings: {
    maxOutputTokens: number;
    temperature: number;
    seed?: number;
    responseFormat: "text" | "json";
    stopSequences: string[];
    streamSmoothing: "none" | "word" | "char";
    enableThinking: boolean;
    thinkingBudgetTokens: number;
  };
  abortSignal?: AbortSignal;
  /** stream 이벤트 콜백 — UI 로 delta 방출. */
  onReasoningDelta?: (text: string) => void;
  onTextDelta?: (text: string) => void;
  /**
   * reactive compact 후 재시도 여부. true 면 context-length error 를
   * retry 신호(streamContextError) 로 반환하지 않고 최종 에러로 취급한다.
   */
  reactiveCompacted: boolean;
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
  | { kind: "stream_error"; userMessage: string };

/**
 * 한 round 의 stream 을 소비한다.
 *
 * 이 함수는 usage 토큰을 **자체 누적하지 않는다** (호출자가 `usage` 필드를
 * 받아 cumulativeUsage 에 반영). 덕분에 reactive compact 재시도 시 double-count
 * 위험이 사라진다.
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
    reactiveCompacted,
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

  try {
    for await (const event of provider.streamTurn({
      model,
      systemPrompt,
      messages,
      tools: toolSchemas.length > 0 ? toolSchemas : undefined,
      maxTokens: llmSettings.maxOutputTokens,
      maxOutputTokens: llmSettings.maxOutputTokens,
      temperature: llmSettings.temperature,
      seed: llmSettings.seed,
      responseFormat: llmSettings.responseFormat as never,
      stopSequences: llmSettings.stopSequences,
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
          stopReason = event.stopReason;
          if (event.thinkingBlocks && event.thinkingBlocks.length > 0) {
            thinkingBlocks = event.thinkingBlocks;
          }
          if (event.usage) usage = event.usage;
          break;
        case "error": {
          if (abortSignal?.aborted) return { kind: "interrupted", text };
          if (isContextLengthError(event.error) && !reactiveCompacted) {
            return { kind: "context_error", errorMessage: event.error };
          }
          const classified = classifyProviderError(event.error);
          const userMsg = reactiveCompacted && isContextLengthError(event.error)
            ? `오류: 대화 기록을 압축한 뒤에도 모델 컨텍스트 한도를 초과했습니다. 새 세션을 시작하거나 이전 첨부를 정리해 주세요 (원인: ${event.error})`
            : `오류: ${classified.userMessage}`;
          return { kind: "stream_error", userMessage: userMsg };
        }
      }
    }
  } catch (err) {
    if (abortSignal?.aborted || (err instanceof Error && err.name === "AbortError")) {
      return { kind: "interrupted", text };
    }
    if (isContextLengthError(err) && !reactiveCompacted) {
      return { kind: "context_error", errorMessage: (err as Error)?.message ?? String(err) };
    }
    throw err;
  }

  if (abortSignal?.aborted) return { kind: "interrupted", text };

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
