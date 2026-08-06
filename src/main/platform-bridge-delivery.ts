/**
 * Safe outbound delivery boundary for future chat-platform bridges.
 *
 * This module deliberately consumes only the already-projected shared snapshot
 * and event shapes.  It does not import the platform timeline or any owner
 * event type, so a provider adapter cannot accidentally serialize reasoning,
 * tool arguments/results, attachment bytes, paths, or private session detail.
 */
import type {
  SharedConversationEventEnvelope,
  SharedConversationProjectionStore,
  SharedConversationProjectionSubscription,
  SharedConversationSnapshot,
} from "../engine/shared-conversation-projection.js";

const DEFAULT_MAX_CHANNELS = 128;
const DEFAULT_MAX_PENDING_MESSAGES_PER_CHANNEL = 64;
/**
 * UTF-16 code units, not Unicode code points: every provider length limit this
 * module has to respect is expressed in the same unit as `String.length`, and
 * counting scalar values instead silently doubles an emoji-heavy payload.
 */
const DEFAULT_MAX_TEXT_CHARS = 4_096;

/** The only coarse status values a bridge provider may render. */
export type PlatformBridgeOutboundStatus =
  | "idle"
  | "running"
  | "awaiting-local-approval"
  | "turn-started"
  | "tool-running"
  | "tool-completed"
  | "tool-failed"
  | "compaction-started"
  | "compaction-completed"
  | "turn-failed"
  | "turn-completed";

/**
 * Provider-neutral, share-safe output.  In particular it intentionally omits
 * the source conversation id, timestamps, provider credentials, and raw event
 * union; a bridge already knows its paired destination and needs none of them.
 */
export type PlatformBridgeOutboundMessage =
  | {
    readonly kind: "snapshot";
    readonly cursor: number;
    readonly status: "idle" | "running" | "awaiting-local-approval";
    readonly text: string;
  }
  | {
    readonly kind: "text";
    readonly cursor: number;
    readonly text: string;
  }
  | {
    readonly kind: "status";
    readonly cursor: number;
    readonly status: Exclude<PlatformBridgeOutboundStatus, "idle" | "running">;
  };

/**
 * The only provider-specific extension point.  Discord, Telegram, and later
 * transports authenticate and format their own wire at their edge; they never
 * receive an owner timeline event from this module.
 */
export interface PlatformBridgeDeliveryTransport<TChannel> {
  /**
   * Providers must honor signal and fence generation: a closed or
   * re-paired destination must not publish an old queued message afterwards.
   */
  send(
    channel: TChannel,
    message: PlatformBridgeOutboundMessage,
    options: PlatformBridgeDeliveryTransportSendOptions,
  ): Promise<void>;
}

/** Host-owned egress fence passed to the provider adapter for every send. */
export interface PlatformBridgeDeliveryTransportSendOptions {
  readonly signal: AbortSignal;
  /** New on every openChannel, including a re-pair of the same destination. */
  readonly generation: number;
}

export type PlatformBridgeDeliveryEnqueueResult =
  | "accepted"
  | "duplicate"
  | "conversation-mismatch"
  | "closed"
  | "backpressure"
  | "invalid";

export interface PlatformBridgeDeliveryChannelState {
  /** Accepted projection cursor; -1 means no snapshot/event has been accepted. */
  readonly lastAcceptedCursor: number;
  /** Includes an in-flight provider send so the real memory bound is visible. */
  readonly pendingMessages: number;
  readonly closed: boolean;
}

export interface PlatformBridgeDeliveryChannel {
  /** Queue one already-safe snapshot for this paired destination. */
  enqueueSnapshot(snapshot: SharedConversationSnapshot): PlatformBridgeDeliveryEnqueueResult;
  /** Queue one already-safe projection event for this paired destination. */
  enqueueEvent(event: SharedConversationEventEnvelope): PlatformBridgeDeliveryEnqueueResult;
  /**
   * Subscribe to one projection store after sending a fresh snapshot.  A
   * channel can attach once; reconnecting callers close and open a new channel
   * so no old subscription or cursor state can bleed into a new pairing.
   */
  attach(
    store: SharedConversationProjectionStore,
    getHostState: () => { readonly busy: boolean },
  ): void;
  /** Stop future delivery and discard every not-yet-sent safe message. */
  close(): void;
  /** Resolve after the current bounded queue is drained or closed. */
  waitForIdle(): Promise<void>;
  state(): PlatformBridgeDeliveryChannelState;
}

