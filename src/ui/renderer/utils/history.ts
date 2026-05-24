// Persisted-history → renderer-entries rebuild.

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
import {
  isOverlayTriggerOrigin,
  parseImportedTriggerEnvelopePayload,
} from "../../../shared/overlay-trigger-source.js";

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
  let latestCheckpointCreatedAt: number | null = null;

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
        ...(m.toolDisplay?.durationMs !== undefined ? { durationMs: m.toolDisplay.durationMs } : {}),
        ...(m.toolDisplay?.source ? { source: m.toolDisplay.source } : {}),
        ...(m.toolDisplay?.category ? { category: m.toolDisplay.category } : {}),
        ...(m.toolDisplay?.pluginId ? { pluginId: m.toolDisplay.pluginId } : {}),
        ...(m.toolDisplay?.mcpServerId ? { mcpServerId: m.toolDisplay.mcpServerId } : {}),
      });
      continue;
    }
    fallbackGroupId = null;
    if (m.role === "user") {
      // Compact-boundary marker — rebuild a CheckpointDivider rather than a
      // normal user bubble so the visual matches what a live structured-compact
      // turn would have rendered.
      if (m.checkpointMeta) {
        latestCheckpointCreatedAt =
          typeof m.createdAt === "number" && Number.isFinite(m.createdAt)
            ? m.createdAt
            : Number.MAX_SAFE_INTEGER;
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
        if (
          typeof m.checkpointMeta.contextTokensAfter === "number" &&
          Number.isFinite(m.checkpointMeta.contextTokensAfter) &&
          m.checkpointMeta.contextTokensAfter > 0
        ) {
          out.push({
            kind: "context_usage",
            tokensIn: Math.floor(m.checkpointMeta.contextTokensAfter),
            source: "compact-estimate",
          });
        }
        continue;
      }
      const importedTrigger = importedTriggerFromMessage(m);
      if (importedTrigger) {
        out.push(importedTrigger);
        continue;
      }
      out.push({
        kind: "user",
        text: visibleUserText(m),
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
          ...(isReplayableSystemNotice(m.systemNotice)
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
      if (m.turnSummary && !isPreservedPreCompactTurn(m, latestCheckpointCreatedAt)) {
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
          ...(m.turnSummary.vendorProvider !== undefined
            ? { vendorProvider: m.turnSummary.vendorProvider }
            : {}),
          ...(m.turnSummary.vendorModel !== undefined
            ? { vendorModel: m.turnSummary.vendorModel }
            : {}),
          ...(m.turnSummary.usageByModel !== undefined
            ? { usageByModel: m.turnSummary.usageByModel }
            : {}),
          ...(m.turnSummary.breakdown ? { breakdown: m.turnSummary.breakdown } : {}),
        });
      }
    }
  }
  return out;
}

function isPreservedPreCompactTurn(
  message: PersistedHistoryMessage,
  latestCheckpointCreatedAt: number | null,
): boolean {
  if (latestCheckpointCreatedAt === null) return false;
  if (typeof message.createdAt !== "number" || !Number.isFinite(message.createdAt)) {
    return true;
  }
  return message.createdAt <= latestCheckpointCreatedAt;
}

function nextToolOrder(orderByGroupId: Map<string, number>, groupId: string): number {
  const next = orderByGroupId.get(groupId) ?? 0;
  orderByGroupId.set(groupId, next + 1);
  return next;
}

function textContent(content: PersistedHistoryMessage["content"]): string {
  return content;
}

function visibleUserText(message: PersistedHistoryMessage): string {
  if (message.displayText !== undefined) return message.displayText;
  const content = textContent(message.content);
  return legacySkillVisibleText(content);
}

const LEGACY_SKILL_PREFIX_PATTERN = /^\[스킬:\s*([^\]]+)\]\s*/;

function legacySkillVisibleText(content: string): string {
  const match = content.match(LEGACY_SKILL_PREFIX_PATTERN);
  return match ? content.slice(match[0].length) : content;
}

function importedTriggerFromMessage(
  message: PersistedHistoryMessage,
): Extract<ChatEntry, { kind: "imported_trigger" }> | null {
  if (message.importedTrigger) {
    if (!isOverlayTriggerOrigin(message.importedTrigger.source)) return null;
    return {
      kind: "imported_trigger",
      sessionId: message.importedTrigger.sessionId,
      source: message.importedTrigger.source,
      prompt: message.importedTrigger.prompt,
      summary: message.importedTrigger.summary,
      toolCallCount: message.importedTrigger.toolCallCount,
      importedAt: message.importedTrigger.importedAt,
    };
  }
  const content = textContent(message.content);
  if (!content.trim().endsWith("</imported-from-proactive>")) return null;
  const parsed = parseImportedTriggerEnvelopePayload(content);
  if (!parsed) return null;
  return {
    kind: "imported_trigger",
    sessionId: `history-imported-${message.index}`,
    source: parsed.source,
    prompt: textContent(message.content),
    summary: parsed.body,
    toolCallCount: 0,
    importedAt: message.createdAt !== undefined
      ? new Date(message.createdAt).toISOString()
      : new Date(0).toISOString(),
  };
}

function isReplayableSystemNotice(
  value: PersistedHistoryMessage["systemNotice"],
): value is Exclude<NonNullable<PersistedHistoryMessage["systemNotice"]>, "interrupted"> {
  return value === "context-error" || value === "stream-error";
}
