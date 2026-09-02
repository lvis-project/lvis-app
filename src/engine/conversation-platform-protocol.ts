/**
 * The platform-owned conversation event contract.
 *
 * A conversation turn has exactly one semantic event source. Electron, the
 * loopback API, a future CLI/Web client, Tailnet, and chat-platform bridges
 * are adapters over this contract; they must not publish their own raw wire
 * frames as an alternative source of truth.
 *
 * This module intentionally distinguishes an event's portable semantic fields
 * from `ownerDetail`. `ownerDetail` is only for a trusted owner-surface
 * adapter (the current Electron compatibility adapter). A remote/shared
 * adapter must use `projectSharedConversationEvent()` and its own share grant
 * rather than serializing an event wholesale. The projection is derived from
 * this one timeline, not a second "safe hub".
 */
import type { McpUiPayload } from "../mcp/types.js";
import type { HostShellExecutionPlanAuditProjection } from "../permissions/host-shell-execution-plan.js";
import {
  isSharedApprovalToolIdentifier,
  type ApprovalPurposeSuggestion,
  type RiskLevel,
  type PermissionReviewStatus,
} from "../shared/permission-review-status.js";
import type { ChatInputOrigin } from "../shared/chat-origin.js";
import type { ToolCategory, ToolSource } from "../tools/types.js";
import type { FallbackStatus } from "./llm/vercel/fallback-chain.js";
import type { TurnCallbacks } from "./turn/types.js";
import {
  createConversationEventHub,
  type ConversationEventHub,
  type ConversationEventHubOptions,
  type ConversationEventReplay,
  type ConversationEventSubscriptionOptions,
} from "./conversation-event-hub.js";
import {
  toSafeTurnFailureSummary,
  type TurnFailureSummary,
} from "./turn-failure-summary.js";
import type { ExecutionMode } from "../shared/permission-mode.js";

/** Version of the semantic platform event contract. */
export const PLATFORM_CONVERSATION_PROTOCOL_VERSION = 1 as const;

export type PlatformConversationProtocolVersion =
  typeof PLATFORM_CONVERSATION_PROTOCOL_VERSION;

/**
 * A renderer-independent reference to one tool invocation. The portable part
 * deliberately contains no tool arguments, result body, execution plan, or
 * MCP UI resource URI.
 */
export interface ConversationToolReference {
  readonly name: string;
  readonly groupId: string;
  readonly toolUseId: string;
  readonly displayOrder: number;
  readonly source?: ToolSource;
  readonly category?: ToolCategory;
  readonly pluginId?: string;
  readonly mcpServerId?: string;
}

/** Owner-only material needed by the current rich desktop tool card. */
export interface ConversationToolStartOwnerDetail {
  readonly input: Record<string, unknown>;
}

/** Owner-only material needed by the current rich desktop tool card. */
export interface ConversationToolEndOwnerDetail {
  readonly result: string;
  readonly executionPlan?: HostShellExecutionPlanAuditProjection;
  readonly uiPayload?: McpUiPayload;
}

export interface ConversationAssistantRound {
  readonly roundIndex: number;
  readonly text: string;
  readonly stopReason: "end_turn" | "tool_use" | "max_tokens";
  readonly hasToolCalls: boolean;
  /** Reasoning is intentionally owner-only by default. */
  readonly ownerDetail: {
    readonly thought: string;
    /**
     * Durable identity of the assistant row this round committed. Owner-only:
     * it is a handle onto the owner's own history, useless to a shared surface
     * and not something a shared surface may address.
     */
    readonly messageId: string;
  };
}

export interface ConversationPermissionReview {
  readonly status: PermissionReviewStatus;
  readonly tool: ConversationToolReference;
  readonly verdictLevel?: RiskLevel;
  /** Reason and generated approval purpose are owner-only review context. */
  readonly ownerDetail: {
    readonly reason?: string;
    readonly approvalPurpose?: ApprovalPurposeSuggestion;
  };
}

