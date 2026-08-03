/**
 * A process-local, vendor-neutral event hub for one or more conversation
 * surfaces. Transport adapters own authentication, authorization, projection,
 * and serialization; this module owns only ordered in-memory delivery.
 */

/** Stable wire version for {@link ConversationEventEnvelope}. */
export const CONVERSATION_EVENT_PROTOCOL_VERSION = 1 as const;

export type ConversationEventProtocolVersion =
  typeof CONVERSATION_EVENT_PROTOCOL_VERSION;

/**
 * A payload supplied by a producer. Payloads must be structured-cloneable so
 * the hub can keep every producer and subscriber isolated from one another.
 */
export type ConversationEventPayload = unknown;

/** Input used to publish one event into a conversation session. */
export interface ConversationEventInput<TPayload = ConversationEventPayload> {
  /** Opaque, host-owned conversation/session identity. */
  readonly sessionId: string;
  /** Vendor-neutral event name, for example `assistant.delta` or `turn.done`. */
  readonly channel: string;
  /** Opaque structured-cloneable data. Projection belongs to surface adapters. */
  readonly payload: TPayload;
  /** Optional host-owned turn identity. */
  readonly turnId?: string;
  /** Set false for a live-only event that must not occupy the replay window. */
  readonly replay?: boolean;
}

/**
 * Versioned event envelope delivered to every matching surface adapter.
 *
 * `cursor` is monotonically increasing within `sessionId`; it is not a global
 * ordering across sessions. `eventId` is deterministic for a hub lifetime and
 * is suitable as a stable deduplication key together with its session.
 */
export interface ConversationEventEnvelope<
  TPayload = ConversationEventPayload,
> {
  readonly version: ConversationEventProtocolVersion;
  readonly eventId: string;
  readonly sessionId: string;
  readonly cursor: number;
  readonly channel: string;
  readonly turnId?: string;
  readonly emittedAt: number;
  readonly payload: TPayload;
}

/**
 * A synchronous listener owned by a display, CLI, bot, or other surface adapter.
 * Async work must be queued by the adapter so rejected promises cannot escape the
 * hub's isolated synchronous delivery loop.
 */
export type ConversationEventListener = (
  event: ConversationEventEnvelope,
) => void;

/** Optional filter and bounded replay delivery for one subscriber. */
export interface ConversationEventSubscriptionOptions {
  /** Limit live delivery, and optional replay, to exactly one session. */
  readonly sessionId?: string;
  /** Receive retained events strictly after this session-local cursor. */
  readonly afterCursor?: number;
  /** Deliver retained events before future live events. Defaults to `none`. */
  readonly replay?: "none" | "available";
}

/**
 * A bounded replay read. When `snapshotRequired` is true, an adapter must
 * obtain host-owned current session state before treating the returned events
 * as a complete catch-up.
 */
export interface ConversationEventReplay {
  readonly sessionId: string;
  readonly afterCursor: number | null;
  readonly oldestRetainedCursor: number | null;
  readonly latestCursor: number;
  readonly snapshotRequired: boolean;
  readonly events: readonly ConversationEventEnvelope[];
}

/** A subscription plus its initial replay status, if it is session-scoped. */
export interface ConversationEventSubscription {
  readonly replay: ConversationEventReplay | undefined;
  /** Idempotently stop future delivery to this adapter. */
  unsubscribe(): void;
}

export interface ConversationEventHubOptions {
  /** Maximum retained events per session; defaults to 256 and may be zero. */
  readonly replayLimitPerSession?: number;
  /**
   * Maximum tracked session states before inactive least-recently-used state is
   * evicted. Session-scoped subscribers pin their own state until unsubscribe.
   */
  readonly maxTrackedSessions?: number;
  /** Test seam for envelope timestamps. Must return a finite number. */
  readonly now?: () => number;
}

