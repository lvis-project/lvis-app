import { describe, expect, it } from "vitest";
import {
  CONVERSATION_EVENT_PROTOCOL_VERSION,
  createConversationEventHub,
  type ConversationEventEnvelope,
} from "../conversation-event-hub.js";

describe("conversation event hub", () => {
  it("allocates a versioned, stable session-local cursor for every published event", () => {
    const hub = createConversationEventHub({ now: () => 1_700_000_000_000 });

    const first = hub.publish({
      sessionId: "session-a",
      turnId: "turn-a",
      channel: "assistant.delta",
      payload: { text: "one" },
    });
    const second = hub.publish({
      sessionId: "session-a",
      channel: "turn.done",
      payload: { ok: true },
    });
    const otherSession = hub.publish({
      sessionId: "session-b",
      channel: "assistant.delta",
      payload: { text: "other" },
    });

    expect(first).toEqual({
      version: CONVERSATION_EVENT_PROTOCOL_VERSION,
      eventId: "conversation-event/v1/session-a/1",
      sessionId: "session-a",
      cursor: 1,
      channel: "assistant.delta",
      turnId: "turn-a",
      emittedAt: 1_700_000_000_000,
      payload: { text: "one" },
    });
    expect(second.cursor).toBe(2);
    expect(second.eventId).toBe("conversation-event/v1/session-a/2");
    expect(otherSession.cursor).toBe(1);
  });

  it("fans out a detached event snapshot to N matching surface adapters", () => {
    const hub = createConversationEventHub();
    const allEvents: ConversationEventEnvelope[] = [];
    const sessionEvents: ConversationEventEnvelope[] = [];
    const otherEvents: ConversationEventEnvelope[] = [];
    hub.subscribe((event) => {
      const payload = event.payload as { state: { text: string } };
      payload.state.text = "mutated-by-first-surface";
      allEvents.push(event);
    });
    hub.subscribe((event) => sessionEvents.push(event), { sessionId: "session-a" });
    hub.subscribe((event) => otherEvents.push(event), { sessionId: "session-b" });

    const original = { state: { text: "original" } };
    hub.publish({
      sessionId: "session-a",
      channel: "assistant.delta",
      payload: original,
    });
    original.state.text = "mutated-after-publish";

    expect(allEvents).toHaveLength(1);
    expect(sessionEvents).toHaveLength(1);
    expect(otherEvents).toEqual([]);
    expect((sessionEvents[0]?.payload as { state: { text: string } }).state.text)
      .toBe("original");
    expect((hub.read("session-a").events[0]?.payload as { state: { text: string } }).state.text)
      .toBe("original");
  });

  it("isolates a throwing subscriber and supports idempotent unsubscribe", () => {
    const hub = createConversationEventHub();
    const delivered: string[] = [];
    const broken = hub.subscribe(() => { throw new Error("surface failed"); });
    const healthy = hub.subscribe((event) => delivered.push(event.channel));

    hub.publish({ sessionId: "session-a", channel: "first", payload: null });
    broken.unsubscribe();
    broken.unsubscribe();
    hub.publish({ sessionId: "session-a", channel: "second", payload: null });
    healthy.unsubscribe();

    expect(delivered).toEqual(["first", "second"]);
    expect(hub.subscriberCount()).toBe(0);
  });

  it("reports a bounded replay gap so adapters can obtain a host-owned snapshot", () => {
    const hub = createConversationEventHub({ replayLimitPerSession: 2 });
    for (const channel of ["one", "two", "three"]) {
      hub.publish({ sessionId: "session-a", channel, payload: null });
    }

    const stale = hub.read("session-a", { afterCursor: 0 });
    const current = hub.read("session-a", { afterCursor: 1 });
    const tail = hub.read("session-a", { afterCursor: 2 });

    expect(stale).toMatchObject({
      oldestRetainedCursor: 2,
      latestCursor: 3,
      snapshotRequired: true,
    });
    expect(stale.events.map((event) => event.cursor)).toEqual([2, 3]);
    expect(current.snapshotRequired).toBe(false);
    expect(current.events.map((event) => event.cursor)).toEqual([2, 3]);
    expect(tail.events.map((event) => event.cursor)).toEqual([3]);
  });

  it("queues retained replay before re-entrant live delivery", () => {
    const hub = createConversationEventHub();
    hub.publish({ sessionId: "session-a", channel: "first", payload: null });
    hub.publish({ sessionId: "session-a", channel: "second", payload: null });
    const received: number[] = [];

    const subscription = hub.subscribe((event) => {
      received.push(event.cursor);
      if (event.cursor === 1) {
        hub.publish({ sessionId: "session-a", channel: "third", payload: null });
      }
    }, {
      sessionId: "session-a",
      afterCursor: 0,
      replay: "available",
    });

    expect(subscription.replay).toMatchObject({
      latestCursor: 2,
      snapshotRequired: false,
    });
    expect(received).toEqual([1, 2, 3]);
  });

  it("bounds live-only inactive state without interrupting a scoped surface cursor", () => {
    const hub = createConversationEventHub({
      maxTrackedSessions: 1,
      replayLimitPerSession: 0,
    });
    const pinnedCursors: number[] = [];
    const pinned = hub.subscribe(
      (event) => pinnedCursors.push(event.cursor),
      { sessionId: "pinned" },
    );

    const firstPinned = hub.publish({
      sessionId: "pinned",
      channel: "assistant.delta",
      payload: null,
      replay: false,
    });
    const idle = hub.publish({
      sessionId: "idle",
      channel: "assistant.delta",
      payload: null,
      replay: false,
    });
    const secondPinned = hub.publish({
      sessionId: "pinned",
      channel: "assistant.delta",
      payload: null,
      replay: false,
    });

    expect([firstPinned.cursor, idle.cursor, secondPinned.cursor]).toEqual([1, 1, 2]);
    expect(pinnedCursors).toEqual([1, 2]);

    pinned.unsubscribe();
    hub.publish({
      sessionId: "after-unpin",
      channel: "assistant.delta",
      payload: null,
      replay: false,
    });

    // The inactive state is now gone, but its bounded cursor tombstone still
    // tells a reconnecting surface to obtain a snapshot rather than replaying
    // a misleading empty tail.
    expect(hub.read("pinned", { afterCursor: 0 })).toMatchObject({
      latestCursor: 2,
      oldestRetainedCursor: null,
      snapshotRequired: true,
      events: [],
    });
    expect(hub.publish({
      sessionId: "pinned",
      channel: "assistant.delta",
      payload: null,
      replay: false,
    })).toMatchObject({
      cursor: 3,
      eventId: "conversation-event/v1/pinned/3",
    });
  });

  it("never reuses an event id when a bounded live-only cursor tombstone ages out", () => {
    const hub = createConversationEventHub({
      maxTrackedSessions: 1,
      replayLimitPerSession: 0,
    });

    const first = hub.publish({ sessionId: "session-a", channel: "one", payload: null, replay: false });
    hub.publish({ sessionId: "session-b", channel: "two", payload: null, replay: false });
    hub.publish({ sessionId: "session-c", channel: "three", payload: null, replay: false });
    expect(hub.read("session-a", { afterCursor: 1 })).toMatchObject({
      latestCursor: 0,
      oldestRetainedCursor: null,
      snapshotRequired: true,
      events: [],
    });
    const resumed = hub.publish({ sessionId: "session-a", channel: "four", payload: null, replay: false });

    expect(first).toMatchObject({ cursor: 1, eventId: "conversation-event/v1/session-a/1" });
    // session-a's exact tombstone was evicted to keep the cap bounded. The
    // fallback seeds above the process-wide publication floor, so a later
    // event remains monotonic and cannot collide with its original event ID.
    expect(resumed).toMatchObject({ cursor: 4, eventId: "conversation-event/v1/session-a/4" });
    expect(resumed.eventId).not.toBe(first.eventId);
  });

  it("validates scoped replay inputs rather than guessing a cross-session cursor", () => {
    const hub = createConversationEventHub();

    expect(() => hub.subscribe(() => {}, { afterCursor: 1 })).toThrow(
      "afterCursor requires a sessionId.",
    );
    expect(() => hub.subscribe(() => {}, { replay: "available" })).toThrow(
      "Replay requires a sessionId.",
    );
    expect(() => createConversationEventHub({ replayLimitPerSession: -1 })).toThrow(
      "replayLimitPerSession must be a non-negative safe integer.",
    );
    expect(() => createConversationEventHub({ maxTrackedSessions: 0 })).toThrow(
      "maxTrackedSessions must be a positive safe integer.",
    );
  });
});