export type ConversationUsageReport = Parameters<
  NonNullable<TurnCallbacks["onTurnSummary"]>
>[0];

/**
 * Versioned semantic events emitted by a main conversation turn.
 *
 * The union is intentionally closed at this boundary. Adding a new producer
 * event means deciding its owner detail and the (separate) shared projection,
 * instead of silently exposing an arbitrary `(channel, payload)` object.
 */
export type PlatformConversationEvent =
  | { readonly kind: "turn.started" }
  /**
   * The user input that started this turn, published once per turn for EVERY
   * origin — keyboard, staged, queue, loopback, Tailnet, chat-platform bridge.
   * One stream, two origins: a surface that did not submit the turn learns the
   * turn's input from this event instead of a side channel, and each surface
   * adapter decides at its own single normalization point whether it already
   * rendered this input (the desktop renderer echoes its own submissions
   * optimistically and therefore only materializes external-surface origins).
   * The text is user content, so it is owner detail and never crosses the
   * shared projection.
   */
  | {
    readonly kind: "user.message";
    /** Host-resolved input provenance; a surface payload cannot supply it. */
    readonly origin: ChatInputOrigin;
    readonly ownerDetail: {
      readonly text: string;
      /**
       * Durable identity the host minted for the row this turn is about to
       * append. Announced with the input so a surface can bind the row it
       * renders to the row the host stored, without counting positions.
       * Owner-only for the same reason the round's id is.
       */
      readonly messageId: string;
      /**
       * The HOST started this turn, not a surface — so no surface has echoed a
       * row for it and every one of them has to draw this frame. Set by the
       * caller that submitted the turn, because that is the only place the
       * fact is known; a surface cannot infer it from the origin, which says
       * where the TEXT came from rather than who pressed send.
       */
      readonly hostSubmitted?: true;
    };
  }
  | { readonly kind: "assistant.reasoning.delta"; readonly ownerDetail: { readonly text: string } }
  | { readonly kind: "assistant.text.delta"; readonly text: string }
  | { readonly kind: "assistant.round.completed"; readonly round: ConversationAssistantRound }
  | {
    readonly kind: "tool.started";
    readonly tool: ConversationToolReference;
    readonly ownerDetail: ConversationToolStartOwnerDetail;
  }
  | {
    readonly kind: "tool.completed";
    readonly tool: ConversationToolReference;
    readonly isError: boolean;
    /** User stopped the turn while this call was running. */
    readonly cancelled?: boolean;
    readonly durationMs: number;
    readonly ownerDetail: ConversationToolEndOwnerDetail;
  }
  | { readonly kind: "permission.reviewed"; readonly review: ConversationPermissionReview }
  | {
    readonly kind: "turn.error";
    /**
     * Share-safe failure summary derived by the producer through
     * `deriveTurnFailureSummary()`. Portable by design: closed category union
     * plus a fixed table sentence, never the raw error message.
     */
    readonly failure?: TurnFailureSummary;
    readonly ownerDetail: {
      readonly message: string;
      readonly systemNotice?: "context-error" | "stream-error";
    };
  }
  | { readonly kind: "permission.mode.changed"; readonly mode: ExecutionMode }
  | {
    readonly kind: "compaction.started";
    readonly triggerSource: Parameters<NonNullable<TurnCallbacks["onCompactStarted"]>>[0]["triggerSource"];
    readonly estimatedBefore: number;
    readonly preflight: number;
  }
  | { readonly kind: "compaction.recovery.exhausted" }
  | {
    readonly kind: "compaction.completed";
    readonly removedMessages: number;
    readonly freedTokens: number;
    readonly estimatedAfter: number;
    readonly trigger?: "auto-compact" | "manual";
    readonly compactNum?: number;
    readonly compactStatus?: import("../shared/compact-status.js").CompressionStatus;
    /** Summary and filesystem path can contain user/private material. */
    readonly ownerDetail: { readonly summary?: string; readonly truncatedDir?: string };
  }
  | { readonly kind: "usage.reported"; readonly ownerDetail: ConversationUsageReport }
  | { readonly kind: "model.status"; readonly ownerDetail: { readonly status: FallbackStatus } }
  | { readonly kind: "model.fallback"; readonly from: string; readonly to: string }
  | {
    readonly kind: "guidance.applied";
    readonly text: string;
    /** Present when the whole injected batch was a sub-agent report. */
    readonly subAgentReport?: { readonly title?: string };
    /**
     * Durable identity of the user row this injection appended. Owner-only for
     * the same reason the turn's and the round's ids are: it is a handle onto
     * the owner's own history, useless to a shared surface.
     */
    readonly ownerDetail: { readonly messageId: string };
  }
  | { readonly kind: "guidance.dropped"; readonly text: string }
  | { readonly kind: "suggestions.updated"; readonly reply: string | null }
  | { readonly kind: "turn.completed"; readonly route?: "command" }
  | {
    readonly kind: "privacy.redacted";
    readonly count: number;
    readonly byKind: Readonly<Record<string, number>>;
  };

