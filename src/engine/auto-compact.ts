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
import type { GenericMessage, TokenUsage, LLMVendor } from "./llm/types.js";

// ─── Context Window Registry ─────────────────────────

/**
 * 알려진 모델별 최대 컨텍스트 윈도우 토큰 수.
 * 최신 정보 기준 (2026-04-17): 각 공급사 공식 문서 · API 스펙 참조.
 * 미등록 모델은 getModelContextWindow()에서 DEFAULT_CONTEXT_WINDOW(128K)로 폴백.
 */
const MODEL_CONTEXT_WINDOWS: Partial<Record<LLMVendor, Record<string, number>>> = {
  // ── Anthropic Claude ───────────────────────────────────────────────────────
  // 출처: https://platform.claude.com/docs/en/about-claude/models/overview
  claude: {
    // Claude 4 세대 (2025~2026) — 최신
    "claude-opus-4-6":           1_000_000, // 1M context (2026-02)
    "claude-sonnet-4-6":         1_000_000, // 1M context (2026-02)
    "claude-opus-4-5":             200_000, // 200K (2025-11)
    "claude-sonnet-4-5":           200_000, // 200K (2025-09)
    "claude-haiku-4-5":            200_000, // 200K (2025-10)
    "claude-haiku-4-5-20251001":   200_000,
    "claude-opus-4-20250514":      200_000, // Claude 4 최초 릴리즈 스냅샷
    "claude-sonnet-4-20250514":    200_000, // Claude 4 최초 릴리즈 스냅샷
    // Claude 3.x 세대 (구형 — 하위 호환)
    "claude-3-5-sonnet-20241022":  200_000,
    "claude-3-5-haiku-20241022":   200_000,
    "claude-3-opus-20240229":      200_000,
    "claude-3-sonnet-20240229":    200_000,
    "claude-3-haiku-20240307":     200_000,
  },

  // ── OpenAI ─────────────────────────────────────────────────────────────────
  // 출처: https://platform.openai.com/docs/models
  openai: {
    // GPT-5.4 시리즈 (2026-03) — 최신, 1.05M context
    "gpt-5.4":                   1_050_000,
    "gpt-5.4-pro":               1_050_000,
    "gpt-5.4-mini":              1_050_000,
    "gpt-5.4-nano":              1_050_000,
    // GPT-5.3 (2026) — 400K context
    "gpt-5.3":                     400_000,
    // GPT-5.2 시리즈 (2025-12) — 400K context
    "gpt-5.2":                     400_000,
    "gpt-5.2-codex":               400_000,
    "gpt-5.3-codex":               400_000,
    // GPT-5.1 시리즈 (2025) — 400K context
    "gpt-5.1":                     400_000,
    "gpt-5.1-reasoning":           400_000,
    "gpt-5.1-pro":                 400_000,
    "gpt-5.1-codex":               400_000,
    "gpt-5.1-codex-mini":          400_000,
    "gpt-5.1-codex-max":           400_000,
    // GPT-5 베이스 시리즈 (2025) — 400K context
    "gpt-5":                       400_000,
    "gpt-5-mini":                  400_000,
    "gpt-5-nano":                  400_000,
    // GPT-4.1 시리즈 (2025-04) — 1M context
    "gpt-4.1":                   1_000_000,
    "gpt-4.1-mini":              1_000_000,
    "gpt-4.1-nano":              1_000_000,
    "gpt-4.1-2025-04-14":        1_000_000,
    // o-series 추론 모델 (2025)
    "o3":                          200_000,
    "o3-2025-04-16":               200_000,
    "o4-mini":                     200_000,
    "o4-mini-2025-04-24":          200_000,
    "o1":                          200_000,
    "o1-mini":                     128_000,
    // GPT-4o 시리즈 (128K)
    "gpt-4o":                      128_000,
    "gpt-4o-mini":                 128_000,
    // GPT-4 레거시
    "gpt-4-turbo":                 128_000,
    "gpt-4-32k":                    32_768,
    "gpt-4":                         8_192,
    "gpt-3.5-turbo":                16_385,
  },

  // ── Google Gemini ──────────────────────────────────────────────────────────
  // 출처: https://ai.google.dev/gemini-api/docs/models
  gemini: {
    // Gemini 2.5 시리즈 (2025) — 최신
    "gemini-2.5-pro":            1_000_000,
    "gemini-2.5-flash":          1_000_000,
    "gemini-2.5-flash-lite":       128_000,
    // Gemini 2.0 시리즈 (구형)
    "gemini-2.0-flash":          1_048_576,
    "gemini-2.0-flash-lite":       128_000,
    // Gemini 1.5 시리즈 (레거시)
    "gemini-1.5-pro":            2_097_152,
    "gemini-1.5-flash":          1_048_576,
    "gemini-1.5-flash-8b":       1_048_576,
  },

  // ── GitHub Copilot (github.ai/inference) ───────────────────────────────────
  // 출처: https://docs.github.com/en/copilot/reference/ai-models/supported-models
  copilot: {
    // GPT-5.4 (최신 — 2026-04 기준)
    "gpt-5.4":                   1_050_000,
    "gpt-5.4-mini":              1_050_000,
    // GPT-5.x 시리즈
    "gpt-5.3":                     400_000,
    "gpt-5.2":                     400_000,
    "gpt-5.1":                     400_000,
    "gpt-5.1-codex":               400_000,
    "gpt-5.1-codex-mini":          400_000,
    "gpt-5.1-codex-max":           400_000,
    "gpt-5":                       400_000,
    "gpt-5-mini":                  400_000,
    // GPT-4.1 (2025-05부터 Copilot 기본 모델)
    "gpt-4.1":                   1_000_000,
    "gpt-4.1-mini":              1_000_000,
    // GPT-4o
    "gpt-4o":                      128_000,
    "gpt-4o-mini":                 128_000,
    // Claude (GitHub Models를 통해 접근)
    "claude-opus-4-6":           1_000_000,
    "claude-sonnet-4-6":         1_000_000,
    "claude-opus-4-5":             200_000,
    "claude-sonnet-4-5":           200_000,
    "claude-haiku-4-5":            200_000,
  },
};

