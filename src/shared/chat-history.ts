import type { GenericMessage, MessageMeta } from "../engine/llm/types.js";
import { userContentText } from "../engine/llm/types.js";
import { maskSensitiveData } from "./dlp.js";

export type SerializedHistoryToolCall = {
  id: string;
  name: string;
  input?: Record<string, unknown>;
};

/**
 * Turn-aggregate stats carried on the turn-final assistant message. Mirrors
 * `MessageMeta.turnSummary` 1:1 so the renderer can reconstruct a
 * `kind: "turn_summary"` ChatEntry from persisted state without re-running
 * the conversation loop.
 */
export type SerializedTurnSummary = NonNullable<MessageMeta["turnSummary"]>;

/** Checkpoint metrics carried on the compactBoundary user message. */
export type SerializedCheckpointMeta = NonNullable<MessageMeta["checkpointMeta"]>;

// Exact IPC payload emitted by serializeHistoryMessage() for renderer history
// replay: multimodal content is flattened at the boundary, while persisted
// assistant/tool structure remains available for turn/work reconstruction.
export type SerializedHistoryMessage = {
  index: number;
  role: "user" | "assistant" | "tool_result";
  content: string;
  thought?: string;
  toolCalls?: SerializedHistoryToolCall[];
  toolUseId?: string;
  toolName?: string;
  isError?: boolean;
  /** Wall-clock epoch ms when the message was created (see MessageMeta.createdAt). */
  createdAt?: number;
  /** Turn-aggregate stats — only on turn-final assistant messages. */
  turnSummary?: SerializedTurnSummary;
  /** Checkpoint metrics — only on compactBoundary user messages. */
  checkpointMeta?: SerializedCheckpointMeta;
  /** Issue #911 system-notice marker — assistant entries that are host
   *  notifications, rendered with destructive styling in the UI. */
  systemNotice?: NonNullable<MessageMeta["systemNotice"]>;
};

export function serializeHistoryMessage(
  m: GenericMessage,
  index: number,
): SerializedHistoryMessage {
  const content =
    m.role === "user"
      ? userContentText(m.content)
      : m.role === "tool_result"
        ? maskSensitiveData(m.content).masked
        : m.content;
  const metaFields = {
    ...(m.meta?.createdAt !== undefined ? { createdAt: m.meta.createdAt } : {}),
    ...(m.meta?.turnSummary !== undefined ? { turnSummary: m.meta.turnSummary } : {}),
    ...(m.meta?.checkpointMeta !== undefined ? { checkpointMeta: m.meta.checkpointMeta } : {}),
    ...(m.meta?.systemNotice !== undefined ? { systemNotice: m.meta.systemNotice } : {}),
  };
  const base = {
    index,
    role: m.role,
    // Renderer history replay operates on visible text. Multimodal user
    // content is flattened to the same placeholders used by export/search,
    // while assistant/tool structural fields below are passed through intact.
    content,
    ...metaFields,
  };

  if (m.role === "assistant") {
    return {
      ...base,
      ...(m.thought !== undefined ? { thought: m.thought } : {}),
      ...(m.toolCalls !== undefined ? { toolCalls: m.toolCalls } : {}),
    };
  }

  if (m.role === "tool_result") {
    return {
      ...base,
      toolUseId: m.toolUseId,
      ...(m.toolName !== undefined ? { toolName: m.toolName } : {}),
      ...(m.isError !== undefined ? { isError: m.isError } : {}),
    };
  }

  return base;
}