export interface PlatformBridgeDeliveryAdapter<TChannel> {
  /**
   * Register one provider destination after its pairing/authorization layer
   * has bound it to a private conversation id.  That id remains internal and
   * is never copied into a provider message.
   */
  openChannel(channel: TChannel, conversationId: string): PlatformBridgeDeliveryChannel;
  /** Idempotently detach one provider destination. */
  closeChannel(channel: TChannel): void;
  /** Idempotently detach every provider destination. */
  close(): void;
  channelCount(): number;
}

/**
 * One already-safe projection message waiting for a provider transport.
 *
 * A provider may compact only this bounded, safe representation; it never
 * receives the owner timeline or a private conversation id.
 */
export interface PlatformBridgeDeliveryQueuedMessage {
  readonly cursor: number;
  readonly message: PlatformBridgeOutboundMessage;
}

/**
 * Provider-specific compaction for messages that have not been handed to the
 * transport yet. The currently in-flight message is deliberately excluded.
 */
type PlatformBridgeDeliveryQueueCoalescer = (
  queued: readonly PlatformBridgeDeliveryQueuedMessage[],
  incoming: PlatformBridgeDeliveryQueuedMessage,
  maxTextChars: number,
) => readonly PlatformBridgeDeliveryQueuedMessage[];

export interface CreatePlatformBridgeDeliveryAdapterOptions<TChannel> {
  readonly transport: PlatformBridgeDeliveryTransport<TChannel>;
  /** Bound active destinations as well as queues; defaults to 128. */
  readonly maxChannels?: number;
  /** Bound undelivered messages per channel, including an in-flight send; defaults to 64. */
  readonly maxPendingMessagesPerChannel?: number;
  /** Bound each outgoing text chunk independently of projection retention; defaults to 4,096 UTF-16 code units. */
  readonly maxTextChars?: number;
  /**
   * Optional provider-owned compaction of not-yet-sent safe messages. It is
   * invoked before the queue capacity check so a rate-limited transport can
   * retain a bounded, latest-safe view without changing the canonical stream.
   */
  readonly coalesceQueuedMessages?: PlatformBridgeDeliveryQueueCoalescer;
  /** A slow channel is closed rather than silently dropping a partial transcript. */
  readonly onBackpressure?: (channel: TChannel) => void;
  /** A provider failure closes only its channel and never throws into the projection producer. */
  readonly onDeliveryFailure?: (channel: TChannel) => void;
}

type PendingMessage = PlatformBridgeDeliveryQueuedMessage;

type ChannelRecord<TChannel> = {
  readonly channel: TChannel;
  readonly conversationId: string;
  readonly generation: number;
  readonly abortController: AbortController;
  lastAcceptedCursor: number;
  queue: PendingMessage[];
  sending: boolean;
  closed: boolean;
  subscription: SharedConversationProjectionSubscription | undefined;
  drainPromise: Promise<void> | undefined;
};

/**
 * Create one host-owned safe fan-out adapter.  It is intentionally not a
 * second event hub: callers feed it an authorized `SharedConversationProjectionStore`
 * subscription, and its per-channel queue merely isolates provider latency.
 */
