export type StreamEvent = {
  type: string;
  streamId?: number;
  text?: string;
  thought?: string;
  name?: string;
  error?: string;
  result?: string;
  isError?: boolean;
  input?: Record<string, unknown>;
  groupId?: string;
  toolUseId?: string;
  displayOrder?: number;
  roundIndex?: number;
  stopReason?: "end_turn" | "tool_use";
  hasToolCalls?: boolean;
  removedMessages?: number;
  freedTokens?: number;
  /** MCP Apps spec §3.2 — optional UI payload emitted with tool_end events. */
  uiPayload?: {
    serverId: string;
    resourceUri: string;
    slot?: "chat" | "sidebar" | "tool-result";
    height?: number;
    title?: string;
  };
};

export type ToolEntryItem = {
  toolUseId: string;
  name: string;
  displayOrder: number;
  status: "running" | "done" | "error";
  input?: Record<string, unknown>;
  result?: string;
  /** MCP Apps spec §3.2 — optional UI payload from MCP tool response. */
  uiPayload?: {
    serverId: string;
    resourceUri: string;
    slot?: "chat" | "sidebar" | "tool-result";
    height?: number;
    title?: string;
  };
};

export type ChatEntry =
  | { kind: "user"; text: string }
  | { kind: "reasoning"; text: string; streaming?: boolean }
  | { kind: "assistant"; text: string; streaming?: boolean }
  | { kind: "tool_group"; groupId: string; groupIds: string[]; status: "running" | "done" | "error"; tools: ToolEntryItem[] }
  | { kind: "system"; text: string };

type ReasoningEntry = Extract<ChatEntry, { kind: "reasoning" }>;
type AssistantEntry = Extract<ChatEntry, { kind: "assistant" }>;
type ToolGroupEntry = Extract<ChatEntry, { kind: "tool_group" }>;

export function appendUserEntry(entries: ChatEntry[], text: string): ChatEntry[] {
  return [...entries, { kind: "user", text }];
}

export function upsertStreamingReasoning(
  entries: ChatEntry[],
  text: string,
): ChatEntry[] {
  if (!text) {
    return entries;
  }

  const next = [...entries];
  const reasoningIdx = findLastIdx(
    next,
    (entry): entry is Extract<ChatEntry, { kind: "reasoning" }> =>
      entry.kind === "reasoning" && !!entry.streaming,
  );

  const reasoning = { kind: "reasoning" as const, text, streaming: true };
  if (reasoningIdx >= 0) {
    next[reasoningIdx] = reasoning;
    return next;
  }

  const assistantIdx = findLastIdx(
    next,
    (entry): entry is Extract<ChatEntry, { kind: "assistant" }> =>
      entry.kind === "assistant" && !!entry.streaming,
  );
  if (assistantIdx >= 0) {
    next.splice(assistantIdx, 0, reasoning);
  } else {
    next.push(reasoning);
  }
  return next;
}

export function upsertStreamingAssistant(
  entries: ChatEntry[],
  text: string,
): ChatEntry[] {
  if (!text) {
    return entries;
  }

  const next = [...entries];
  const assistantIdx = findLastIdx(
    next,
    (entry): entry is Extract<ChatEntry, { kind: "assistant" }> =>
      entry.kind === "assistant" && !!entry.streaming,
  );

  const assistant = { kind: "assistant" as const, text, streaming: true };
  if (assistantIdx >= 0) {
    next[assistantIdx] = assistant;
  } else {
    next.push(assistant);
  }
  return next;
}

export function finalizeStreamingReasoning(
  entries: ChatEntry[],
  fallbackText: string,
): ChatEntry[] {
  const next = [...entries];
  const reasoningIdx = findLastIdx(
    next,
    (entry): entry is Extract<ChatEntry, { kind: "reasoning" }> =>
      entry.kind === "reasoning" && !!entry.streaming,
  );

  if (reasoningIdx >= 0) {
    const reasoning = next[reasoningIdx] as ReasoningEntry;
    const text = reasoning.text || fallbackText;
    if (!text) {
      next.splice(reasoningIdx, 1);
      return next;
    }
    next[reasoningIdx] = {
      ...reasoning,
      text,
      streaming: false,
    };
    return next;
  }

  if (!fallbackText) {
    return next;
  }

  const reasoning = {
    kind: "reasoning" as const,
    text: fallbackText,
    streaming: false,
  };
  const assistantIdx = findLastIdx(
    next,
    (entry): entry is Extract<ChatEntry, { kind: "assistant" }> =>
      entry.kind === "assistant" && !!entry.streaming,
  );
  if (assistantIdx >= 0) {
    next.splice(assistantIdx, 0, reasoning);
  } else {
    next.push(reasoning);
  }
  return next;
}

