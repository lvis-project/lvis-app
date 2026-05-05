// Phase 2: persisted-history → renderer-entries rebuild.

import {
  applyToolEnd,
  applyToolStart,
  finalizeStreamingAssistant,
  finalizeStreamingReasoning,
  type ChatEntry,
} from "../../../lib/chat-stream-state.js";

type PersistedToolCall = {
  id: string;
  name: string;
  input?: Record<string, unknown>;
};

export type PersistedHistoryMessage = {
  index: number;
  role: string;
  content: string | Array<{ type: string; text?: string; mimeType?: string }>;
  thought?: string;
  toolCalls?: PersistedToolCall[];
  toolUseId?: string;
  toolName?: string;
  isError?: boolean;
};

// Rebuild chat entries from persisted session history. Persisted assistant
// messages are the durable turn contract: content is visible answer text,
// thought is work, and toolCalls/tool_result pairs form work units. Empty
// assistant content is therefore structural only when thought/toolCalls exist;
// it must preserve work boundaries without creating a blank answer bubble.
export function historyToEntries(
  messages: PersistedHistoryMessage[],
): ChatEntry[] {
  let out: ChatEntry[] = [];
  let fallbackGroupId: string | null = null;
  const toolGroupByUseId = new Map<string, string>();
  const toolOrderByGroupId = new Map<string, number>();

  for (const m of messages) {
    if (m.role === "tool_result") {
      const toolUseId = m.toolUseId ?? `hist-tool-${m.index}`;
      const existingGroupId = toolGroupByUseId.get(toolUseId);
      const groupId: string = existingGroupId ?? fallbackGroupId ?? `hist-tools-${m.index}`;
      if (!existingGroupId) {
        fallbackGroupId = groupId;
        const displayOrder = nextToolOrder(toolOrderByGroupId, groupId);
        out = applyToolStart(out, {
          groupId,
          toolUseId,
          name: m.toolName ?? "tool",
          displayOrder,
        });
        toolGroupByUseId.set(toolUseId, groupId);
      }
      out = applyToolEnd(out, {
        groupId,
        toolUseId,
        result: textContent(m.content),
        isError: m.isError,
      });
      continue;
    }
    fallbackGroupId = null;
    if (m.role === "user") {
      out.push({ kind: "user", text: textContent(m.content) });
    } else if (m.role === "assistant") {
      const text = textContent(m.content);
      out = finalizeStreamingReasoning(out, m.thought ?? "");
      out = finalizeStreamingAssistant(out, text);

      if (m.toolCalls?.length) {
        const groupId = `hist-tools-${m.index}`;
        fallbackGroupId = groupId;
        m.toolCalls.forEach((toolCall, displayOrder) => {
          toolGroupByUseId.set(toolCall.id, groupId);
          toolOrderByGroupId.set(groupId, displayOrder + 1);
          out = applyToolStart(out, {
            groupId,
            toolUseId: toolCall.id,
            name: toolCall.name,
            displayOrder,
            input: toolCall.input,
          });
        });
      }
    }
  }
  return out;
}

function nextToolOrder(orderByGroupId: Map<string, number>, groupId: string): number {
  const next = orderByGroupId.get(groupId) ?? 0;
  orderByGroupId.set(groupId, next + 1);
  return next;
}

function textContent(content: PersistedHistoryMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) =>
      part.type === "text"
        ? part.text ?? ""
        : `[${part.type}:${part.mimeType ?? part.type}]`,
    )
    .join("\n");
}
