export type StreamEvent = {
  type: string;
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
};

export type ToolEntryItem = {
  toolUseId: string;
  name: string;
  displayOrder: number;
  status: "running" | "done" | "error";
  input?: Record<string, unknown>;
  result?: string;
};

export type ChatEntry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; thought?: string; streaming?: boolean }
  | { kind: "tool_group"; groupId: string; groupIds: string[]; status: "running" | "done" | "error"; tools: ToolEntryItem[] };

type AssistantEntry = Extract<ChatEntry, { kind: "assistant" }>;
type ToolGroupEntry = Extract<ChatEntry, { kind: "tool_group" }>;

export function appendUserEntry(entries: ChatEntry[], text: string): ChatEntry[] {
  return [...entries, { kind: "user", text }];
}

export function upsertStreamingAssistant(
  entries: ChatEntry[],
  text: string,
  thought: string,
): ChatEntry[] {
  const next = [...entries];
  const assistantIdx = findLastIdx(
    next,
    (entry): entry is Extract<ChatEntry, { kind: "assistant" }> =>
      entry.kind === "assistant" && !!entry.streaming,
  );

  const assistant = { kind: "assistant" as const, text, thought, streaming: true };
  if (assistantIdx >= 0) {
    next[assistantIdx] = assistant;
  } else {
    next.push(assistant);
  }
  return next;
}

export function finalizeStreamingAssistant(
  entries: ChatEntry[],
  fallbackText: string,
  fallbackThought: string,
): ChatEntry[] {
  const next = [...entries];
  const assistantIdx = findLastIdx(
    next,
    (entry): entry is Extract<ChatEntry, { kind: "assistant" }> =>
      entry.kind === "assistant" && !!entry.streaming,
  );

  if (assistantIdx >= 0) {
    const assistant = next[assistantIdx] as AssistantEntry;
    next[assistantIdx] = {
      ...assistant,
      text: assistant.text || fallbackText,
      thought: assistant.thought || fallbackThought,
      streaming: false,
    };
    return next;
  }

  if (!fallbackText && !fallbackThought) {
    return next;
  }

  next.push({
    kind: "assistant",
    text: fallbackText,
    thought: fallbackThought,
    streaming: false,
  });
  return next;
}

export function setAssistantError(entries: ChatEntry[], message: string): ChatEntry[] {
  const next = [...entries];
  const assistantIdx = findLastIdx(
    next,
    (entry): entry is Extract<ChatEntry, { kind: "assistant" }> =>
      entry.kind === "assistant" && !!entry.streaming,
  );

  if (assistantIdx >= 0) {
    next[assistantIdx] = { kind: "assistant", text: message, thought: "", streaming: false };
  } else {
    next.push({ kind: "assistant", text: message, thought: "", streaming: false });
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
  const assistantIdx = findLastIdx(
    next,
    (entry): entry is Extract<ChatEntry, { kind: "assistant" }> =>
      entry.kind === "assistant" && !!entry.streaming,
  );
  let groupIdx = findLastIdx(
    next,
    (entry): entry is Extract<ChatEntry, { kind: "tool_group" }> =>
      entry.kind === "tool_group" && entry.groupIds.includes(payload.groupId),
  );
  const adjacentGroupIdx = getAdjacentToolGroupIndex(next, assistantIdx);

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

    if (assistantIdx >= 0 && groupIdx > assistantIdx) {
      next.splice(groupIdx, 1);
      next.splice(assistantIdx, 0, { ...group, status: "running", tools });
      return next;
    }

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

  if (assistantIdx >= 0) {
    next.splice(assistantIdx, 0, newGroup);
  } else {
    next.push(newGroup);
  }
  return next;
}

export function applyToolEnd(
  entries: ChatEntry[],
  payload: {
    groupId: string;
    toolUseId: string;
    result?: string;
    isError?: boolean;
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

function getAdjacentToolGroupIndex(entries: ChatEntry[], assistantIdx: number): number {
  if (assistantIdx > 0 && entries[assistantIdx - 1]?.kind === "tool_group") {
    return assistantIdx - 1;
  }
  if (assistantIdx < 0 && entries[entries.length - 1]?.kind === "tool_group") {
    return entries.length - 1;
  }
  return -1;
}