export function createPlatformBridgeDeliveryAdapter<TChannel>(
  options: CreatePlatformBridgeDeliveryAdapterOptions<TChannel>,
): PlatformBridgeDeliveryAdapter<TChannel> {
  if (!options || typeof options !== "object" || typeof options.transport?.send !== "function") {
    throw new TypeError("platform-bridge-delivery-transport-invalid");
  }
  const maxChannels = positiveInteger(options.maxChannels ?? DEFAULT_MAX_CHANNELS, "maxChannels");
  const maxPendingMessages = positiveInteger(
    options.maxPendingMessagesPerChannel ?? DEFAULT_MAX_PENDING_MESSAGES_PER_CHANNEL,
    "maxPendingMessagesPerChannel",
  );
  const maxTextChars = positiveInteger(options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS, "maxTextChars");
  const channels = new Map<TChannel, ChannelRecord<TChannel>>();
  let nextGeneration = 0;

  const isCurrent = (record: ChannelRecord<TChannel>): boolean =>
    !record.closed && channels.get(record.channel) === record;

  const reportBackpressure = (channel: TChannel): void => {
    try {
      options.onBackpressure?.(channel);
    } catch {
      // Observability must not revive a detached provider destination.
    }
  };

  const reportDeliveryFailure = (channel: TChannel): void => {
    try {
      options.onDeliveryFailure?.(channel);
    } catch {
      // A callback failure cannot affect the canonical conversation producer.
    }
  };

  const closeRecord = (record: ChannelRecord<TChannel>): void => {
    if (record.closed) return;
    record.closed = true;
    record.abortController.abort();
    record.queue.length = 0;
    record.subscription?.unsubscribe();
    record.subscription = undefined;
    if (channels.get(record.channel) === record) channels.delete(record.channel);
  };

  const startDrain = (record: ChannelRecord<TChannel>): void => {
    if (!isCurrent(record) || record.sending || record.queue.length === 0) return;
    record.sending = true;
    const drain = (async () => {
      while (isCurrent(record) && record.queue.length > 0) {
        // Keep the in-flight message in the queue until it settles.  Queue
        // length therefore bounds both buffered and actively delivered data.
        const next = record.queue[0]!;
        try {
          if (record.abortController.signal.aborted) return;
          await options.transport.send(record.channel, next.message, {
            signal: record.abortController.signal,
            generation: record.generation,
          });
        } catch {
          // A rejected old/aborted send is not a failure of a newer pairing
          // that reused the same provider destination key.
          if (!isCurrent(record)) return;
          reportDeliveryFailure(record.channel);
          closeRecord(record);
          return;
        }
        if (!isCurrent(record)) return;
        if (record.queue[0] === next) record.queue.shift();
      }
    })();
    record.drainPromise = drain.finally(() => {
      record.sending = false;
      record.drainPromise = undefined;
      // A producer can append while the final async continuation is pending.
      startDrain(record);
    });
  };

  const enqueueMessage = (
    record: ChannelRecord<TChannel>,
    entry: PendingMessage,
  ): PlatformBridgeDeliveryEnqueueResult => {
    if (!isCurrent(record)) return "closed";
    if (options.coalesceQueuedMessages !== undefined) {
      const inFlight = record.sending ? record.queue[0] : undefined;
      const queued = record.queue.slice(inFlight === undefined ? 0 : 1);
      let compacted: readonly PlatformBridgeDeliveryQueuedMessage[];
      let normalized: PendingMessage[];
      try {
        compacted = options.coalesceQueuedMessages(
          queued.map(copyQueuedMessage),
          copyQueuedMessage(entry),
          maxTextChars,
        );
        if (Array.isArray(compacted) && compacted.length + (inFlight === undefined ? 0 : 1) > maxPendingMessages) {
          closeRecord(record);
          reportBackpressure(record.channel);
          return "backpressure";
        }
        if (!isValidCompactedQueue(compacted, inFlight, entry.cursor, maxTextChars)) {
          throw new Error("platform-bridge-delivery-coalescer-invalid-output");
        }
        normalized = compacted.map((candidate) => normalizeQueuedMessage(candidate, maxTextChars));
      } catch {
        closeRecord(record);
        reportDeliveryFailure(record.channel);
        return "closed";
      }
      record.queue = inFlight === undefined ? normalized : [inFlight, ...normalized];
      if (record.queue.length > maxPendingMessages) {
        closeRecord(record);
        reportBackpressure(record.channel);
        return "backpressure";
      }
      startDrain(record);
      return "accepted";
    }
    if (record.queue.length >= maxPendingMessages) {
      closeRecord(record);
      reportBackpressure(record.channel);
      return "backpressure";
    }
    record.queue.push(entry);
    startDrain(record);
    return "accepted";
  };

  const enqueueSnapshot = (
    record: ChannelRecord<TChannel>,
    snapshot: SharedConversationSnapshot,
  ): PlatformBridgeDeliveryEnqueueResult => {
    if (!isCurrent(record)) return "closed";
    if (snapshot.conversationId !== record.conversationId) return "conversation-mismatch";
    if (!validCursor(snapshot.cursor)) return "invalid";
    if (snapshot.cursor <= record.lastAcceptedCursor) return "duplicate";

    record.lastAcceptedCursor = snapshot.cursor;
    // A newer snapshot is a safe resync barrier.  It supersedes pending older
    // updates, but cannot cancel a provider request already handed to transport.
    discardQueuedAtOrBefore(record, snapshot.cursor);
    return enqueueMessage(record, {
      cursor: snapshot.cursor,
      message: toSnapshotMessage(snapshot, maxTextChars),
    });
  };

  const enqueueEvent = (
    record: ChannelRecord<TChannel>,
    event: SharedConversationEventEnvelope,
  ): PlatformBridgeDeliveryEnqueueResult => {
    if (!isCurrent(record)) return "closed";
    if (event.conversationId !== record.conversationId) return "conversation-mismatch";
    if (!validCursor(event.cursor) || event.cursor < 1) return "invalid";
    if (event.cursor <= record.lastAcceptedCursor) return "duplicate";

    record.lastAcceptedCursor = event.cursor;
    const message = toEventMessage(event, maxTextChars);
    // Empty assistant deltas have no provider-visible effect, but their cursor
    // is still consumed so a forged/replayed duplicate cannot later be sent.
    return message === undefined
      ? "accepted"
      : enqueueMessage(record, { cursor: event.cursor, message });
  };

  const waitForIdle = async (record: ChannelRecord<TChannel>): Promise<void> => {
    // A shutdown/revoke must never wait indefinitely for a provider that
    // ignores cancellation. The AbortSignal and generation are its egress
    // fence; closed channels resolve immediately.
    if (!isCurrent(record)) return;

    // Draining can schedule one follow-up pass in its finally continuation.
    // Loop until the observed promise is still the final one.
    for (;;) {
      const pending = record.drainPromise;
      if (pending === undefined) return;
      await pending;
      if (record.drainPromise === undefined || record.drainPromise === pending) return;
    }
  };

  const toChannelHandle = (record: ChannelRecord<TChannel>): PlatformBridgeDeliveryChannel => ({
    enqueueSnapshot: (snapshot) => enqueueSnapshot(record, snapshot),
    enqueueEvent: (event) => enqueueEvent(record, event),
    attach: (store, getHostState) => {
      if (!isCurrent(record)) return;
      if (record.subscription !== undefined) {
        throw new Error("platform-bridge-delivery-channel-already-attached");
      }
      const snapshot = store.snapshot(record.conversationId, getHostState());
      enqueueSnapshot(record, snapshot);
      if (!isCurrent(record)) return;
      const subscription = store.subscribe(
        record.conversationId,
        (event) => {
          enqueueEvent(record, event);
        },
        { afterCursor: snapshot.cursor },
      );
      record.subscription = subscription;
      if (subscription.replay.snapshotRequired) {
        // A fresh snapshot is safer than treating an unavailable replay tail as
        // a complete transcript.  This should be rare because the subscription
        // starts from the just-read snapshot cursor.
        enqueueSnapshot(record, store.snapshot(record.conversationId, getHostState()));
        return;
      }
      for (const event of subscription.replay.events) {
        enqueueEvent(record, event);
      }
    },
    close: () => closeRecord(record),
    waitForIdle: () => waitForIdle(record),
    state: () => ({
      lastAcceptedCursor: record.lastAcceptedCursor,
      pendingMessages: record.queue.length,
      closed: record.closed || channels.get(record.channel) !== record,
    }),
  });

  return {
    openChannel: (channel, conversationId) => {
      if (typeof conversationId !== "string" || conversationId.length === 0) {
        throw new TypeError("platform-bridge-delivery-conversation-invalid");
      }
      const existing = channels.get(channel);
      if (existing) closeRecord(existing);
      if (channels.size >= maxChannels) {
        throw new RangeError("platform-bridge-delivery-channel-capacity-reached");
      }
      if (nextGeneration >= Number.MAX_SAFE_INTEGER) {
        throw new RangeError("platform-bridge-delivery-generation-exhausted");
      }
      nextGeneration += 1;
      const record: ChannelRecord<TChannel> = {
        channel,
        conversationId,
        generation: nextGeneration,
        abortController: new AbortController(),
        lastAcceptedCursor: -1,
        queue: [],
        sending: false,
        closed: false,
        subscription: undefined,
        drainPromise: undefined,
      };
      channels.set(channel, record);
      return toChannelHandle(record);
    },
    closeChannel: (channel) => {
      const record = channels.get(channel);
      if (record) closeRecord(record);
    },
    close: () => {
      for (const record of [...channels.values()]) closeRecord(record);
    },
    channelCount: () => channels.size,
  };
}

