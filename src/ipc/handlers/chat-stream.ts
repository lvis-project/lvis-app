/**
 * chat-stream.ts — platform-semantic chat streaming core.
 *
 * `runStreamedTurn` drives one conversation turn and emits each semantic turn
 * event plus provider fallback through `ConversationStreamEventSink`. It does
 * not know Electron IPC, SSE channel names, or legacy numeric stream ids.
 * Owner surfaces use a one-way compatibility projection from the shared
 * timeline; shared surfaces must use an explicit safe projection.
 *
 * This module imports nothing from Electron transport: it never touches
 * `ipcMain`, `webContents`, or `BrowserWindow`.
 */
import type {
  PlatformConversationEvent,
  PlatformConversationEventSink,
} from "../../engine/conversation-platform-protocol.js";
import { deriveTurnFailureSummary } from "../../engine/turn-failure-summary.js";
import type { ChatInputOrigin, RemoteControllerAuthority } from "../../shared/chat-origin.js";
import type { ActiveRolePrompt } from "../../data/role-presets.js";
import type { ConversationLoop, TurnResult } from "../../engine/conversation-loop.js";
import type { UserContentPart } from "../../engine/llm/types.js";
import { createDlpSafeUuid } from "../../shared/dlp-safe-id.js";
import { parseStagedEnvelope, stagedOriginForInput } from "../../shared/staged-origins.js";
import {
  countResourceAttachmentFences,
  MCP_RESOURCE_ATTACHMENTS_PER_TURN,
} from "../../shared/mcp-resource-bounds.js";
import {
  createStreamingFilter,
  stripSuggestedReplies,
} from "../../engine/suggested-replies.js";

/** Semantic event sink supplied by a platform-surface runtime. */
export type ConversationStreamEventSink = PlatformConversationEventSink;

/**
 * Default per-turn options for host-originated (user-keyboard) chat turns.
 * `chat send` overrides `inputOrigin` with the parsed origin; the internal
 * edit-resend / continue-last-user / retry-effort paths keep this default.
 *
 * Those replay paths re-send TEXT THAT WAS ALREADY STORED, so this default is a
 * claim about the click that triggered the replay — not about who authored the
 * text. Their host-owned registrar upgrades the claim from the raw staged
 * envelope before DLP can rewrite a source header; {@link runStreamedTurn}
 * then validates that already-minted staged claim or fails closed if its header
 * is no longer parseable. Raw surface input can never promote itself merely by
 * embedding an envelope, so a replayed staged turn cannot launder itself into a
 * user-keyboard turn and an external turn cannot impersonate a staged actor.
 */
export const STREAM_TURN_OPTIONS = { inputOrigin: "user-keyboard" as const };

