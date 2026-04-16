/**
 * Auto-Compact — claw-code 패턴: 토큰 기반 컨텍스트 관리
 *
 * 대화가 길어지면 히스토리 토큰이 컨텍스트 윈도우를 초과.
 * 자동으로 오래된 메시지를 요약하여 공간 확보.
 *
 * 핵심 원칙:
 * - tool_use/tool_result 쌍은 절대 분리하지 않음
 * - 최근 N개 메시지는 보존 (기본 4)
 * - 요약은 파일 참조, 진행 중인 작업, 핵심 결정을 보존
 */
import type { GenericMessage, TokenUsage } from "./llm/types.js";

// ─── Types ──────────────────────────────────────────

export interface CompactConfig {
  /** 자동 컴팩션 트리거 토큰 수 (기본 80K) */
  thresholdTokens: number;
  /** 보존할 최근 메시지 수 (기본 4) */
  preserveRecentMessages: number;
  /** 요약 최대 토큰 예산 (기본 2K) */
  summaryBudgetTokens: number;
}

export interface CompactResult {
  /** 컴팩션 수행 여부 */
  compacted: boolean;
  /** 제거된 메시지 수 */
  removedMessages: number;
  /** 생성된 요약 */
  summary?: string;
  /** 확보된 예상 토큰 수 */
  freedTokens: number;
}

const DEFAULT_CONFIG: CompactConfig = {
  thresholdTokens: 80_000,
  preserveRecentMessages: 4,
  summaryBudgetTokens: 2_000,
};

// ─── Token Estimation ───────────────────────────────

/** 텍스트의 토큰 수 추정 (claw-code 방식: length/4 + 1) */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4) + 1;
}

/** 메시지 배열의 총 토큰 추정 */
export function estimateMessagesTokens(messages: GenericMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateTokens(msg.content);
    if (msg.role === "assistant") {
      if (msg.thought) {
        total += estimateTokens(msg.thought);
      }
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          total += estimateTokens(JSON.stringify(tc.input));
        }
      }
    }
  }
  return total;
}

// ─── Compact Logic ──────────────────────────────────

/**
 * 컴팩션 필요 여부 확인
 */
export function shouldCompact(
  cumulativeUsage: TokenUsage,
  config: CompactConfig = DEFAULT_CONFIG,
): boolean {
  return cumulativeUsage.inputTokens >= config.thresholdTokens;
}

/**
 * 메시지 배열을 컴팩션 — 오래된 메시지를 요약으로 교체
 *
 * @returns 컴팩션된 메시지 배열 + 결과 정보
 */
export function compactMessages(
  messages: GenericMessage[],
  config: CompactConfig = DEFAULT_CONFIG,
): { messages: GenericMessage[]; result: CompactResult } {
  if (messages.length <= config.preserveRecentMessages) {
    return { messages, result: { compacted: false, removedMessages: 0, freedTokens: 0 } };
  }

  // 보존할 메시지 경계 찾기
  const preserveFrom = findSafeBoundary(messages, messages.length - config.preserveRecentMessages);
  const toCompact = messages.slice(0, preserveFrom);
  const toPreserve = messages.slice(preserveFrom);

  if (toCompact.length === 0) {
    return { messages, result: { compacted: false, removedMessages: 0, freedTokens: 0 } };
  }

  // 요약 생성
  const summary = generateSummary(toCompact, config.summaryBudgetTokens);
  const freedTokens = estimateMessagesTokens(toCompact) - estimateTokens(summary);

  // 요약 메시지 + 보존 메시지
  const compactedMessages: GenericMessage[] = [
    { role: "user", content: `[이전 대화 요약]\n${summary}` },
    { role: "assistant", content: "이전 대화 내용을 확인했습니다. 계속 도와드리겠습니다." },
    ...toPreserve,
  ];

  return {
    messages: compactedMessages,
    result: {
      compacted: true,
      removedMessages: toCompact.length,
      summary,
      freedTokens: Math.max(0, freedTokens),
    },
  };
}

// ─── Private Helpers ────────────────────────────────

/**
 * tool_use/tool_result 쌍이 분리되지 않는 안전한 경계 찾기
 * claw-code 패턴: 경계가 tool_result 안에 있으면 뒤로 밀어냄
 */
function findSafeBoundary(messages: GenericMessage[], idealBoundary: number): number {
  let boundary = idealBoundary;

  // 경계가 tool_result면 해당 tool_use까지 포함되도록 뒤로 이동
  while (boundary > 0 && boundary < messages.length) {
    const msg = messages[boundary];
    if (msg.role === "tool_result") {
      boundary--;
    } else if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
      // assistant의 tool_call과 그 결과가 함께 보존되어야 함
      boundary--;
    } else {
      break;
    }
  }

  return Math.max(0, boundary);
}

/**
 * 메시지 배열에서 요약 생성 (LLM 없이 추출 기반)
 * claw-code 패턴: 파일 참조, 진행 중 작업, 핵심 결정 보존
 */
function generateSummary(messages: GenericMessage[], budgetTokens: number): string {
  const sections: string[] = [];

  // 1. 사용자 요청 요약
  const userRequests = messages
    .filter((m) => m.role === "user" && !m.content.startsWith("[이전 대화 요약]"))
    .map((m) => m.content.slice(0, 100));
  if (userRequests.length > 0) {
    sections.push(`## 사용자 요청\n${userRequests.map((r) => `- ${r}`).join("\n")}`);
  }

  // 2. 도구 사용 이력
  const toolUses = messages
    .filter((m): m is GenericMessage & { role: "assistant"; toolCalls: NonNullable<(GenericMessage & { role: "assistant" })["toolCalls"]> } =>
      m.role === "assistant" && !!m.toolCalls && m.toolCalls.length > 0)
    .flatMap((m) => m.toolCalls.map((tc) => tc.name));
  if (toolUses.length > 0) {
    const unique = [...new Set(toolUses)];
    sections.push(`## 사용된 도구\n${unique.join(", ")}`);
  }

  // 3. 핵심 응답 요약 (마지막 assistant 메시지에서)
  const assistantMessages = messages.filter((m) => m.role === "assistant" && m.content.length > 20);
  if (assistantMessages.length > 0) {
    const lastFew = assistantMessages.slice(-2);
    const summaries = lastFew.map((m) => m.content.slice(0, 200));
    sections.push(`## 주요 응답\n${summaries.map((s) => `- ${s}...`).join("\n")}`);
  }

  let result = sections.join("\n\n");

  // 토큰 예산 내로 자르기
  const maxChars = budgetTokens * 4;
  if (result.length > maxChars) {
    result = result.slice(0, maxChars) + "\n...(잘림)";
  }

  return result || "이전 대화 내용이 있었습니다.";
}
