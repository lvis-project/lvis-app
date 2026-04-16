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
  claude: "claude-sonnet-4-20250514",
  openai: "gpt-4o",
  gemini: "gemini-2.0-flash",
  copilot: "gpt-4o",
  lgenie: "lgenie-default",
};

// ─── 범용 메시지 ────────────────────────────────────

export type GenericMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; thought?: string; toolCalls?: ToolCallBlock[] }
  | { role: "tool_result"; toolUseId: string; toolName?: string; content: string; isError?: boolean };

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
