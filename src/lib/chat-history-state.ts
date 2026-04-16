import type { GenericMessage } from "../engine/llm/types.js";
import type { ChatEntry, ToolEntryItem } from "./chat-stream-state.js";

export function restoreChatEntries(messages: GenericMessage[]): ChatEntry[] {
  const entries: ChatEntry[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];

    if (message.role === "user") {
      entries.push({ kind: "user", text: message.content });
      continue;
    }

    if (message.role === "assistant") {
      if (message.content || message.thought) {
        entries.push({
          kind: "assistant",
          text: message.content,
          ...(message.thought ? { thought: message.thought } : {}),
        });
      }

      if (message.toolCalls?.length) {
        const resultsById = new Map<string, Extract<GenericMessage, { role: "tool_result" }>>();
        let cursor = index + 1;
        while (cursor < messages.length && messages[cursor]?.role === "tool_result") {
          const toolResult = messages[cursor] as Extract<GenericMessage, { role: "tool_result" }>;
          resultsById.set(toolResult.toolUseId, toolResult);
          cursor += 1;
        }

        const tools: ToolEntryItem[] = message.toolCalls.map((toolCall, toolIndex) => {
          const toolResult = resultsById.get(toolCall.id);
          return {
            toolUseId: toolCall.id,
            name: toolCall.name,
            displayOrder: toolIndex,
            status: toolResult?.isError ? "error" : toolResult ? "done" : "running",
            input: toolCall.input,
            result: toolResult?.content,
          };
        });

        entries.push({
          kind: "tool_group",
          groupId: message.toolCalls[0]?.id ?? `tool-group-${index}`,
          groupIds: message.toolCalls.map((toolCall) => toolCall.id),
          status: tools.some((tool) => tool.status === "error")
            ? "error"
            : tools.some((tool) => tool.status === "running")
              ? "running"
              : "done",
          tools,
        });

        index = cursor - 1;
      }
    }
  }

  return entries;
}
