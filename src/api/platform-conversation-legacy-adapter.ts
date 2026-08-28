/**
 * Rich owner-surface compatibility adapter.
 *
 * The platform timeline is the only producer source. This adapter translates
 * its semantic events into the existing Electron IPC and loopback SSE frame
 * shape while the renderer migrates to the platform contract.
 */
import { CHANNELS } from "../contract/app-contract.js";
import type {
  LegacyChatStreamSink,
  PlatformConversationEvent,
  PlatformConversationEventEnvelope,
  PlatformConversationEventSink,
  PlatformConversationTimeline,
} from "../engine/conversation-platform-protocol.js";
export { createPlatformTurnId } from "../engine/conversation-platform-protocol.js";

/** A legacy `(channel, payload)` stream source, suitable for the existing SSE server. */
export interface LegacyChatStreamEventSource {
  subscribe(fn: LegacyChatStreamSink): () => void;
  subscriberCount(): number;
}

export interface LegacyChatStreamProjectionOptions {
  /** Existing renderer stale-frame correlation id, if the turn owns one. */
  readonly streamId?: number;
  readonly streamChannel?: string;
  readonly fallbackChannel?: string;
}

interface LegacyChatStreamFrame {
  readonly channel: string;
  readonly payload: Record<string, unknown>;
}

/**
 * Translate one semantic event into the old owner-only wire frame. This is the
 * only place where the legacy event names and numeric stream id are known.
 */
function projectPlatformConversationEventToLegacyChatFrame(
  event: PlatformConversationEvent,
  options: LegacyChatStreamProjectionOptions = {},
): LegacyChatStreamFrame | undefined {
  const streamChannel = options.streamChannel ?? CHANNELS.chat.stream;
  const fallbackChannel = options.fallbackChannel ?? CHANNELS.chat.fallback;
  const withStreamId = (payload: Record<string, unknown>): Record<string, unknown> => (
    options.streamId === undefined ? payload : { streamId: options.streamId, ...payload }
  );

  switch (event.kind) {
    case "turn.started":
      return undefined;
    case "user.message":
      return streamFrame(streamChannel, withStreamId({
        type: "user_message",
        text: event.ownerDetail.text,
        origin: event.origin,
        messageId: event.ownerDetail.messageId,
      }));
    case "assistant.reasoning.delta":
      return streamFrame(streamChannel, withStreamId({
        type: "reasoning_delta",
        text: event.ownerDetail.text,
      }));
    case "assistant.text.delta":
      return streamFrame(streamChannel, withStreamId({ type: "text_delta", text: event.text }));
    case "assistant.round.completed":
      return streamFrame(streamChannel, withStreamId({
        type: "assistant_round",
        messageId: event.round.ownerDetail.messageId,
        roundIndex: event.round.roundIndex,
        text: event.round.text,
        thought: event.round.ownerDetail.thought,
        stopReason: event.round.stopReason,
        hasToolCalls: event.round.hasToolCalls,
      }));
    case "tool.started":
      return streamFrame(streamChannel, withStreamId({
        type: "tool_start",
        ...legacyToolReference(event.tool),
        input: event.ownerDetail.input,
      }));
    case "tool.completed":
      return streamFrame(streamChannel, withStreamId({
        type: "tool_end",
        ...legacyToolReference(event.tool),
        result: event.ownerDetail.result,
        isError: event.isError,
        ...(event.cancelled ? { cancelled: true } : {}),
        ...(event.ownerDetail.executionPlan === undefined
          ? {}
          : { executionPlan: event.ownerDetail.executionPlan }),
        ...(event.ownerDetail.uiPayload === undefined ? {} : { uiPayload: event.ownerDetail.uiPayload }),
        durationMs: event.durationMs,
      }));
    case "permission.reviewed":
      return streamFrame(streamChannel, withStreamId({
        type: "permission_review",
        reviewStatus: event.review.status,
        ...legacyToolReference(event.review.tool),
        ...(event.review.verdictLevel === undefined ? {} : { verdictLevel: event.review.verdictLevel }),
        ...(event.review.ownerDetail.reason === undefined ? {} : { reason: event.review.ownerDetail.reason }),
        ...(event.review.ownerDetail.approvalPurpose === undefined
          ? {}
          : { approvalPurpose: event.review.ownerDetail.approvalPurpose }),
      }));
    case "turn.error":
      return streamFrame(streamChannel, withStreamId({
        type: "error",
        error: event.ownerDetail.message,
        ...(event.ownerDetail.systemNotice === undefined
          ? {}
          : { systemNotice: event.ownerDetail.systemNotice }),
      }));
    case "permission.mode.changed":
      return streamFrame(streamChannel, withStreamId({ type: "permission_mode_changed", mode: event.mode }));
    case "compaction.started":
      return streamFrame(streamChannel, withStreamId({
        type: "compact_started",
        triggerSource: event.triggerSource,
        estimatedBefore: event.estimatedBefore,
        preflight: event.preflight,
      }));
    case "compaction.recovery.exhausted":
      return streamFrame(streamChannel, withStreamId({ type: "recovery_exhausted" }));
    case "compaction.completed":
      return streamFrame(streamChannel, withStreamId({
        type: "compact_notice",
        removedMessages: event.removedMessages,
        freedTokens: event.freedTokens,
        estimatedAfter: event.estimatedAfter,
        ...(event.trigger === undefined ? {} : { trigger: event.trigger }),
        ...(event.ownerDetail.summary === undefined ? {} : { summary: event.ownerDetail.summary }),
        ...(event.compactNum === undefined ? {} : { compactNum: event.compactNum }),
        ...(event.compactStatus === undefined ? {} : { compactStatus: event.compactStatus }),
        ...(event.ownerDetail.truncatedDir === undefined ? {} : { truncatedDir: event.ownerDetail.truncatedDir }),
      }));
    case "usage.reported":
      return streamFrame(streamChannel, withStreamId({ type: "turn_summary", ...event.ownerDetail }));
    case "model.status":
      return streamFrame(streamChannel, withStreamId({ type: "llm_status", ...event.ownerDetail.status }));
    case "model.fallback":
      return streamFrame(fallbackChannel, { from: event.from, to: event.to });
    case "guidance.applied":
      return streamFrame(streamChannel, withStreamId({
        type: "guidance_injected",
        text: event.text,
        messageId: event.ownerDetail.messageId,
        ...(event.subAgentReport ? { subAgentReport: event.subAgentReport } : {}),
      }));
    case "guidance.dropped":
      return streamFrame(streamChannel, withStreamId({ type: "guidance_dropped", text: event.text }));
    case "suggestions.updated":
      return streamFrame(streamChannel, withStreamId({ type: "suggested_replies", replies: event.replies }));
    case "turn.completed":
      return streamFrame(streamChannel, withStreamId({
        type: "done",
        ...(event.route === "command" ? { route: "command" } : {}),
      }));
    case "privacy.redacted":
      // Historical redaction notices were emitted before a stream id was bound.
      return streamFrame(streamChannel, {
        type: "redact_notice",
        count: event.count,
        byKind: event.byKind,
      });
  }
}

