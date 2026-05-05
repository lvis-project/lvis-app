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
