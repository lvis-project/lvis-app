




// ─── Vendor ─────────────────────────────────────────

// Single source of truth for the vendor union lives in
// `src/shared/llm-vendor-defaults.ts` — that's the same module the
// settings store uses to validate `provider` at IPC boundaries. We
// re-export here so existing engine-side callers keep their import
// path while the type definition cannot drift between modules.
import {
  type LLMVendor,
} from "../../shared/llm-vendor-defaults.js";
import type { MarketplaceInstalledProviderPreset } from "../../shared/marketplace-package-assets.js";
import type { ToolResultImage } from "../../tools/types.js";
import type { ProviderErrorDiagnostics } from "./provider-error-diagnostics.js";
export type { LLMVendor };
export { isLLMVendor } from "../../shared/llm-vendor-defaults.js";

/**
 * Optional per-message metadata for lifecycle bookkeeping (auto-compact, mark-stale,
 * boundary markers, etc.). All fields optional so existing callers remain unaffected.
 */
export interface MessageMeta {
  /**
   * User-visible text for this message. The stored `content` may include
   * routing/provenance wrappers that are prompt-bearing but must not be
   * replayed as the user's own visible bubble.
   */
  displayText?: string;
  /** Host-minted nonce for rollbackable injected rows across history cloning. */
  hostInjectionId?: string;
  /** Skill routing provenance for a user turn. */
  routeSkill?: { skillId: string };
  /** Structured provenance for plugin/proactive imported trigger turns. */
  importedTrigger?: {
    sessionId: string;
    source: string;
    prompt: string;
    summary: string;
    toolCallCount: number;
    importedAt: string;
  };
  /** Renderer display metadata for tool_result replay parity. */
  toolDisplay?: {
    durationMs?: number;
    source?: "builtin" | "plugin" | "mcp";
    category?: "read" | "write" | "shell" | "network" | "meta";
    pluginId?: string;
    mcpServerId?: string;
    uiPayload?: import("../../mcp/types.js").McpUiPayload;
  };



  compactedAt?: string;
  /** Compact boundary marker (idempotency + revert anchor) */
  compactBoundary?: boolean;

  removedCount?: number;
  /** Compact boundary #N in the numbered checkpoint chain. */
  compactNum?: number;

  lock?: boolean;



  serializedStub?: boolean;



  systemNotice?: "context-error" | "stream-error" | "interrupted";
  /**
   * Tool-result generic size cap marker (Issue #902).
   *
   * Set by `ConversationHistory.append`/`restore` on tool_result messages
   * whose raw content exceeds `MAX_TOOL_RESULT_LINES` or
   * `MAX_TOOL_RESULT_TOKENS` (shared/tool-result-trim.ts). The in-memory
   * `content` stays raw verbatim; this field records the original size so
   * provider serialization can substitute a stub and session persistence can
   * keep the raw payload in a file-backed artifact.
   *
   * Why a separate marker from `compactedAt`: compactedAt means "the LLM
   * summarized this turn"; truncated means "host enforced a per-result
   * size cap because a single tool returned an outsized payload that
   * would blow the next-turn TPM/context window". Different lifecycle,
   * different recovery semantics.
   */
  truncated?: {
    originalLines: number;
    originalTokens: number;
    originalBytes: number;
    trimmedAt: string;
  };
  /**
   * Set when a host-truncated tool_result was too large to retain as a local
   * file-backed artifact. The JSONL stub remains small and explicit, but
   * read_tool_result_chunk cannot recover the original payload after reload.
   */
  artifactUnavailable?: {
    reason: "artifact-too-large";
    maxBytes: number;
  };
  /**
   * Per-turn Persona prompt selection selected by the user for this user
   * message. Stores only prompt-store identity metadata; retry/edit-resend
   * re-resolves the current prompt body from `PersonaPromptStore`.
   */
  activePersonaPrompt?: { id: string; name: string };