/** Context attached by the host when one producer emits an event. */
export interface PlatformConversationEventInput {
  /** Opaque, host-owned conversation/session identity. */
  readonly conversationId: string;
  /** Opaque, host-owned turn identity. Omitted for standalone mutations. */
  readonly turnId?: string;
  readonly event: PlatformConversationEvent;
  /** Semantic events are live-only unless an explicitly safe projector retains them. */
  readonly replay?: boolean;
}

/** The envelope every surface adapter receives from the common timeline. */
export interface PlatformConversationEventEnvelope {
  readonly version: PlatformConversationProtocolVersion;
  readonly eventId: string;
  readonly conversationId: string;
  readonly cursor: number;
  readonly turnId?: string;
  readonly emittedAt: number;
  readonly event: PlatformConversationEvent;
}

export type PlatformConversationEventListener = (
  event: PlatformConversationEventEnvelope,
) => void;

export interface PlatformConversationSubscriptionOptions {
  readonly conversationId?: string;
  readonly afterCursor?: number;
  readonly replay?: "none" | "available";
}

export interface PlatformConversationReplay {
  readonly conversationId: string;
  readonly afterCursor: number | null;
  readonly oldestRetainedCursor: number | null;
  readonly latestCursor: number;
  readonly snapshotRequired: boolean;
  readonly events: readonly PlatformConversationEventEnvelope[];
}

export interface PlatformConversationSubscription {
  readonly replay: PlatformConversationReplay | undefined;
  unsubscribe(): void;
}

/** One host-owned, ordered semantic timeline for all conversation surfaces. */
export interface PlatformConversationTimeline {
  publish(input: PlatformConversationEventInput): PlatformConversationEventEnvelope;
  subscribe(
    listener: PlatformConversationEventListener,
    options?: PlatformConversationSubscriptionOptions,
  ): PlatformConversationSubscription;
  read(
    conversationId: string,
    options?: { readonly afterCursor?: number },
  ): PlatformConversationReplay;
  subscriberCount(): number;
}

/**
 * Callback accepted by streamed-turn producers. It is intentionally semantic,
 * not an IPC/SSE channel plus arbitrary payload.
 */
export type PlatformConversationEventSink = (
  event: PlatformConversationEvent,
) => void;

/**
 * Host-owned correlation id for the current desktop compatibility adapter.
 *
 * The semantic protocol treats this as an opaque turn id. Keeping its legacy
 * numeric-stream mapping here means command producers do not depend on the
 * Electron/SSE adapter merely to allocate an event context.
 */
export function createPlatformTurnId(streamId: number): string {
  if (!Number.isSafeInteger(streamId) || streamId < 0) {
    throw new RangeError("streamId must be a non-negative safe integer.");
  }
  return `local-stream/${streamId}`;
}