function copyQueuedMessage(
  entry: PlatformBridgeDeliveryQueuedMessage,
): PlatformBridgeDeliveryQueuedMessage {
  return {
    cursor: entry.cursor,
    message: copyOutboundMessage(entry.message),
  };
}

function normalizeQueuedMessage(
  entry: PlatformBridgeDeliveryQueuedMessage,
  maxTextChars: number,
): PendingMessage {
  return {
    cursor: entry.cursor,
    message: normalizeOutboundMessage(entry.message, maxTextChars),
  };
}

function copyOutboundMessage(message: PlatformBridgeOutboundMessage): PlatformBridgeOutboundMessage {
  switch (message.kind) {
    case "snapshot":
      return { kind: "snapshot", cursor: message.cursor, status: message.status, text: message.text };
    case "text":
      return { kind: "text", cursor: message.cursor, text: message.text };
    case "status":
      return { kind: "status", cursor: message.cursor, status: message.status };
  }
}

function normalizeOutboundMessage(
  message: PlatformBridgeOutboundMessage,
  maxTextChars: number,
): PlatformBridgeOutboundMessage {
  switch (message.kind) {
    case "snapshot":
      return {
        kind: "snapshot",
        cursor: message.cursor,
        status: message.status,
        text: safeText(message.text, maxTextChars),
      };
    case "text":
      return { kind: "text", cursor: message.cursor, text: safeText(message.text, maxTextChars) };
    case "status":
      return { kind: "status", cursor: message.cursor, status: message.status };
  }
}

