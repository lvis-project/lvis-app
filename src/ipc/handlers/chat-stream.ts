/**
 * chat-stream.ts — transport-agnostic chat streaming core (#1409 C10).
 *
 * `runStreamedTurn` drives a single conversation turn and PUBLISHES every
 * per-turn frame plus the provider-fallback notice through a {@link ChatStreamSink}
 * instead of calling `webContents.send` directly. The IPC transport
 * (`domains/chat.ts`) supplies a sink that does `webContents.send` — the frames
 * are BYTE-IDENTICAL to the pre-C10 fan-out (same channel, same
 * `{ streamId, ...payload }` shape) — while a future in-process api/cli/sdk
 * consumer can supply an SSE/emitter sink over the exact same event stream.
 *
 * This module imports NOTHING from the electron transport: it never touches
 * `ipcMain` / `webContents` / `BrowserWindow`. The only IPC-adjacent value it
 * references is the channel-name SOT (`CHANNELS.chat.stream` / `.fallback`),
 * which is a plain string contract, not a transport handle.
 */
import { CHANNELS } from "../../contract/app-contract.js";
import type { ChatInputOrigin } from "../../shared/chat-origin.js";
import type { ActiveRolePrompt } from "../../data/role-presets.js";
import type { ConversationLoop, TurnResult } from "../../engine/conversation-loop.js";
import type { UserContentPart } from "../../engine/llm/types.js";
import { parseImportedTriggerEnvelope } from "../../shared/overlay-trigger-source.js";
import {
  createStreamingFilter,
  stripSuggestedReplies,
} from "../../engine/suggested-replies.js";

/**
 * A sink that receives fully-formed chat stream frames. `channel` is the wire
 * channel (`CHANNELS.chat.stream` / `CHANNELS.chat.fallback`) and `payload` is
 * the exact object the renderer receives. The IPC sink forwards this straight
 * to `webContents.send(channel, payload)`; a broadcaster can fan the same
 * `(channel, payload)` pair out to additional (api/cli) subscribers.
 */
export type ChatStreamSink = (channel: string, payload: unknown) => void;

/**
 * Default per-turn options for host-originated (user-keyboard) chat turns.
 * `chat send` overrides `inputOrigin` with the parsed origin; the internal
 * edit-resend / continue-last-user / retry-effort paths keep this default.
 */
export const STREAM_TURN_OPTIONS = { inputOrigin: "user-keyboard" as const };

/**
 * Wire channels a streamed turn publishes to. Defaults to the main chat pair so
 * the main callsite stays BYTE-IDENTICAL. The side-chat transport
 * (`domains/sidechat.ts`) passes its dedicated `CHANNELS.sidechat.*` pair so its
 * frames never reach the main renderer's `onChatStream` subscriber (No-Fallback:
 * the sink is never asked to guess which session a frame belongs to — the wire
 * channel itself is the discriminator).
 */
export interface StreamTurnChannels {
  stream: string;
  fallback: string;
}

const DEFAULT_STREAM_CHANNELS: StreamTurnChannels = {
  stream: CHANNELS.chat.stream,
  fallback: CHANNELS.chat.fallback,
};

