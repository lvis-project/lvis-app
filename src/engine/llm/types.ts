/**
 * LLM Provider 범용 인터페이스 — 멀티 벤더 지원
 *
 * Claude, OpenAI, Gemini, Copilot(GitHub Models)
 * 벤더별 tool calling 포맷 차이를 추상화.
 */

// ─── Vendor ─────────────────────────────────────────

export type LLMVendor =
  | "claude"
  | "openai"
  | "gemini"
  | "copilot"
  | "azure-foundry"
  | "vertex-ai";

export const LLM_VENDOR_LABELS: Record<LLMVendor, string> = {
  claude: "Anthropic Claude",
  openai: "OpenAI",
  gemini: "Google Gemini",
  copilot: "GitHub Copilot",
  "azure-foundry": "Azure AI Foundry",
  "vertex-ai": "Google Vertex AI",
};

export const LLM_DEFAULT_MODELS: Record<LLMVendor, string> = {
  claude: "claude-sonnet-4-6",   // Claude Sonnet 4.6 — 1M context (2026-02)
  openai: "gpt-5.4",             // GPT-5.4 — 1.05M context, OpenAI 최신 (2026-03)
  gemini: "gemini-2.5-flash",    // Gemini 2.5 Flash — 1M context (2025)
  copilot: "gpt-4.1",            // GitHub Copilot 기본 모델 (2025-05)
  "azure-foundry": "gpt-4o",     // Azure deployment name — user must override with their own deployment
  "vertex-ai": "gemini-2.5-flash", // Vertex AI uses Gemini models by default
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

/**
 * Claude extended-thinking block preserved verbatim. Both the thinking text and
 * its signature MUST be echoed back in the next request when tool use is still
 * in-flight — otherwise Anthropic rejects the message as tampered.
 */
export interface ThinkingBlock {
  thinking: string;
  signature: string;
}

/**
 * Multimodal user-message content. The string form is retained as a fast path
 * for plain text turns; the array form carries multimodal parts (images, files)
 * that are mapped to vendor-specific content blocks at send time. Image and
 * file payloads are passed as data URLs (`data:<mime>;base64,<...>`) — the
 * renderer/host reads files from disk before populating these parts.
 */
export type UserContentPart =
  | { type: "text"; text: string }
  | { type: "image"; image: string; mimeType?: string }
  | { type: "file"; data: string; mimeType: string };

export type GenericMessage =
  | { role: "user"; content: string | UserContentPart[]; meta?: MessageMeta }
  | { role: "assistant"; content: string; thought?: string; thinkingBlocks?: ThinkingBlock[]; toolCalls?: ToolCallBlock[]; meta?: MessageMeta }
  | { role: "tool_result"; toolUseId: string; toolName?: string; content: string; isError?: boolean; meta?: MessageMeta };

/**
 * Flatten a user-message `content` (string or multimodal parts) into a plain
 * text string for code paths that operate on textual content only — summary
 * extraction, exports, search indexing, etc. Image and file parts are
 * represented by a placeholder so downstream regex/length logic stays sane.
 */
export function userContentText(
  content: string | UserContentPart[],
): string {
  if (typeof content === "string") return content;
  return content
    .map((p) =>
      p.type === "text"
        ? p.text
        : p.type === "image"
          ? `[image:${p.mimeType ?? "image"}]`
          : `[file:${p.mimeType}]`,
    )
    .join("\n");
}

/**
 * Canonical serialized form for message-size / token-estimation logic.
 * Includes all prompt-bearing fields, notably assistant thinkingBlocks,
 * so callers do not undercount context usage when extended thinking is enabled.
 */
export function serializeMessageForEstimation(message: GenericMessage): string {
  switch (message.role) {
    case "user": {
      const contentForEstimation =
        typeof message.content === "string"
          ? message.content
          : message.content.map((p) =>
              p.type === "text" ? p.text : `[${p.type}:${p.type === "image" ? p.mimeType ?? "image" : p.mimeType}]`,
            ).join("\n");
      return JSON.stringify({
        role: message.role,
        content: contentForEstimation,
      });
    }
    case "assistant":
      return JSON.stringify({
        role: message.role,
        content: message.content,
        thought: message.thought ?? "",
        thinkingBlocks: message.thinkingBlocks ?? [],
        toolCalls: message.toolCalls ?? [],
      });
    case "tool_result":
      return JSON.stringify({
        role: message.role,
        toolUseId: message.toolUseId,
        toolName: message.toolName ?? "",
        content: message.content,
        isError: message.isError ?? false,
      });
  }
}


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
  | { type: "message_complete"; stopReason: "end_turn" | "tool_use"; usage?: TokenUsage; thinkingBlocks?: ThinkingBlock[] }
  | { type: "error"; error: string; classification?: string };

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

// ─── Provider 인터페이스 ────────────────────────────

/** Stream-delta smoothing mode (word/char chunking via Vercel smoothStream). */
export type StreamSmoothing = "none" | "word" | "char";

/**
 * CTRL simplification: removed temperature / seed / responseFormat /
 * stopSequences / maxOutputTokens / maxTokens. Modern frontier models
 * (GPT-5+, Claude 4+) deprecate fine-grained sampling — the vendor SDK
 * defaults are the policy. Re-introducing any of these requires a
 * documented architectural reason.
 */
export interface StreamTurnParams {
  model: string;
  systemPrompt: string;
  messages: GenericMessage[];
  tools?: ToolSchema[];
  /** Client-side stream smoothing (word/char chunking via Vercel smoothStream). */
  streamSmoothing?: StreamSmoothing;
  /** Enable extended thinking / reasoning (Claude Sonnet 4.5+, Opus 4+). */
  enableThinking?: boolean;
  /** Token budget for Claude extended thinking (1024–32000). Defaults to 10 000 when enableThinking is true. */
  thinkingBudgetTokens?: number;
  /** Abort signal to cancel the streaming request. Providers forward to the underlying SDK when supported. */
  abortSignal?: AbortSignal;
}

export interface LLMProvider {
  readonly vendor: LLMVendor;
  streamTurn(params: StreamTurnParams): AsyncIterable<StreamEvent>;
}

export interface ProviderConfig {
  vendor: LLMVendor;
  /** API key. Optional for vendor="vertex-ai" (uses service account / ADC). */
  apiKey: string;
  model?: string;
  baseUrl?: string;
  /** Vertex AI — GCP project ID (required for vendor="vertex-ai"). */
  vertexProject?: string;
  /** Vertex AI — GCP region (default "us-central1"). */
  vertexLocation?: string;
}