export interface ConversationEventHub {
  /** Publish one event and synchronously fan it out to matching subscribers. */
  publish<TPayload>(
    input: ConversationEventInput<TPayload>,
  ): ConversationEventEnvelope<TPayload>;
  /** Subscribe a surface adapter. A throwing listener is isolated from others. */
  subscribe(
    listener: ConversationEventListener,
    options?: ConversationEventSubscriptionOptions,
  ): ConversationEventSubscription;
  /** Read the bounded retained tail for one session without subscribing. */
  read(
    sessionId: string,
    options?: { readonly afterCursor?: number },
  ): ConversationEventReplay;
  /** Number of currently active surface adapters. */
  subscriberCount(): number;
}

type StoredSession = {
  latestCursor: number;
  events: ConversationEventEnvelope[];
};

type Subscriber = {
  listener: ConversationEventListener;
  sessionId: string | undefined;
  active: boolean;
  delivering: boolean;
  pending: ConversationEventEnvelope[];
};

const DEFAULT_REPLAY_LIMIT_PER_SESSION = 256;
const DEFAULT_MAX_TRACKED_SESSIONS = 256;

/**
 * Create an empty conversation event hub. It deliberately has no transport,
 * auth, persistence, or privacy policy knowledge: adapters must enforce those
 * concerns before publishing and before rendering received payloads.
 */