export async function runStreamedTurn(
  conversationLoop: ConversationLoop,
  input: string,
  sink: ChatStreamSink,
  streamId: number,
  options: {
    attachments?: UserContentPart[];
    inputOrigin: ChatInputOrigin;
    rolePrompt?: ActiveRolePrompt;
    initialGuidance?: string;
    approvalReasonPrefix?: string;
  },
  channels: StreamTurnChannels = DEFAULT_STREAM_CHANNELS,
): Promise<TurnResult> {
  const send = (payload: unknown) =>
    sink(channels.stream, { streamId, ...((payload as Record<string, unknown>) ?? {}) });
  const originSource = options.inputOrigin === "plugin-emitted"
    ? parseImportedTriggerEnvelope(input)
    : null;
  // Per-turn streaming filter for the <suggested_replies> block. Withholds
  // chunks that could be (or are) part of the trailing tag, surfaces the
  // parsed list when the turn ends. See
  // `docs/architecture/proposals/suggested-replies-ghost-text.md`.
  const suggestedRepliesFilter = createStreamingFilter();
  const result = await conversationLoop.runTurn(
    input,
    {
      onReasoningDelta: (text) => send({ type: "reasoning_delta", text }),
      onTextDelta: (text) => {
        const visible = suggestedRepliesFilter.feed(text);
        if (visible) send({ type: "text_delta", text: visible });
      },
      onAssistantRound: ({ roundIndex, text, thought, stopReason, hasToolCalls }) =>
        send({
          type: "assistant_round",
          roundIndex,
          text: stripSuggestedReplies(text),
          thought,
          stopReason,
          hasToolCalls,
        }),
      onToolStart: (name, toolInput, meta) =>
        send({
          type: "tool_start",
          name,
          input: toolInput,
          groupId: meta.groupId,
          toolUseId: meta.toolUseId,
          displayOrder: meta.displayOrder,
          source: meta.source,
          toolCategory: meta.category,
          pluginId: meta.pluginId,
          mcpServerId: meta.mcpServerId,
        }),
      onPermissionReview: (event) =>
        send({
          type: "permission_review",
          reviewStatus: event.status,
          name: event.toolName,
          toolCategory: event.toolCategory,
          source: event.source,
          groupId: event.groupId,
          toolUseId: event.toolUseId,
          displayOrder: event.displayOrder,
          verdictLevel: event.verdictLevel,
          reason: event.reason,
          approvalPurpose: event.approvalPurpose,
        }),
      onToolEnd: (name, toolResult, isError, meta, uiPayload, durationMs) =>
        send({
          type: "tool_end",
          name,
          result: toolResult,
          isError,
          groupId: meta.groupId,
          toolUseId: meta.toolUseId,
          displayOrder: meta.displayOrder,
          source: meta.source,
          toolCategory: meta.category,
          pluginId: meta.pluginId,
          mcpServerId: meta.mcpServerId,
          ...(uiPayload && { uiPayload }),
          durationMs,
        }),
      onError: (error, systemNotice) =>
        send({ type: "error", error, ...(systemNotice ? { systemNotice } : {}) }),
      onPermissionModeChanged: (mode) => send({ type: "permission_mode_changed", mode }),
      onCompactStarted: ({ triggerSource, estimatedBefore, preflight }) =>
        send({
          type: "compact_started",
          triggerSource,
          estimatedBefore,
          preflight,
        }),
      onRecoveryExhausted: () =>
        send({ type: "recovery_exhausted" }),
      onCompactOccurred: ({ removedMessages, freedTokens, estimatedAfter, trigger, summary, compactNum, compactStatus, truncatedDir }) =>
        send({
          type: "compact_notice",
          removedMessages,
          freedTokens,
          estimatedAfter,
          ...(trigger !== undefined ? { trigger } : {}),
          ...(summary !== undefined ? { summary } : {}),
          ...(compactNum !== undefined ? { compactNum } : {}),
          ...(compactStatus !== undefined ? { compactStatus } : {}),
          ...(truncatedDir !== undefined ? { truncatedDir } : {}),
        }),
      onTurnSummary: ({ turnDurationMs, toolCount, cumulativeToolMs, tokensIn, freshInputTokens, tokensOut, cacheReadTokens, cacheWriteTokens, vendorProvider, vendorModel, usageByModel, breakdown }) =>
        send({
          type: "turn_summary",
          turnDurationMs,
          toolCount,
          cumulativeToolMs,
          tokensIn,
          freshInputTokens,
          tokensOut,
          ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
          ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
          vendorProvider,
          vendorModel,
          ...(usageByModel !== undefined ? { usageByModel } : {}),
          ...(breakdown ? { breakdown } : {}),
        }),
      onLlmStatus: (status) => send({ type: "llm_status", ...status }),
      onFallback: (from, to) => sink(channels.fallback, { from, to }),
      onGuidanceInjected: (text) => send({ type: "guidance_injected", text }),
      onGuidanceDropped: (text) => send({ type: "guidance_dropped", text }),
    },
    undefined,
    {
      ...(originSource ? { originSource } : {}),
      ...(options.attachments && options.attachments.length > 0
        ? { attachments: options.attachments }
        : {}),
      inputOrigin: options.inputOrigin,
      ...(options.rolePrompt ? { rolePrompt: options.rolePrompt } : {}),
      ...(options.initialGuidance ? { initialGuidance: options.initialGuidance } : {}),
      ...(options.approvalReasonPrefix
        ? { approvalReasonPrefix: options.approvalReasonPrefix }
        : {}),
    },
  );
  const { trailing, suggestedReplies } = suggestedRepliesFilter.finish();
  if (trailing) send({ type: "text_delta", text: trailing });
  send({ type: "suggested_replies", replies: suggestedReplies });
  send({ type: "done", ...(result.route === "command" ? { route: "command" } : {}) });
  return result;
}
