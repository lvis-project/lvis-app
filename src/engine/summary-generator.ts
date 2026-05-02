/**
 * Summary Generator — PR-4 3-tier rotation
 *
 * OpenCode 패턴 기반 별도 LLM call.
 * 체크포인트 전환 시 직전 세그먼트를 압축하여 rolling summary preamble 생성.
 */

import type { LLMProvider, GenericMessage } from "./llm/types.js";
import { userContentText } from "./llm/types.js";

/**
 * LLM을 사용하여 메시지 배열에서 rolling summary를 생성한다.
 * - OpenCode 패턴: 별도 단발 LLM call (specialized agent style)
 * - 결과: rolling summary preamble (max ~3200 chars / ~800 tokens)
 * - 빈 messages → "" 반환
 */
export async function generateSummary(
  llm: LLMProvider,
  messages: GenericMessage[],
  options?: { maxTokens?: number; model?: string },
): Promise<string> {
  if (messages.length === 0) return "";

  const maxTokens = options?.maxTokens ?? 800;

  // 메시지 배열을 텍스트로 직렬화
  const conversationText = messages
    .map((msg) => {
      if (msg.role === "user") {
        return `사용자: ${userContentText(msg.content).slice(0, 300)}`;
      } else if (msg.role === "assistant") {
        return `어시스턴트: ${msg.content.slice(0, 300)}`;
      }
      return null;
    })
    .filter((line): line is string => line !== null)
    .join("\n");

  if (!conversationText.trim()) return "";

  const prompt = `다음 대화를 핵심 정보 보존하면서 한국어로 요약하세요. 액션아이템, 결정사항, 미해결 토픽 우선:\n\n${conversationText}`;

  let text = "";
  for await (const ev of llm.streamTurn({
    model: options?.model ?? await resolveModel(llm),
    systemPrompt: "당신은 대화 요약 전문가입니다. 핵심 정보를 간결하게 보존하는 요약을 작성하세요.",
    messages: [{ role: "user", content: prompt }],
    tools: [],
  })) {
    if (ev.type === "text_delta" && ev.text) {
      text += ev.text;
      // max_tokens 초과 방지: 대략 4자 = 1 token
      if (text.length > maxTokens * 4) break;
    }
    if (ev.type === "message_complete") break;
    if (ev.type === "error") {
      throw new Error(`summary LLM error: ${ev.error}`);
    }
  }

  const result = text.trim().slice(0, maxTokens * 4);
  return result;
}

/**
 * Provider의 vendor로 기본 모델명 결정.
 * options.model 이 제공된 경우 이 함수는 호출되지 않는다.
 * 호출자(ConversationLoop)는 항상 user-configured model 을 options.model 로 전달해야 하며,
 * 이 함수는 model 이 생략된 테스트/하위 호환 경로에서만 실행된다.
 */
async function resolveModel(llm: LLMProvider): Promise<string> {
  // LLMProvider.vendor로 vendor 기본 모델 선택 (LLM_DEFAULT_MODELS 정의 기준)
  const { LLM_DEFAULT_MODELS } = await import("./llm/types.js");
  return LLM_DEFAULT_MODELS[llm.vendor] ?? "claude-sonnet-4-6";
}

/**
 * 컨텍스트 사용률이 낮을 때 요약을 건너뛸지 결정.
 * 비용 > 효용 임계점 = 0.10 (사용자 결정).
 * ctxUsage < 0.10 이면 요약 불필요.
 */
export function shouldSkipSummary(ctxUsage: number): boolean {
  return ctxUsage < 0.10;
}