export function createConversationEventHub(
  options: ConversationEventHubOptions = {},
): ConversationEventHub {
  const replayLimit = validateReplayLimit(
    options.replayLimitPerSession ?? DEFAULT_REPLAY_LIMIT_PER_SESSION,
  );
  const maxTrackedSessions = validateTrackedSessionLimit(
    options.maxTrackedSessions ?? DEFAULT_MAX_TRACKED_SESSIONS,
  );
  const now = options.now ?? Date.now;
  const sessions = new Map<string, StoredSession>();
  const cursorTombstones = new Map<string, number>();
  let publishedEventCount = 0;
  let hasForgottenCursorTombstone = false;
  const subscribers = new Set<Subscriber>();

  function publish<TPayload>(
    input: ConversationEventInput<TPayload>,
  ): ConversationEventEnvelope<TPayload> {
    const sessionId = validateOpaqueId(input.sessionId, "sessionId");
    const channel = validateOpaqueId(input.channel, "channel");
    const turnId = input.turnId === undefined
      ? undefined
      : validateOpaqueId(input.turnId, "turnId");
    const emittedAt = now();
    if (!Number.isFinite(emittedAt)) {
      throw new RangeError("Conversation event clock must return a finite number.");
    }

    const existingSession = getTrackedSession(sessionId);
    const tombstoneLatestCursor = existingSession === undefined
      ? getCursorTombstone(sessionId)
      : undefined;
    const nextPublishedEventCount = publishedEventCount + 1;
    const session = existingSession ?? {
      latestCursor: tombstoneLatestCursor
        ?? (hasForgottenCursorTombstone ? nextPublishedEventCount - 1 : 0),
      events: [],
    };
    const cursor = session.latestCursor + 1;
    const stored = cloneEnvelope({
      version: CONVERSATION_EVENT_PROTOCOL_VERSION,
      eventId: createEventId(sessionId, cursor),
      sessionId,
      cursor,
      channel,
      ...(turnId === undefined ? {} : { turnId }),
      emittedAt,
      payload: input.payload,
    }) as ConversationEventEnvelope;

    session.latestCursor = cursor;
    if (input.replay !== false && replayLimit > 0) {
      session.events.push(stored);
      if (session.events.length > replayLimit) {
        session.events.splice(0, session.events.length - replayLimit);
      }
    }
    if (existingSession === undefined && tombstoneLatestCursor !== undefined) {
      cursorTombstones.delete(sessionId);
    }
    touchSession(sessionId, session);
    publishedEventCount = nextPublishedEventCount;
    evictInactiveSessions(sessionId);

    const targets = [...subscribers].filter((subscriber) =>
      subscriber.active && matchesSession(subscriber, stored));
    for (const subscriber of targets) subscriber.pending.push(stored);
    for (const subscriber of targets) drainSubscriber(subscriber);

    return cloneEnvelope(stored) as ConversationEventEnvelope<TPayload>;
  }

  function read(
    rawSessionId: string,
    readOptions: { readonly afterCursor?: number } = {},
  ): ConversationEventReplay {
    const sessionId = validateOpaqueId(rawSessionId, "sessionId");
    const afterCursor = readOptions.afterCursor === undefined
      ? null
      : validateCursor(readOptions.afterCursor, "afterCursor");
    const session = getTrackedSession(sessionId);
    const tombstoneLatestCursor = session === undefined
      ? getCursorTombstone(sessionId)
      : undefined;
    const latestCursor = session?.latestCursor
      ?? tombstoneLatestCursor
      ?? 0;
    const oldestRetainedCursor = session?.events[0]?.cursor ?? null;
    const snapshotRequired = afterCursor !== null && (
      hasReplayGap(afterCursor, latestCursor, oldestRetainedCursor)
      // Once the bounded tombstone LRU has aged out any state, an unknown
      // session ID might be that forgotten session. A cursor-bearing caller
      // must obtain a host snapshot instead of treating an empty read as a
      // complete catch-up.
      || (session === undefined && tombstoneLatestCursor === undefined
        && hasForgottenCursorTombstone)
    );
    const events = (session?.events ?? [])
      .filter((event) => afterCursor === null || event.cursor > afterCursor)
      .map((event) => cloneEnvelope(event));

    return {
      sessionId,
      afterCursor,
      oldestRetainedCursor,
      latestCursor,
      snapshotRequired,
      events,
    };
  }

  function subscribe(
    listener: ConversationEventListener,
    subscribeOptions: ConversationEventSubscriptionOptions = {},
  ): ConversationEventSubscription {
    if (typeof listener !== "function") {
      throw new TypeError("Conversation event listener must be a function.");
    }
    const sessionId = subscribeOptions.sessionId === undefined
      ? undefined
      : validateOpaqueId(subscribeOptions.sessionId, "sessionId");
    const afterCursor = subscribeOptions.afterCursor === undefined
      ? undefined
      : validateCursor(subscribeOptions.afterCursor, "afterCursor");
    if (afterCursor !== undefined && sessionId === undefined) {
      throw new TypeError("afterCursor requires a sessionId.");
    }
    if (subscribeOptions.replay === "available" && sessionId === undefined) {
      throw new TypeError("Replay requires a sessionId.");
    }
    if (subscribeOptions.replay !== undefined
      && subscribeOptions.replay !== "none"
      && subscribeOptions.replay !== "available") {
      throw new TypeError("Conversation event replay must be 'none' or 'available'.");
    }

    const subscriber: Subscriber = {
      listener,
      sessionId,
      active: true,
      delivering: false,
      pending: [],
    };
    subscribers.add(subscriber);

    const replay = sessionId === undefined
      ? undefined
      : read(sessionId, { afterCursor });
    if (subscribeOptions.replay === "available" && replay !== undefined && replay.events.length > 0) {
      // Queue all replay frames before the first callback. A listener may
      // publish re-entrantly, and those live events must follow the replay tail.
      subscriber.pending.push(...replay.events);
      drainSubscriber(subscriber);
    }

    let active = true;
    return {
      replay,
      unsubscribe: () => {
        if (!active) return;
        active = false;
        subscriber.active = false;
        subscriber.pending.length = 0;
        subscribers.delete(subscriber);
        evictInactiveSessions();
      },
    };
  }

  function subscriberCount(): number {
    return subscribers.size;
  }

  function drainSubscriber(subscriber: Subscriber): void {
    if (!subscriber.active || subscriber.delivering) return;
    subscriber.delivering = true;
    try {
      while (subscriber.active && subscriber.pending.length > 0) {
        const event = subscriber.pending.shift();
        if (!event) continue;
        try {
          // Each surface gets its own detached snapshot. A mutation or throw in
          // one adapter cannot change the canonical event or another adapter.
          subscriber.listener(cloneEnvelope(event));
        } catch {
          // Surface adapters are best-effort observers. Error handling belongs
          // to the adapter; one broken listener must not block the runtime.
        }
      }
    } finally {
      subscriber.delivering = false;
    }
  }

  function getTrackedSession(sessionId: string): StoredSession | undefined {
    const session = sessions.get(sessionId);
    if (!session) return undefined;
    touchSession(sessionId, session);
    return session;
  }

  function getCursorTombstone(sessionId: string): number | undefined {
    const latestCursor = cursorTombstones.get(sessionId);
    if (latestCursor === undefined) return undefined;
    // Tombstones are also LRU so a recently resumed/read session keeps its
    // exact cursor floor until it is either reactivated or becomes cold again.
    cursorTombstones.delete(sessionId);
    cursorTombstones.set(sessionId, latestCursor);
    return latestCursor;
  }

  function touchSession(sessionId: string, session: StoredSession): void {
    // Map insertion order is the LRU order. Delete first because Map#set on an
    // existing key does not refresh its insertion position.
    sessions.delete(sessionId);
    sessions.set(sessionId, session);
  }

  function evictInactiveSessions(currentSessionId?: string): void {
    while (sessions.size > maxTrackedSessions) {
      const oldestInactiveSessionId = [...sessions.keys()].find((sessionId) =>
        sessionId !== currentSessionId && !hasActiveScopedSubscriber(sessionId)
      );
      if (oldestInactiveSessionId === undefined) break;

      const evictedSession = sessions.get(oldestInactiveSessionId);
      sessions.delete(oldestInactiveSessionId);
      if (evictedSession) {
        rememberCursorTombstone(
          oldestInactiveSessionId,
          evictedSession.latestCursor,
        );
      }
    }
    evictInactiveCursorTombstones();
  }

  function rememberCursorTombstone(sessionId: string, latestCursor: number): void {
    cursorTombstones.delete(sessionId);
    cursorTombstones.set(sessionId, latestCursor);
    evictInactiveCursorTombstones();
  }

  function evictInactiveCursorTombstones(): void {
    while (cursorTombstones.size > maxTrackedSessions) {
      const oldestInactiveSessionId = [...cursorTombstones.keys()].find(
        (sessionId) => !hasActiveScopedSubscriber(sessionId),
      );
      if (oldestInactiveSessionId === undefined) break;
      cursorTombstones.delete(oldestInactiveSessionId);
      // From this point an unknown session ID may be an aged-out session. Seed
      // it above the process-wide publication floor so its cursor/eventId can
      // never collide with an earlier event for that ID.
      hasForgottenCursorTombstone = true;
    }
  }

  function hasActiveScopedSubscriber(sessionId: string): boolean {
    // An unscoped live listener observes every session, but cannot safely pin
    // an unbounded set of historical session IDs. A scoped adapter explicitly
    // owns this session's replay/cursor continuity for its active lifetime.
    return [...subscribers].some((subscriber) =>
      subscriber.active && subscriber.sessionId === sessionId
    );
  }

  return { publish, subscribe, read, subscriberCount };
}