/**
 * Temporary rich-owner transport shape. It is intentionally kept out of the
 * semantic producer contract; Electron IPC and the existing loopback SSE API
 * receive it only through a compatibility adapter.
 */
export type LegacyChatStreamSink = (channel: string, payload: unknown) => void;

const TIMELINE_CHANNEL = "platform.conversation.event";

/** Create an isolated semantic timeline backed by the bounded in-memory hub. */
export function createPlatformConversationTimeline(
  options: ConversationEventHubOptions = {},
): PlatformConversationTimeline {
  const hub = createConversationEventHub(options);

  const publish = (
    input: PlatformConversationEventInput,
  ): PlatformConversationEventEnvelope => {
    const envelope = hub.publish({
      sessionId: input.conversationId,
      channel: TIMELINE_CHANNEL,
      payload: input.event,
      ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
      // Owner-detail events are not a reconnect protocol. A later shared
      // projector owns bounded safe snapshots and replay; defaulting this to
      // false prevents a future adapter from accidentally replaying raw data.
      replay: input.replay ?? false,
    });
    return toPlatformEnvelope(envelope);
  };

  const read = (
    conversationId: string,
    options: { readonly afterCursor?: number } = {},
  ): PlatformConversationReplay => toPlatformReplay(hub.read(conversationId, options));

  const subscribe = (
    listener: PlatformConversationEventListener,
    options: PlatformConversationSubscriptionOptions = {},
  ): PlatformConversationSubscription => {
    const subscription = hub.subscribe(
      (envelope) => {
        // The hub is private to this timeline. Keeping this guard makes a
        // future internal hub reuse fail closed rather than delivering an
        // arbitrary generic payload to a platform adapter.
        if (envelope.channel !== TIMELINE_CHANNEL) return;
        listener(toPlatformEnvelope(envelope));
      },
      toHubSubscriptionOptions(options),
    );
    return {
      replay: subscription.replay === undefined
        ? undefined
        : toPlatformReplay(subscription.replay),
      unsubscribe: subscription.unsubscribe,
    };
  };

  return { publish, subscribe, read, subscriberCount: () => hub.subscriberCount() };
}

/**
 * Bind a producer to the host-owned conversation and turn identity. Publishing
 * is best-effort to preserve the existing display-stream invariant: an adapter
 * serialization issue must never abort the provider turn.
 */
export function createPlatformConversationEventSink(
  timeline: PlatformConversationTimeline,
  context: { readonly conversationId: string; readonly turnId?: string },
): PlatformConversationEventSink {
  return (event) => {
    try {
      timeline.publish({
        conversationId: context.conversationId,
        ...(context.turnId === undefined ? {} : { turnId: context.turnId }),
        event,
      });
    } catch {
      // Match the historical display sink: a malformed/uncloneable rich owner
      // detail cannot change model execution or block another surface.
    }
  };
}

/**
 * Future shared surfaces use only this explicit whitelist projection. This is
 * a pure transform over the one canonical event; it is not another event hub
 * and does not imply that the caller is authorized to receive the result.
 */
export type SharedConversationProjectionEvent =
  | { readonly kind: "turn.started" }
  | { readonly kind: "assistant.text.delta"; readonly text: string }
  | { readonly kind: "tool.state"; readonly state: "running" | "completed" | "failed" | "cancelled" }
  | {
    readonly kind: "approval.waiting-local";
    /**
     * Coarse safe tool identifier ("builtin:list_files"). Never tool
     * arguments, paths, request payloads, or review reasons; a name outside
     * the conservative identifier grammar is dropped rather than forwarded.
     */
    readonly tool?: string;
  }
  | { readonly kind: "compaction.started" }
  | { readonly kind: "compaction.completed" }
  | { readonly kind: "turn.failed"; readonly failure?: TurnFailureSummary }
  | { readonly kind: "turn.completed" };

