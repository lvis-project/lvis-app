// Phase 2: persisted-history → renderer-entries rebuild.

import type { ChatEntry } from "../../../lib/chat-stream-state.js";

// Rebuild chat entries from persisted session history. The backend only
// serializes role/content (+ toolName/isError for tool_result), so tool
// inputs and thinking blocks are not recoverable — we render a compact
// tool_group with name + result only. Consecutive tool_results collapse
// into one group, matching the live-stream rendering.
export function historyToEntries(
  messages: Array<{ index: number; role: string; content: string; toolName?: string; isError?: boolean }>,
): ChatEntry[] {
  const out: ChatEntry[] = [];
  let pendingGroup: Extract<ChatEntry, { kind: "tool_group" }> | null = null;
  let toolOrder = 0;
  for (const m of messages) {
    if (m.role === "tool_result") {
      if (!pendingGroup) {
        const gid = `hist-${m.index}`;
        pendingGroup = {
          kind: "tool_group",
          groupId: gid,
          groupIds: [gid],
          status: "done",
          tools: [],
        };
        out.push(pendingGroup);
      }
      pendingGroup.tools.push({
        toolUseId: `hist-${m.index}`,
        name: m.toolName ?? "tool",
        displayOrder: toolOrder++,
        status: m.isError ? "error" : "done",
        result: m.content,
      });
      if (m.isError) pendingGroup.status = "error";
      continue;
    }
    pendingGroup = null;
    if (m.role === "user") {
      out.push({ kind: "user", text: m.content });
    } else if (m.role === "assistant") {
      if (m.content.trim().length > 0) {
        out.push({ kind: "assistant", text: m.content, streaming: false });
      }
    }
  }
  return out;
}
