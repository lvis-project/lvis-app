import { describe, expect, it, vi } from "vitest";
import { createPlatformConversationTimeline } from "../conversation-platform-protocol.js";
import { createSharedConversationProjectionStore } from "../shared-conversation-projection.js";

const CONVERSATION_ID = "main-conversation";

describe("SharedConversationProjectionStore", () => {
  it("retains only the explicit shared projection and a bounded visible assistant buffer", () => {
    const timeline = createPlatformConversationTimeline();
    const store = createSharedConversationProjectionStore(timeline);
    store.start();

    timeline.publish({
      conversationId: CONVERSATION_ID,
      turnId: "owner-private-turn",
      event: { kind: "turn.started" },
    });
    timeline.publish({
      conversationId: CONVERSATION_ID,
      turnId: "owner-private-turn",
      event: {
        kind: "tool.started",
        tool: { name: "shell", groupId: "g", toolUseId: "t", displayOrder: 1 },
        ownerDetail: { input: { command: "cat ~/.ssh/id_ed25519" } },
      },
    });
    timeline.publish({
      conversationId: CONVERSATION_ID,
      turnId: "owner-private-turn",
      event: { kind: "assistant.text.delta", text: "Visible reply" },
    });
    timeline.publish({
      conversationId: CONVERSATION_ID,
      turnId: "owner-private-turn",
      event: {
        kind: "tool.completed",
        tool: { name: "shell", groupId: "g", toolUseId: "t", displayOrder: 1 },
        isError: false,
        durationMs: 12,
        ownerDetail: { result: "TOKEN=private-result" },
      },
    });
    timeline.publish({
      conversationId: CONVERSATION_ID,
      turnId: "owner-private-turn",
      event: {
        kind: "permission.reviewed",
        review: {
          status: "needs_approval",
          tool: { name: "shell", groupId: "g", toolUseId: "t", displayOrder: 1 },
          ownerDetail: { reason: "private approval rationale" },
        },
      },
    });

    const replay = store.read(CONVERSATION_ID);
    const snapshot = store.snapshot(CONVERSATION_ID, { busy: true });
    const serialized = JSON.stringify({ replay, snapshot });

    expect(replay.events.map((event) => event.event)).toEqual([
      { kind: "turn.started" },
      { kind: "tool.state", state: "running" },
      { kind: "assistant.text.delta", text: "Visible reply" },
      { kind: "tool.state", state: "completed" },
      { kind: "approval.waiting-local" },
    ]);
    expect(snapshot).toMatchObject({
      cursor: 5,
      busy: true,
      awaitingLocalApproval: true,
      assistantText: "Visible reply",
    });
    expect(serialized).not.toContain("id_ed25519");
    expect(serialized).not.toContain("private-result");
    expect(serialized).not.toContain("private approval rationale");
    expect(serialized).not.toContain("owner-private-turn");
  });

  it("uses dense public cursors so private timeline events leave no observable gaps", () => {
    const timeline = createPlatformConversationTimeline();
    const store = createSharedConversationProjectionStore(timeline);
    store.start();

    timeline.publish({
      conversationId: CONVERSATION_ID,
      event: { kind: "turn.started" },
    });
    timeline.publish({
      conversationId: CONVERSATION_ID,
      event: {
        kind: "assistant.reasoning.delta",
        ownerDetail: { text: "private reasoning must not consume public cursor" },
      },
    });
    timeline.publish({
      conversationId: CONVERSATION_ID,
      event: {
        kind: "tool.started",
        tool: { name: "shell", groupId: "private-group", toolUseId: "private-tool", displayOrder: 1 },
        ownerDetail: { input: { command: "private command" } },
      },
    });

    const replay = store.read(CONVERSATION_ID);
    const snapshot = store.snapshot(CONVERSATION_ID, { busy: true });
    expect(replay.events.map((event) => event.cursor)).toEqual([1, 2]);
    expect(snapshot.cursor).toBe(2);
    expect(JSON.stringify({ replay, snapshot })).not.toContain("private reasoning");
  });

  it("requires a new snapshot when a requested cursor predates the bounded safe tail", () => {
    const timeline = createPlatformConversationTimeline();
    const store = createSharedConversationProjectionStore(timeline, {
      replayLimitPerConversation: 1,
    });
    store.start();

    timeline.publish({ conversationId: CONVERSATION_ID, event: { kind: "turn.started" } });
    timeline.publish({ conversationId: CONVERSATION_ID, event: { kind: "assistant.text.delta", text: "a" } });
    timeline.publish({ conversationId: CONVERSATION_ID, event: { kind: "turn.completed" } });

    expect(store.read(CONVERSATION_ID, { afterCursor: 0 })).toMatchObject({
      oldestRetainedCursor: 3,
      latestCursor: 3,
      snapshotRequired: true,
      events: [],
    });
    expect(store.read(CONVERSATION_ID, { afterCursor: 2 })).toMatchObject({
      snapshotRequired: false,
      events: [{ cursor: 3, event: { kind: "turn.completed" } }],
    });
  });

  it("is lazy until an authorized shared adapter starts it and detaches cleanly", () => {
    const timeline = createPlatformConversationTimeline();
    const store = createSharedConversationProjectionStore(timeline);
    const listener = vi.fn();

    expect(timeline.subscriberCount()).toBe(0);
    store.start();
    expect(timeline.subscriberCount()).toBe(1);
    const subscription = store.subscribe(CONVERSATION_ID, listener);
    timeline.publish({ conversationId: CONVERSATION_ID, event: { kind: "turn.started" } });
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      event: { kind: "turn.started" },
    }));
    subscription.unsubscribe();
    store.stop();
    expect(store.subscriberCount()).toBe(0);
    expect(timeline.subscriberCount()).toBe(0);
  });
});