/** Create a compatibility sink for side chat's deliberately isolated loop. */
export function createLegacyChatStreamEventSink(
  sink: LegacyChatStreamSink,
  options: LegacyChatStreamProjectionOptions,
): PlatformConversationEventSink {
  return (event) => {
    const frame = projectPlatformConversationEventToLegacyChatFrame(event, options);
    if (!frame) return;
    try {
      sink(frame.channel, frame.payload);
    } catch {
      // Existing display-side delivery is best effort.
    }
  };
}

/**
 * Subscribe Electron or the existing loopback SSE endpoint to the common
 * semantic timeline. It cannot publish into that timeline.
 */
export function createPlatformConversationLegacyStreamAdapter(
  timeline: PlatformConversationTimeline,
): LegacyChatStreamEventSource {
  const subscribers = new Set<LegacyChatStreamSink>();
  let unsubscribeTimeline: (() => void) | undefined;

  const attach = () => {
    if (unsubscribeTimeline || subscribers.size === 0) return;
    unsubscribeTimeline = timeline.subscribe(deliver).unsubscribe;
  };
  const detach = () => {
    if (subscribers.size !== 0 || !unsubscribeTimeline) return;
    unsubscribeTimeline();
    unsubscribeTimeline = undefined;
  };
  const deliver = (envelope: PlatformConversationEventEnvelope) => {
    const frame = projectPlatformConversationEventToLegacyChatFrame(envelope.event, {
      streamId: readStreamIdFromTurnId(envelope.turnId),
    });
    if (!frame) return;
    for (const subscriber of [...subscribers]) {
      try {
        subscriber(frame.channel, frame.payload);
      } catch {
        // A broken display must not block another adapter or the source turn.
      }
    }
  };

  return {
    subscribe: (subscriber) => {
      subscribers.add(subscriber);
      attach();
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        subscribers.delete(subscriber);
        detach();
      };
    },
    subscriberCount: () => subscribers.size,
  };
}

function streamFrame(channel: string, payload: Record<string, unknown>): LegacyChatStreamFrame {
  return { channel, payload };
}

function legacyToolReference(
  tool: Extract<PlatformConversationEvent, { readonly kind: "tool.started" }> ["tool"],
): Record<string, unknown> {
  return {
    name: tool.name,
    groupId: tool.groupId,
    toolUseId: tool.toolUseId,
    displayOrder: tool.displayOrder,
    ...(tool.source === undefined ? {} : { source: tool.source }),
    ...(tool.category === undefined ? {} : { toolCategory: tool.category }),
    ...(tool.pluginId === undefined ? {} : { pluginId: tool.pluginId }),
    ...(tool.mcpServerId === undefined ? {} : { mcpServerId: tool.mcpServerId }),
  };
}

function readStreamIdFromTurnId(turnId: string | undefined): number | undefined {
  const match = /^local-stream\/(\d+)$/.exec(turnId ?? "");
  if (!match) return undefined;
  const streamId = Number(match[1]);
  return Number.isSafeInteger(streamId) && streamId >= 0 ? streamId : undefined;
}