function isValidCompactedQueue(
  value: unknown,
  inFlight: PendingMessage | undefined,
  incomingCursor: number,
  maxTextChars: number,
): value is readonly PlatformBridgeDeliveryQueuedMessage[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  let previousCursor = inFlight?.cursor ?? -1;
  for (const entry of value) {
    if (!isValidQueuedMessage(entry, previousCursor, incomingCursor, maxTextChars)) return false;
    previousCursor = entry.cursor;
  }
  return previousCursor === incomingCursor;
}

function isValidQueuedMessage(
  value: unknown,
  previousCursor: number,
  incomingCursor: number,
  maxTextChars: number,
): value is PlatformBridgeDeliveryQueuedMessage {
  if (!value || typeof value !== "object") return false;
  const entry = value as { cursor?: unknown; message?: unknown };
  return typeof entry.cursor === "number"
    && validCursor(entry.cursor)
    && entry.cursor >= previousCursor
    && entry.cursor <= incomingCursor
    && isValidOutboundMessage(entry.message, entry.cursor, maxTextChars);
}

function isValidOutboundMessage(
  value: unknown,
  cursor: number,
  maxTextChars: number,
): value is PlatformBridgeOutboundMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as { kind?: unknown; cursor?: unknown; status?: unknown; text?: unknown };
  if (message.cursor !== cursor) return false;
  switch (message.kind) {
    case "snapshot":
      return isSnapshotStatus(message.status) && isSafeOutboundText(message.text, maxTextChars);
    case "text":
      return isSafeOutboundText(message.text, maxTextChars);
    case "status":
      return isEventStatus(message.status);
    default:
      return false;
  }
}

function isSafeOutboundText(value: unknown, maxTextChars: number): value is string {
  return typeof value === "string" && value === safeText(value, maxTextChars);
}

function isSnapshotStatus(value: unknown): value is "idle" | "running" | "awaiting-local-approval" {
  return value === "idle" || value === "running" || value === "awaiting-local-approval";
}

function isEventStatus(value: unknown): value is Exclude<PlatformBridgeOutboundStatus, "idle" | "running"> {
  return value === "awaiting-local-approval"
    || value === "turn-started"
    || value === "tool-running"
    || value === "tool-completed"
    || value === "tool-failed"
    || value === "compaction-started"
    || value === "compaction-completed"
    || value === "turn-failed"
    || value === "turn-completed";
}

