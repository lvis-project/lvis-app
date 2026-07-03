/**
 * SubAgentTranscriptAccumulator — builds a `ChatEntry[]` for a sub-agent's
 * child {@link ConversationLoop} from its per-round turn callbacks, using the
 * SAME pure reducers the main chat renderer uses
 * (`lib/chat-stream-state.ts`). This is what lets the sub-agent tab render
 * through the shared `TranscriptRenderer` with a transcript that is visually
 * identical to the main chat (tool cards, reasoning cards, assistant text).
 *
 * ── Why this lives in the engine (main process) ──
 * The sub-agent runs out-of-band: its activity never flows through the
 * persisted main `chat.stream` channel, so there is no renderer-side reducer
 * to build its `ChatEntry[]`. We reconstruct the array here at the source and
 * forward whole snapshots on the `lvis:agent-spawn:event` channel. This keeps a
 * single SOT model (`ChatEntry`) across live + persisted paths.
 *
 * ── DLP (spec line-item #5) ──
 * The child loop's tool RESULTS and reasoning THOUGHTS are NOT masked anywhere
 * else (the main chat.stream forwards them verbatim to the trusted renderer,
 * but this snapshot is a NEW persisted + forwarded surface). Every child tool
 * result and every reasoning/assistant text is run through
 * {@link maskSensitiveData} before it enters an entry. Tool INPUTS are already
 * masked by the executor's `emitToolStart` (display-mask.ts), so they arrive
 * pre-masked and are stored as-is.
 */
import { maskSensitiveData } from "../audit/dlp-filter.js";
import {
  applyToolStart,
  applyToolEnd,
  upsertStreamingReasoning,
  finalizeStreamingReasoning,
  upsertPermissionReview,
  upsertStreamingAssistant,
  finalizeStreamingAssistant,
  type ChatEntry,
} from "../lib/chat-stream-state.js";
import type { ToolCallMeta } from "../tools/executor.js";
import type { PermissionReviewEvent } from "../shared/permission-review-status.js";
import type { McpUiPayload } from "../mcp/types.js";

export class SubAgentTranscriptAccumulator {
  private entries: ChatEntry[] = [];

  /** Immutable snapshot of the child transcript so far. */
  snapshot(): ChatEntry[] {
    return this.entries;
  }

  onToolStart(name: string, input: Record<string, unknown>, meta: ToolCallMeta): void {
    // `input` arrives already DLP-masked from the executor (emitToolStart), so
    // we store it verbatim — double-masking would corrupt already-redacted text.
    this.entries = applyToolStart(this.entries, {
      groupId: meta.groupId,
      toolUseId: meta.toolUseId,
      name,
      displayOrder: meta.displayOrder,
      input,
      ...(meta.source ? { source: meta.source } : {}),
      ...(meta.category ? { category: meta.category } : {}),
      ...(meta.pluginId ? { pluginId: meta.pluginId } : {}),
      ...(meta.mcpServerId ? { mcpServerId: meta.mcpServerId } : {}),
    });
  }

  onToolEnd(
    _name: string,
    result: string,
    isError: boolean,
    meta: ToolCallMeta,
    uiPayload: McpUiPayload | undefined,
    durationMs: number,
  ): void {
    // Child tool RESULTS are unmasked at this boundary — mask before persist.
    // `uiPayload` is narrowed to the ToolEntryItem shape (drop `csp` — the
    // renderer's stored payload never carried it); slot values already match.
    const storedUiPayload = uiPayload
      ? {
          serverId: uiPayload.serverId,
          resourceUri: uiPayload.resourceUri,
          ...(uiPayload.slot ? { slot: uiPayload.slot } : {}),
          ...(uiPayload.height !== undefined ? { height: uiPayload.height } : {}),
          ...(uiPayload.title !== undefined ? { title: uiPayload.title } : {}),
        }
      : undefined;
    this.entries = applyToolEnd(this.entries, {
      groupId: meta.groupId,
      toolUseId: meta.toolUseId,
      result: maskSensitiveData(result).masked,
      isError,
      ...(storedUiPayload ? { uiPayload: storedUiPayload } : {}),
      durationMs,
      ...(meta.source ? { source: meta.source } : {}),
      ...(meta.category ? { category: meta.category } : {}),
      ...(meta.pluginId ? { pluginId: meta.pluginId } : {}),
      ...(meta.mcpServerId ? { mcpServerId: meta.mcpServerId } : {}),
    });
  }

  onPermissionReview(event: PermissionReviewEvent): void {
    this.entries = upsertPermissionReview(this.entries, {
      status: event.status,
      toolName: event.toolName,
      groupId: event.groupId,
      toolUseId: event.toolUseId,
      ...(event.toolCategory ? { toolCategory: event.toolCategory } : {}),
      ...(event.source ? { source: event.source } : {}),
      ...(event.displayOrder !== undefined ? { displayOrder: event.displayOrder } : {}),
      ...(event.verdictLevel ? { verdictLevel: event.verdictLevel } : {}),
      ...(event.reason ? { reason: maskSensitiveData(event.reason).masked } : {}),
      ...(event.approvalPurpose ? { approvalPurpose: event.approvalPurpose } : {}),
    });
  }

  /**
   * Fold one completed assistant round into the transcript: the round's
   * reasoning (thought) becomes a finalized reasoning entry, and the round's
   * text becomes a finalized assistant entry. Both are DLP-masked. Called once
   * per round boundary from the child loop's `onAssistantRound`.
   */
  onAssistantRound(thought: string, text: string): void {
    const maskedThought = thought ? maskSensitiveData(thought).masked : "";
    if (maskedThought) {
      this.entries = upsertStreamingReasoning(this.entries, maskedThought);
      this.entries = finalizeStreamingReasoning(this.entries, maskedThought);
    }
    const maskedText = text ? maskSensitiveData(text).masked : "";
    if (maskedText) {
      this.entries = upsertStreamingAssistant(this.entries, maskedText);
      this.entries = finalizeStreamingAssistant(this.entries, maskedText);
    }
  }
}