function matchesSession(subscriber: Subscriber, event: ConversationEventEnvelope): boolean {
  return subscriber.sessionId === undefined || subscriber.sessionId === event.sessionId;
}

function hasReplayGap(
  afterCursor: number,
  latestCursor: number,
  oldestRetainedCursor: number | null,
): boolean {
  if (afterCursor >= latestCursor) return false;
  const firstAvailable = oldestRetainedCursor ?? latestCursor + 1;
  return afterCursor < firstAvailable - 1;
}

function validateReplayLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("replayLimitPerSession must be a non-negative safe integer.");
  }
  return value;
}

function validateTrackedSessionLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError("maxTrackedSessions must be a positive safe integer.");
  }
  return value;
}

function validateCursor(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(label + " must be a non-negative safe integer.");
  }
  return value;
}

function validateOpaqueId(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(label + " must be a non-empty string.");
  }
  return value;
}

function createEventId(sessionId: string, cursor: number): string {
  return "conversation-event/v" + CONVERSATION_EVENT_PROTOCOL_VERSION
    + "/" + encodeURIComponent(sessionId) + "/" + cursor;
}

function cloneEnvelope<TPayload>(
  event: ConversationEventEnvelope<TPayload>,
): ConversationEventEnvelope<TPayload> {
  try {
    return structuredClone(event);
  } catch {
    throw new TypeError("Conversation event payload must be structured-cloneable.");
  }
}