export function projectSharedConversationEvent(
  event: PlatformConversationEvent,
): SharedConversationProjectionEvent | undefined {
  switch (event.kind) {
    case "turn.started":
      return { kind: "turn.started" };
    case "user.message":
      // Deliberately NOT shared: a remote chat surface already shows the
      // sender their own message in its native conversation, so projecting the
      // turn input back out would duplicate every remote turn (and leak other
      // surfaces' input text to observers that only hold the safe projection).
      // Owner surfaces receive it through the owner-detail compatibility
      // adapter instead.
      return undefined;
    case "assistant.text.delta":
      return { kind: "assistant.text.delta", text: event.text };
    case "tool.started":
      return { kind: "tool.state", state: "running" };
    case "tool.completed":
      // A user stop is reported as its own state; remote surfaces should not
      // show "failed" for something the user deliberately halted.
      return {
        kind: "tool.state",
        state: event.cancelled ? "cancelled" : event.isError ? "failed" : "completed",
      };
    case "permission.reviewed": {
      if (event.review.status !== "needs_approval") return undefined;
      const tool = sharedApprovalToolIdentifier(event.review.tool);
      return tool === undefined
        ? { kind: "approval.waiting-local" }
        : { kind: "approval.waiting-local", tool };
    }
    case "compaction.started":
      return { kind: "compaction.started" };
    case "compaction.completed":
      return { kind: "compaction.completed" };
    case "turn.error": {
      // Re-validate even our own producer's summary: only the whitelisted
      // fields flow, with the category checked against the closed union and
      // the sentence defensively truncated.
      const failure = toSafeTurnFailureSummary(event.failure);
      return failure === undefined
        ? { kind: "turn.failed" }
        : { kind: "turn.failed", failure };
    }
    case "turn.completed":
      return { kind: "turn.completed" };
    default:
      return undefined;
  }
}

/**
 * Registered tool names are host-controlled identifiers, but this projection
 * feeds remote surfaces, so it validates against the one shared grammar
 * instead of trusting the producer, and drops a non-conforming name rather
 * than forwarding it.
 */
function sharedApprovalToolIdentifier(
  tool: ConversationToolReference,
): string | undefined {
  if (typeof tool.name !== "string") return undefined;
  const identifier = tool.source === undefined ? tool.name : `${tool.source}:${tool.name}`;
  return isSharedApprovalToolIdentifier(identifier) ? identifier : undefined;
}

function toHubSubscriptionOptions(
  options: PlatformConversationSubscriptionOptions,
): ConversationEventSubscriptionOptions {
  return {
    ...(options.conversationId === undefined
      ? {}
      : { sessionId: options.conversationId }),
    ...(options.afterCursor === undefined ? {} : { afterCursor: options.afterCursor }),
    ...(options.replay === undefined ? {} : { replay: options.replay }),
  };
}

function toPlatformEnvelope(
  envelope: ReturnType<ConversationEventHub["publish"]>,
): PlatformConversationEventEnvelope {
  if (envelope.channel !== TIMELINE_CHANNEL) {
    throw new TypeError("Conversation timeline received an unexpected channel.");
  }
  return {
    version: PLATFORM_CONVERSATION_PROTOCOL_VERSION,
    eventId: envelope.eventId,
    conversationId: envelope.sessionId,
    cursor: envelope.cursor,
    ...(envelope.turnId === undefined ? {} : { turnId: envelope.turnId }),
    emittedAt: envelope.emittedAt,
    event: envelope.payload as PlatformConversationEvent,
  };
}

function toPlatformReplay(replay: ConversationEventReplay): PlatformConversationReplay {
  return {
    conversationId: replay.sessionId,
    afterCursor: replay.afterCursor,
    oldestRetainedCursor: replay.oldestRetainedCursor,
    latestCursor: replay.latestCursor,
    snapshotRequired: replay.snapshotRequired,
    events: replay.events.map((event) => toPlatformEnvelope(event)),
  };
}