/** 벤더/모델 정보가 없을 때 사용하는 기본 컨텍스트 윈도우 크기 */
const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * 벤더·모델 식별자로부터 최대 컨텍스트 윈도우 토큰 수를 반환.
 * 알 수 없는 모델은 DEFAULT_CONTEXT_WINDOW(128K)를 반환.
 *
 * 매칭 순서:
 * 1. 정확히 일치하는 키 (우선)
 * 2. model.startsWith(k) 방향의 프리픽스 중 가장 긴 것 (날짜 suffix 등 변형 대응)
 */
export function getModelContextWindow(vendor: LLMVendor, model: string): number {
  const vendorMap = MODEL_CONTEXT_WINDOWS[vendor];
  if (vendorMap) {
    if (vendorMap[model] !== undefined) return vendorMap[model];
    // 프리픽스 매칭: model이 등록된 키로 시작하는 경우만 허용 (역방향 제외)
    // 여러 키가 매칭되면 가장 구체적인(긴) 키를 선택
    let bestKey: string | undefined;
    for (const k of Object.keys(vendorMap)) {
      if (model.startsWith(k) && (bestKey === undefined || k.length > bestKey.length)) {
        bestKey = k;
      }
    }
    if (bestKey !== undefined) return vendorMap[bestKey];
  }
  return DEFAULT_CONTEXT_WINDOW;
}

// ─── Types ──────────────────────────────────────────

export interface CompactConfig {
  /** 자동 컴팩션 트리거 사용률 임계치 (기본 80%) — 모델 컨텍스트 윈도우 대비 */
  thresholdPct: number;
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
  thresholdPct: 0.8,
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
 *
 * 임계치 = floor(contextWindowTokens × config.thresholdPct).
 * 기본 설정(128K 윈도우, 80%)에서는 102,400 토큰 도달 시 true 반환.
 *
 * @param cumulativeUsage - 누적 토큰 사용량
 * @param contextWindowTokens - 모델의 최대 컨텍스트 윈도우 크기 (미제공 시 128K 기본값)
 * @param config - 컴팩션 설정 (미제공 시 기본값: thresholdPct=0.8)
 *
 * @example
 * // gpt-5.4 (1,050,000 토큰 윈도우), 80% 임계치 → 840,000 토큰 도달 시 압축
 * shouldCompact({ inputTokens: 850_000, outputTokens: 0 }, 1_050_000); // true
 * // gpt-4o (128,000 토큰 윈도우), 80% 임계치 → 102,400 토큰 도달 시 압축
 * shouldCompact({ inputTokens: 80_000, outputTokens: 0 }, 128_000);    // false
 */
export function shouldCompact(
  cumulativeUsage: TokenUsage,
  contextWindowTokens: number = DEFAULT_CONTEXT_WINDOW,
  config: CompactConfig = DEFAULT_CONFIG,
): boolean {
  const threshold = Math.floor(contextWindowTokens * config.thresholdPct);
  return cumulativeUsage.inputTokens >= threshold;
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