  boundary?: import("../structured-compact.js").CompactBoundary;
  /**
   * Wall-clock when the message was generated (Date.now() epoch ms). Stamped
   * by ConversationHistory.append() so every persisted message carries its
   * original creation time. Optional for backward compat — sessions written
   * before this field existed have no createdAt; UI must render *nothing*
   * rather than fake the current time.
   */
  createdAt?: number;
  /**
   * Turn-aggregate stats — present ONLY on the turn-final assistant message
   * (the one whose stopReason ended the turn). Carries the same payload the
   * live `onTurnSummary` callback emits so the renderer can rebuild the
   * `kind: "turn_summary"` ChatEntry on session reload without re-running the
   * conversation loop. Persisted alongside the message so TokenCostBadge +
   * TurnActionBar show real numbers (not zeros) on historical sessions.
   */
  turnSummary?: {
    turnDurationMs: number;
    toolCount: number;
    cumulativeToolMs: number;
    /**
     * Engine-projected next request input. This is the single context-fill SOT
     * used by TokenProgressRing and the turn footer.
     */
    tokensIn: number;
    /** Sum of per-round (input − cacheRead − cacheWrite). Always set by the
     * live conversation-loop emit, so required for any persisted turnSummary. */
    freshInputTokens: number;
    tokensOut: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    /** Provider/model that actually served this turn, after fallback resolution. */
    vendorProvider?: LLMVendor;
    vendorModel?: string;
    /**
     * Per provider request usage segments. Kept unmerged so surcharge-sensitive
     * pricing (for example OpenAI long-context request tiers) is computed at
     * the same granularity the provider bills.
     */
    usageByModel?: TokenUsageByModel[];
    breakdown?: Record<string, { count: number; ms: number }>;
  };
  /**
   * Checkpoint metrics — present ONLY on the compactBoundary user message
   * created by structured-compact. Lets historyToEntries reconstruct the
   * `kind: "checkpoint"` divider with the right counts on reload.
   * Trigger union matches CheckpointTrigger in `src/lib/chat-stream-state.ts`.
   */
  checkpointMeta?: {
    removedMessages: number;
    freedTokens: number;
    /** Post-compact context-fill SOT attached to the compact boundary. */
    contextTokensAfter?: number;
    compactNum?: number;
    trigger?: "auto-compact" | "manual";
    compactStatus?: "summarized" | "content_truncated" | "noop" | "reduced_insufficient_forced";
    summary?: string;
    truncatedDir?: string;
  };
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
  | { type: "image"; image: string; mimeType?: string; width?: number; height?: number; bytes?: number }
  | { type: "file"; data: string; mimeType: string };

export type GenericMessage =
  | { role: "user"; content: string | UserContentPart[]; meta?: MessageMeta }
  | { role: "assistant"; content: string; thought?: string; thinkingBlocks?: ThinkingBlock[]; toolCalls?: ToolCallBlock[]; meta?: MessageMeta }
  | { role: "tool_result"; toolUseId: string; toolName?: string; content: string; isError?: boolean; image?: ToolResultImage; meta?: MessageMeta };

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
    additionalProperties?: boolean;
    required?: string[];
  };
}

// ─── 스트리밍 이벤트 ────────────────────────────────

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; input: Record<string, unknown> }
  | { type: "message_complete"; stopReason: "end_turn" | "tool_use" | "max_tokens"; usage?: TokenUsage; thinkingBlocks?: ThinkingBlock[] }
  | {
      type: "error";
      error: string;
      classification?: string;
      providerError?: ProviderErrorDiagnostics;
    };

export interface TokenUsage {
  /**
   * AI SDK-normalized provider usage. In AI SDK v6 this is total prompt input,
   * including cached tokens; callers that persist cost records must normalize
   * through `normalizeAiSdkUsageForCost` before using `computeCost`.
   */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface TokenUsageByModel {
  vendorProvider: LLMVendor;
  vendorModel: string;
  tokenUsage: TokenUsage;
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
  /**
   * finish_reason=length CONTINUATION. When true, the FINAL message in
   * `messages` is a partial assistant turn the model must CONTINUE verbatim
   * (not restart). Only the openai-compatible (vLLM) path acts on it today —
   * it sets `continue_final_message:true` + `add_generation_prompt:false` so
   * vLLM re-opens the trailing assistant message with zero seam tokens. Other
   * vendors ignore it (see vendorSupportsLengthContinuation).
   */
  continuationPrefill?: boolean;
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
  /**
   * Optional fetch implementation for SDK-backed providers that need the
   * Electron main-process network stack. Production boot currently wires this
   * only for Azure Foundry private-endpoint host mappings.
   */
  fetch?: typeof fetch;
  /** Vertex AI — GCP project ID (required for vendor="vertex-ai"). */
  vertexProject?: string;
  /** Vertex AI — GCP region (default "us-central1"). */
  vertexLocation?: string;
  /**
   * Marketplace/provider-package metadata selected at settings time. Runtime
   * adapters can use this to honor catalog-owned base URLs, auth policy,
   * model discovery, capability flags, and trust metadata without branching on
   * static OpenAI-compatible preset ids.
   */
  providerMetadata?: MarketplaceInstalledProviderPreset;
}
