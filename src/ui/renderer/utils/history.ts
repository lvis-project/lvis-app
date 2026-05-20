// Phase 2: persisted-history → renderer-entries rebuild.

import {
  applyToolEnd,
  applyToolStart,
  EMPTY_ASSISTANT_RESPONSE_TEXT,
  finalizeStreamingAssistant,
  finalizeStreamingReasoning,
  type ChatEntry,
} from "../../../lib/chat-stream-state.js";
import { detectFromStream } from "../../../lib/stream-markers.js";
import type { SerializedHistoryMessage } from "../../../shared/chat-history.js";

export type PersistedHistoryMessage = SerializedHistoryMessage;

// Rebuild chat entries from persisted session history. Persisted assistant
// messages are the durable turn contract: content is visible answer text,
// thought is work, and toolCalls/tool_result pairs form work units. Empty
// assistant content is therefore structural only when thought/toolCalls exist;
// it must preserve work boundaries without creating a blank answer bubble.
//
// `createdAt`, `turnSummary`, and `checkpointMeta` on the persisted message
// flow through so the renderer shows real per-turn timestamps + token totals +
// checkpoint dividers on session reload instead of mount-time fakes / zeros.
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
      // Compact-boundary marker — rebuild a CheckpointDivider rather than a
      // normal user bubble so the visual matches what a live structured-compact
      // turn would have rendered.
      if (m.checkpointMeta) {
        out.push({
          kind: "checkpoint",
          removedMessages: m.checkpointMeta.removedMessages,
          freedTokens: m.checkpointMeta.freedTokens,
          ...(m.checkpointMeta.compactNum !== undefined
            ? { compactNum: m.checkpointMeta.compactNum }
            : {}),
          ...(m.checkpointMeta.trigger ? { trigger: m.checkpointMeta.trigger } : {}),
          ...(m.checkpointMeta.compactStatus
            ? { compactStatus: m.checkpointMeta.compactStatus }
            : {}),
          ...(m.checkpointMeta.summary !== undefined
            ? { summary: m.checkpointMeta.summary }
            : {}),
          ...(m.checkpointMeta.truncatedDir !== undefined
            ? { truncatedDir: m.checkpointMeta.truncatedDir }
            : {}),
        });
        continue;
      }
      out.push({
        kind: "user",
        text: textContent(m.content),
        ...(m.createdAt !== undefined ? { createdAt: m.createdAt } : {}),
      });
    } else if (m.role === "assistant") {
      const text = textContent(m.content);
      const cleanedText = detectFromStream(text).cleanedText;
      const visibleText = cleanedText.trim().length > 0
        ? cleanedText
        : text.trim().length > 0
          ? EMPTY_ASSISTANT_RESPONSE_TEXT
          : "";
      out = finalizeStreamingReasoning(out, m.thought ?? "");
      // Pass the persisted createdAt through finalize so the assistant entry
      // it constructs/updates carries the original turn time (rather than
      // the load-time Date.now() stamp finalize would default to). When the
      // persisted message has no createdAt (legacy session), finalize falls
      // back to Date.now() — UI then renders the load time, but that's
      // acceptable for legacy data since the timestamp wasn't recorded.
      out = finalizeStreamingAssistant(
        out,
        visibleText,
        {
          ...(m.createdAt !== undefined ? { createdAt: m.createdAt } : {}),
          ...(m.systemNotice !== undefined && m.systemNotice !== "interrupted"
            ? { systemNotice: m.systemNotice }
            : {}),
        },
      );

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

      // Turn-final assistant — emit a turn_summary ChatEntry so the renderer
      // shows real token / duration totals on reload. Only the turn-final
      // assistant carries `turnSummary` (attached by ConversationLoop right
      // after onTurnSummary fires).
      if (m.turnSummary) {
        out.push({
          kind: "turn_summary",
          turnDurationMs: m.turnSummary.turnDurationMs,
          toolCount: m.turnSummary.toolCount,
          cumulativeToolMs: m.turnSummary.cumulativeToolMs,
          tokensIn: m.turnSummary.tokensIn,
          freshInputTokens: m.turnSummary.freshInputTokens,
          tokensOut: m.turnSummary.tokensOut,
          ...(m.turnSummary.cacheReadTokens !== undefined
            ? { cacheReadTokens: m.turnSummary.cacheReadTokens }
            : {}),
          ...(m.turnSummary.cacheWriteTokens !== undefined
            ? { cacheWriteTokens: m.turnSummary.cacheWriteTokens }
            : {}),
          ...(m.turnSummary.breakdown ? { breakdown: m.turnSummary.breakdown } : {}),
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
  return content;
}