export async function runStreamedTurn(
  conversationLoop: ConversationLoop,
  input: string,
  sink: ConversationStreamEventSink,
  options: {
    attachments?: UserContentPart[];
    inputOrigin: ChatInputOrigin;
    /** DLP-before-send keyboard text used only to mint a host RequestAnchor. */
    requestAnchorRawIntent?: string;
    rolePrompt?: ActiveRolePrompt;
    initialGuidance?: string;
    /** Marks this turn's child messages as a sub-agent report for reload replay. */
    subAgentReport?: { title?: string };
    approvalReasonPrefix?: string;
    /** Host-owned remote-controller authority, never parsed from chat input. */
    remoteControllerAuthority?: RemoteControllerAuthority;
    /** Carried by the replay paths so a folded turn keeps the row the user saw. */
    displayText?: string;
    /** Host-owned signal for a cancellable public remote turn. */
    abortSignal?: AbortSignal;
  },
): Promise<TurnResult> {
  // Minted HERE rather than read back after the append, because the input is
  // announced on the timeline before `runTurn` stores it. Handing the same id
  // to both means the row a surface renders and the row the host writes are
  // the same row by construction, with no window in which a surface holds an
  // identity the history has not got yet.
  const userMessageId = createDlpSafeUuid();
  if (options.abortSignal?.aborted) {
    throw new Error("turn-cancelled-before-start");
  }
  const send = (event: PlatformConversationEvent) => sink(event);
  // A staged envelope carries the source tag attached to a host-minted staged
  // input origin. It supplies the permission manager's force-ask provenance and
  // the transcript marker, but it is never an authority source by itself.
  // `chat:send` binds staged payloads before this boundary, while the privileged
  // replay registrar derives the closed staged enum from stored history before DLP.
  // Raw surface input is text only and cannot upgrade its own provenance.
  //
  // This is intentionally NOT an input-derived privilege escalation. Only an
  // internal host registrar is allowed to mint a staged inputOrigin; it does
  // so before DLP in the replay paths. Tailnet, loopback, sidechat, and direct
  // keyboard input are all raw user-controlled text, so an app/overlay-looking
  // envelope inside them remains text rather than becoming provenance.
  const claimedKind = stagedOriginForInput(options.inputOrigin);
  const envelope = claimedKind ? parseStagedEnvelope(input) : null;
  // Fail CLOSED when a staged origin arrives with an unreadable envelope. It is
  // reachable without an attacker: outgoing DLP redaction runs
  // between the send gate and here, and a serverId that trips a PII pattern is
  // rewritten INSIDE the fence header. Returning `null` there would silently drop
  // the turn's staged origin — the exact fail-open this table exists to remove.
  if (claimedKind && !envelope) {
    throw new Error(claimedKind.missingEnvelopeError);
  }
  // How much server-authored resource text one turn may carry. Enforced HERE, not at
  // either send gate, because `chat send` and `sidechat send` parse their payloads
  // separately — a bound in one of them simply would not exist for the other. This is
  // the one place ATTACHMENTS enter a turn (the other `runTurn` callers, the routine
  // engine and the subagent runner, pass none), which is the precise claim the bound
  // needs. Counting fences rather than parts makes it independent of how the renderer
  // packaged them.
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
  send({ kind: "turn.started" });
  // Uniform turn-input announcement: EVERY streamed turn publishes its input
  // once, right after `turn.started`, with the host-resolved origin. This is
  // the one emission point (rather than a per-transport special case in the
  // bridge/Tailnet ingress) so a surface that did not submit the turn — e.g.
  // the desktop renderer during a chat-platform-bridge turn — can render the
  // user row from the same timeline it already streams from. `displayText`
  // wins when a replay/folded turn carries the row the user originally saw.
  send({
    kind: "user.message",
    origin: inputOrigin,
    ownerDetail: { text: options.displayText ?? input, messageId: userMessageId },
  });
  const result = await conversationLoop.runTurn(
    input,
    {
      onReasoningDelta: (text) => send({
        kind: "assistant.reasoning.delta",
        ownerDetail: { text },
      }),
      onTextDelta: (text) => {
        const visible = suggestedRepliesFilter.feed(text);
        if (visible) send({ kind: "assistant.text.delta", text: visible });
      },
      onAssistantRound: ({ roundIndex, text, thought, stopReason, hasToolCalls, messageId }) =>
        send({
          kind: "assistant.round.completed",
          round: {
            roundIndex,
            text: stripSuggestedReplies(text),
            stopReason,
            hasToolCalls,
            ownerDetail: { thought, messageId },
          },
        }),
      onToolStart: (name, toolInput, meta) =>
        send({
          kind: "tool.started",
          tool: {
            name,
            groupId: meta.groupId,
            toolUseId: meta.toolUseId,
            displayOrder: meta.displayOrder,
            ...(meta.source === undefined ? {} : { source: meta.source }),
            ...(meta.category === undefined ? {} : { category: meta.category }),
            ...(meta.pluginId === undefined ? {} : { pluginId: meta.pluginId }),
            ...(meta.mcpServerId === undefined ? {} : { mcpServerId: meta.mcpServerId }),
          },
          ownerDetail: { input: toolInput },
        }),
      onPermissionReview: (event) =>
        send({
          kind: "permission.reviewed",
          review: {
            status: event.status,
            tool: {
              name: event.toolName,
              groupId: event.groupId,
              toolUseId: event.toolUseId,
              displayOrder: event.displayOrder,
              ...(event.source === undefined ? {} : { source: event.source }),
              ...(event.toolCategory === undefined ? {} : { category: event.toolCategory }),
            },
            ...(event.verdictLevel === undefined ? {} : { verdictLevel: event.verdictLevel }),
            ownerDetail: {
              ...(event.reason === undefined ? {} : { reason: event.reason }),
              ...(event.approvalPurpose === undefined
                ? {}
                : { approvalPurpose: event.approvalPurpose }),
            },
          },
        }),
      onToolEnd: (name, toolResult, isError, meta, uiPayload, durationMs) =>
        send({
          kind: "tool.completed",
          ...(meta.cancelled ? { cancelled: true } : {}),
          tool: {
            name,
            groupId: meta.groupId,
            toolUseId: meta.toolUseId,
            displayOrder: meta.displayOrder,
            ...(meta.source === undefined ? {} : { source: meta.source }),
            ...(meta.category === undefined ? {} : { category: meta.category }),
            ...(meta.pluginId === undefined ? {} : { pluginId: meta.pluginId }),
            ...(meta.mcpServerId === undefined ? {} : { mcpServerId: meta.mcpServerId }),
          },
          isError,
          durationMs,
          ownerDetail: {
            result: toolResult,
            ...(meta.executionPlan === undefined
              ? {}
              : { executionPlan: meta.executionPlan }),
            ...(uiPayload === undefined ? {} : { uiPayload }),
          },
        }),
      onError: (error, systemNotice, classifierCategory) =>
        send({
          kind: "turn.error",
          // The one derivation point for the share-safe failure summary: a
          // closed-table lookup that never copies the raw error message.
          failure: deriveTurnFailureSummary({
            ...(systemNotice === undefined ? {} : { systemNotice }),
            ...(classifierCategory === undefined ? {} : { classifierCategory }),
          }),
          ownerDetail: {
            message: error,
            ...(systemNotice === undefined ? {} : { systemNotice }),
          },
        }),
      onPermissionModeChanged: (mode) => send({ kind: "permission.mode.changed", mode }),
      onCompactStarted: ({ triggerSource, estimatedBefore, preflight }) =>
        send({
          kind: "compaction.started",
          triggerSource,
          estimatedBefore,
          preflight,
        }),
      onRecoveryExhausted: () =>
        send({ kind: "compaction.recovery.exhausted" }),
      onCompactOccurred: ({ removedMessages, freedTokens, estimatedAfter, trigger, summary, compactNum, compactStatus, truncatedDir }) =>
        send({
          kind: "compaction.completed",
          removedMessages,
          freedTokens,
          estimatedAfter,
          ...(trigger !== undefined ? { trigger } : {}),
          ...(compactNum !== undefined ? { compactNum } : {}),
          ...(compactStatus !== undefined ? { compactStatus } : {}),
          ownerDetail: {
            ...(summary === undefined ? {} : { summary }),
            ...(truncatedDir === undefined ? {} : { truncatedDir }),
          },
        }),
      onTurnSummary: ({ turnDurationMs, toolCount, cumulativeToolMs, tokensIn, freshInputTokens, tokensOut, cacheReadTokens, cacheWriteTokens, vendorProvider, vendorModel, usageByModel, subscriptionUsage, breakdown }) =>
        send({
          kind: "usage.reported",
          ownerDetail: {
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
            ...(subscriptionUsage !== undefined ? { subscriptionUsage } : {}),
            ...(breakdown ? { breakdown } : {}),
          },
        }),
      onLlmStatus: (status) => send({ kind: "model.status", ownerDetail: { status } }),
      onFallback: (from, to) => send({ kind: "model.fallback", from, to }),
      onGuidanceInjected: (text, row) => send({
        kind: "guidance.applied",
        text,
        ...(row.source
          ? { subAgentReport: row.source.title === undefined ? {} : { title: row.source.title } }
          : {}),
        ownerDetail: { messageId: row.messageId },
      }),
      onGuidanceDropped: (text) => send({ kind: "guidance.dropped", text }),
    },
    options.abortSignal,
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
      ...(options.subAgentReport ? { subAgentReport: options.subAgentReport } : {}),
      ...(options.approvalReasonPrefix
        ? { approvalReasonPrefix: options.approvalReasonPrefix }
        : {}),
      ...(options.remoteControllerAuthority
        ? { remoteControllerAuthority: options.remoteControllerAuthority }
        : {}),
      ...(options.displayText !== undefined ? { displayText: options.displayText } : {}),
      userMessageId,
    },
  );
  const { trailing, suggestedReplies } = suggestedRepliesFilter.finish();
  if (trailing) send({ kind: "assistant.text.delta", text: trailing });
  send({ kind: "suggestions.updated", replies: suggestedReplies });
  send({ kind: "turn.completed", ...(result.route === "command" ? { route: "command" } : {}) });
  return result;
}
