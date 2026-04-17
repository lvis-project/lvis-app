/**
 * LLM Provider 범용 인터페이스 — 멀티 벤더 지원
 *
 * Claude, OpenAI, Gemini, Copilot(GitHub Models), lgenie
 * 벤더별 tool calling 포맷 차이를 추상화.
 */

// ─── Vendor ─────────────────────────────────────────

export type LLMVendor = "claude" | "openai" | "gemini" | "copilot" | "lgenie";

export const LLM_VENDOR_LABELS: Record<LLMVendor, string> = {
  claude: "Anthropic Claude",
  openai: "OpenAI",
  gemini: "Google Gemini",
  copilot: "GitHub Copilot",
  lgenie: "LGenie (사내)",
};

export const LLM_DEFAULT_MODELS: Record<LLMVendor, string> = {
  claude: "claude-sonnet-4-6",   // Claude Sonnet 4.6 — 1M context (2026-02)
  openai: "gpt-5.4",             // GPT-5.4 — 1.05M context, OpenAI 최신 (2026-03)
  gemini: "gemini-2.5-flash",    // Gemini 2.5 Flash — 1M context (2025)
  copilot: "gpt-4.1",            // GitHub Copilot 기본 모델 (2025-05)
  lgenie: "lgenie-default",
};

// ─── 범용 메시지 ────────────────────────────────────

/**
 * Optional per-message metadata for lifecycle bookkeeping (auto-compact, microcompact,
 * boundary markers, etc.). All fields optional so existing callers remain unaffected.
 */
export interface ConversationCarryover {
  goals: string[];
  artifacts: string[];
  decisions: string[];
}

export interface MessageMeta {
  /** microcompact가 tool_result content를 stub으로 교체했는지 여부 */
  stripped?: boolean;
  /** stripped 되기 전 원본 content의 문자열 길이(JS string.length — UTF-16 code units, bytes 아님) */
  originalLength?: number;
  /** compactMessages()가 생성한 요약 경계 marker인지 여부 (idempotency) */
  compactBoundary?: boolean;
  /** 경계 marker의 경우, 요약 대상이 된 메시지 수 */
  removedCount?: number;
  /** microcompact strip 발생 ISO timestamp */
  strippedAt?: string;
  /** compactMessages 실행 ISO timestamp */
  compactedAt?: string;
  /** compact boundary 생성 시 추출된 carryover (목표·산출물·결정사항) */
  carryover?: ConversationCarryover;
}

export type GenericMessage =
  | { role: "user"; content: string; meta?: MessageMeta }
  | { role: "assistant"; content: string; thought?: string; toolCalls?: ToolCallBlock[]; meta?: MessageMeta }
  | { role: "tool_result"; toolUseId: string; toolName?: string; content: string; isError?: boolean; meta?: MessageMeta };

export interface ToolCallBlock {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

// ─── 도구 스키마 ────────────────────────────────────

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// ─── 스트리밍 이벤트 ────────────────────────────────

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; input: Record<string, unknown> }
  | { type: "message_complete"; stopReason: "end_turn" | "tool_use"; usage?: TokenUsage }
  | { type: "error"; error: string };

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

// ─── Provider 인터페이스 ────────────────────────────

export interface StreamTurnParams {
  model: string;
  systemPrompt: string;
  messages: GenericMessage[];
  tools?: ToolSchema[];
  maxTokens?: number;
  /** Enable extended thinking / reasoning (Claude Sonnet 4.5+, Opus 4+). */
  enableThinking?: boolean;
  /** Token budget for Claude extended thinking (1024–32000). Defaults to 10 000 when enableThinking is true. */
  thinkingBudgetTokens?: number;
}

export interface LLMProvider {
  readonly vendor: LLMVendor;
  streamTurn(params: StreamTurnParams): AsyncIterable<StreamEvent>;
}

export interface ProviderConfig {
  vendor: LLMVendor;
  apiKey: string;
  model?: string;
  baseUrl?: string;
}
