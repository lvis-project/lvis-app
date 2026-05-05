import type { GenericMessage } from "../engine/llm/types.js";
import { userContentText } from "../engine/llm/types.js";

export type SerializedHistoryToolCall = {
  id: string;
  name: string;
  input?: Record<string, unknown>;
};

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
};

export function serializeHistoryMessage(
  m: GenericMessage,
  index: number,
): SerializedHistoryMessage {
  const base = {
    index,
    role: m.role,
    // Renderer history replay operates on visible text. Multimodal user
    // content is flattened to the same placeholders used by export/search,
    // while assistant/tool structural fields below are passed through intact.
    content: m.role === "user" ? userContentText(m.content) : m.content,
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