export function finalizeStreamingAssistant(
  entries: ChatEntry[],
  fallbackText: string,
): ChatEntry[] {
  const next = [...entries];
  const assistantIdx = findLastIdx(
    next,
    (entry): entry is Extract<ChatEntry, { kind: "assistant" }> =>
      entry.kind === "assistant" && !!entry.streaming,
  );

  if (assistantIdx >= 0) {
    const assistant = next[assistantIdx] as AssistantEntry;
    const text = assistant.text || fallbackText;
    if (!text) {
      next.splice(assistantIdx, 1);
      return next;
    }
    next[assistantIdx] = {
      ...assistant,
      text,
      streaming: false,
    };
    return next;
  }

  if (!fallbackText) {
    return next;
  }

  next.push({
    kind: "assistant",
    text: fallbackText,
    streaming: false,
  });
  return next;
}

export function reopenLastAssistant(
  entries: ChatEntry[],
): { entries: ChatEntry[]; text: string } {
  const next = [...entries];
  const assistantIdx = findLastIdx(
    next,
    (entry): entry is Extract<ChatEntry, { kind: "assistant" }> =>
      entry.kind === "assistant",
  );
  if (assistantIdx < 0) {
    return { entries, text: "" };
  }
  const assistant = next[assistantIdx] as AssistantEntry;
  next.splice(assistantIdx, 1);
  next.push({
    ...assistant,
    streaming: true,
  });
  return {
    entries: next,
    text: assistant.text,
  };
}

export function setAssistantError(entries: ChatEntry[], message: string, fallbackThought: string = ""): ChatEntry[] {
  const next = finalizeStreamingReasoning(entries, fallbackThought);
  const assistantIdx = findLastIdx(
    next,
    (entry): entry is Extract<ChatEntry, { kind: "assistant" }> =>
      entry.kind === "assistant" && !!entry.streaming,
  );

  if (assistantIdx >= 0) {
    next[assistantIdx] = { kind: "assistant", text: message, streaming: false };
  } else {
    next.push({ kind: "assistant", text: message, streaming: false });
  }
  return next;
}

export function applyToolStart(
  entries: ChatEntry[],
  payload: {
    groupId: string;
    toolUseId: string;
    name: string;
    displayOrder?: number;
    input?: Record<string, unknown>;
  },
): ChatEntry[] {
  const next = [...entries];
  let groupIdx = findLastIdx(
    next,
    (entry): entry is Extract<ChatEntry, { kind: "tool_group" }> =>
      entry.kind === "tool_group" && entry.groupIds.includes(payload.groupId),
  );
  const adjacentGroupIdx = getAdjacentToolGroupIndex(next);

  const tool: ToolEntryItem = {
    toolUseId: payload.toolUseId,
    name: payload.name,
    displayOrder: payload.displayOrder ?? 0,
    status: "running",
    input: payload.input,
  };

  if (groupIdx >= 0) {
    const group = next[groupIdx] as ToolGroupEntry;
    const toolIdx = group.tools.findIndex((entry: ToolEntryItem) => entry.toolUseId === payload.toolUseId);
    const tools =
      toolIdx >= 0
        ? group.tools.map((entry: ToolEntryItem, index: number) => (index === toolIdx ? tool : entry))
        : [...group.tools, tool];

    next[groupIdx] = { ...group, status: "running", tools };
    return next;
  }

  if (adjacentGroupIdx >= 0) {
    const group = next[adjacentGroupIdx] as ToolGroupEntry;
    const groupIds = group.groupIds.includes(payload.groupId)
      ? group.groupIds
      : [...group.groupIds, payload.groupId];
    next[adjacentGroupIdx] = {
      ...group,
      groupIds,
      status: "running",
      tools: [...group.tools, tool],
    };
    return next;
  }

  const newGroup: ToolGroupEntry = {
    kind: "tool_group",
    groupId: payload.groupId,
    groupIds: [payload.groupId],
    status: "running",
    tools: [tool],
  };

  next.push(newGroup);
  return next;
}

export function applyToolEnd(
  entries: ChatEntry[],
  payload: {
    groupId: string;
    toolUseId: string;
    result?: string;
    isError?: boolean;
    uiPayload?: ToolEntryItem["uiPayload"];
  },
): ChatEntry[] {
  const next = [...entries];
  const groupIdx = findLastIdx(
    next,
    (entry): entry is Extract<ChatEntry, { kind: "tool_group" }> =>
      entry.kind === "tool_group" && entry.groupIds.includes(payload.groupId),
  );
  if (groupIdx < 0) {
    return entries;
  }

  const group = next[groupIdx] as ToolGroupEntry;
  const tools = group.tools.map((tool: ToolEntryItem) =>
    tool.toolUseId === payload.toolUseId
      ? {
          ...tool,
          status: (payload.isError ? "error" : "done") as "done" | "error",
          result: payload.result,
          ...(payload.uiPayload && { uiPayload: payload.uiPayload }),
        }
      : tool,
  );
  const stillRunning = tools.some((tool: ToolEntryItem) => tool.status === "running");
  next[groupIdx] = { ...group, status: stillRunning ? "running" : "done", tools };
  return next;
}

function findLastIdx<T>(items: T[], predicate: (value: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) {
      return index;
    }
  }
  return -1;
}

function getAdjacentToolGroupIndex(entries: ChatEntry[]): number {
  if (entries[entries.length - 1]?.kind === "tool_group") {
    return entries.length - 1;
  }
  return -1;
}
