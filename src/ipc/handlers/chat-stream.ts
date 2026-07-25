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
import { parseStagedEnvelope, stagedOriginForInput } from "../../shared/staged-origins.js";
import {
  countResourceAttachmentFences,
  MCP_RESOURCE_ATTACHMENTS_PER_TURN,
} from "../../shared/mcp-resource-bounds.js";
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
 *
 * Those replay paths re-send TEXT THAT WAS ALREADY STORED, so this default is a
 * claim about the click that triggered the replay — not about who authored the
 * text. {@link runStreamedTurn} therefore re-derives the origin from the input's
 * envelope, which is why replaying a staged turn cannot launder it into a
 * user-keyboard turn.
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
    /** DLP-before-send keyboard text used only to mint a host RequestAnchor. */
    requestAnchorRawIntent?: string;
    rolePrompt?: ActiveRolePrompt;
    initialGuidance?: string;
    approvalReasonPrefix?: string;
  },
  channels: StreamTurnChannels = DEFAULT_STREAM_CHANNELS,
): Promise<TurnResult> {
  const send = (payload: unknown) =>
    sink(channels.stream, { streamId, ...((payload as Record<string, unknown>) ?? {}) });
  // The turn's ORIGIN SOURCE — read from the input's provenance envelope, never from a
  // separate flag. `overlay:*` for a plugin trigger, `app:*` for an MCP App's confirmed
  // `ui/message`. It becomes the permission manager's staged-origin (write/shell/network
  // forced to ask) and the transcript's provenance marker.
  // Table-driven (shared/staged-origins.ts): a per-origin if/else chain here used
  // to default to `null`, and a missing branch silently produced a turn with NO
  // staged origin — which disables the permission force-ask entirely. Resolving
  // the kind from the registry makes a newly registered origin work by default
  // instead of failing open.
  // Provenance travels with the TEXT, so it is derived FROM the text and not from
  // the caller's claimed origin. `chat send` binds the two (its gate rejects
  // either half alone), but the internal replay paths — edit-resend,
  // continue-last-user, retry-effort — re-send a stored history message under the
  // `user-keyboard` default above. A staged turn's stored message IS its envelope,
  // so trusting the claim there would replay server/plugin-authored text with the
  // force-ask gate off, no untrusted framing, and a genuine-user transcript row.
  // Reading the envelope makes every replay inherit what it was staged with.
  const envelope = parseStagedEnvelope(input);
  const claimedKind = stagedOriginForInput(options.inputOrigin);
  // Fail CLOSED when a staged origin arrives with an unreadable envelope. It is
  // reachable without an attacker: DLP redaction (`sanitizeOutgoingInput`) runs
  // between the send gate and here, and a serverId that trips a PII pattern is
  // rewritten INSIDE the fence header. Returning `null` there would silently drop
  // the turn's staged origin — the exact fail-open this table exists to remove.
  if (claimedKind && !envelope) {
    throw new Error(claimedKind.missingEnvelopeError);
  }
  // How much server-authored resource text one turn may carry. Enforced HERE, not at
  // either send gate, because `chat send` and `sidechat send` parse their payloads
  // separately — a bound in one of them simply would not exist for the other, and this
  // is the one place both arrive. Counting fences rather than parts makes it
  // independent of how the renderer packaged them.
  //
  // Refused, not trimmed: dropping the extras silently would leave the model answering
  // from 8 of the 10 documents the user believes it read, with nothing in the
  // transcript or the audit log saying so. That is only a safe trade because the count
  // is over ATTACHMENTS — material the host built — so the refusal always names
  // something the user can see and remove.
  if (countResourceAttachmentFences(options.attachments) > MCP_RESOURCE_ATTACHMENTS_PER_TURN) {
    throw new Error("too-many-resource-attachments");
  }
  const inputOrigin = envelope?.kind.inputOrigin ?? options.inputOrigin;
  const originSource = envelope?.source ?? null;
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
          ...(meta.executionPlan !== undefined
            ? { executionPlan: meta.executionPlan }
            : {}),
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
      inputOrigin,
      ...(options.requestAnchorRawIntent !== undefined
        ? { requestAnchorRawIntent: options.requestAnchorRawIntent }
        : {}),
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