function toSnapshotMessage(
  snapshot: SharedConversationSnapshot,
  maxTextChars: number,
): PlatformBridgeOutboundMessage {
  return {
    kind: "snapshot",
    cursor: snapshot.cursor,
    status: snapshot.awaitingLocalApproval
      ? "awaiting-local-approval"
      : snapshot.busy
        ? "running"
        : "idle",
    // The projection retains the tail of a long assistant reply; keeping the
    // head here would resend its oldest retained window on every reconnect.
    text: safeTrailingText(snapshot.assistantText, maxTextChars),
  };
}

function toEventMessage(
  event: SharedConversationEventEnvelope,
  maxTextChars: number,
): PlatformBridgeOutboundMessage | undefined {
  switch (event.event.kind) {
    case "assistant.text.delta": {
      const text = safeText(event.event.text, maxTextChars);
      return text.length === 0 ? undefined : { kind: "text", cursor: event.cursor, text };
    }
    case "turn.started":
      return statusMessage(event.cursor, "turn-started");
    case "tool.state":
      return statusMessage(
        event.cursor,
        event.event.state === "running"
          ? "tool-running"
          : event.event.state === "completed"
            ? "tool-completed"
            : "tool-failed",
      );
    case "approval.waiting-local":
      return statusMessage(event.cursor, "awaiting-local-approval");
    case "compaction.started":
      return statusMessage(event.cursor, "compaction-started");
    case "compaction.completed":
      return statusMessage(event.cursor, "compaction-completed");
    case "turn.failed":
      return statusMessage(event.cursor, "turn-failed");
    case "turn.completed":
      return statusMessage(event.cursor, "turn-completed");
  }
}

function statusMessage(
  cursor: number,
  status: Exclude<PlatformBridgeOutboundStatus, "idle" | "running">,
): PlatformBridgeOutboundMessage {
  return { kind: "status", cursor, status };
}

function discardQueuedAtOrBefore<TChannel>(record: ChannelRecord<TChannel>, cursor: number): void {
  const inFlight = record.sending ? record.queue[0] : undefined;
  const later = record.queue
    .slice(inFlight === undefined ? 0 : 1)
    .filter((entry) => entry.cursor > cursor);
  record.queue = inFlight === undefined ? later : [inFlight, ...later];
}

/**
 * Sanitize and keep the OLDEST `maxTextChars` UTF-16 code units.
 *
 * A surrogate pair is kept or dropped whole, so the bound stops one unit early
 * rather than emitting half of an astral character.
 */
function safeText(value: string, maxTextChars: number): string {
  let output = "";
  let unitCount = 0;
  for (let index = 0; index < value.length && unitCount < maxTextChars;) {
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) break;
    const width = codePoint > 0xffff ? 2 : 1;
    if (!isUnsafeSharedTextCodePoint(codePoint) && !(codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      if (unitCount + width > maxTextChars) break;
      output += value.slice(index, index + width);
      unitCount += width;
    }
    index += width;
  }
  return output;
}

/**
 * Sanitize and keep the NEWEST `maxTextChars` UTF-16 code units.
 *
 * Snapshot text is the retained tail of a long reply, so bounding its head
 * would deliver the oldest retained words and drop the ones the reader is
 * waiting for. Exported so a provider coalescer applies this identical rule
 * instead of deriving a second, drifting one.
 */
export function safeTrailingText(value: string, maxTextChars: number): string {
  const sanitized = safeText(value, Number.MAX_SAFE_INTEGER);
  if (sanitized.length <= maxTextChars) return sanitized;
  const start = sanitized.length - maxTextChars;
  // Never begin on the trailing half of a surrogate pair.
  const unit = sanitized.charCodeAt(start);
  return sanitized.slice(unit >= 0xdc00 && unit <= 0xdfff ? start + 1 : start);
}

function isUnsafeSharedTextCodePoint(codePoint: number): boolean {
  return (codePoint >= 0 && codePoint <= 0x08)
    || codePoint === 0x0b
    || codePoint === 0x0c
    || (codePoint >= 0x0e && codePoint <= 0x1f)
    || codePoint === 0x7f;
}

function validCursor(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`platform-bridge-delivery-${name}-invalid`);
  }
  return value;
}
