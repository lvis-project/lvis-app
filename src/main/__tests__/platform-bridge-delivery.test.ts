import { describe, expect, it, vi } from "vitest";
import {
  createPlatformBridgeDeliveryAdapter,
  type PlatformBridgeOutboundMessage,
} from "../platform-bridge-delivery.js";
import {
  createPlatformConversationTimeline,
} from "../../engine/conversation-platform-protocol.js";
import {
  createSharedConversationProjectionStore,
  SHARED_CONVERSATION_PROTOCOL_VERSION,
  type SharedConversationEventEnvelope,
  type SharedConversationSnapshot,
} from "../../engine/shared-conversation-projection.js";

const CONVERSATION_ID = "private-main-conversation";

function snapshot(overrides: Partial<SharedConversationSnapshot> = {}): SharedConversationSnapshot {
  return {
    version: SHARED_CONVERSATION_PROTOCOL_VERSION,
    conversationId: CONVERSATION_ID,
    cursor: 0,
    updatedAt: null,
    busy: false,
    awaitingLocalApproval: false,
    assistantText: "",
    ...overrides,
  };
}

function event(
  cursor: number,
  value: SharedConversationEventEnvelope["event"],
): SharedConversationEventEnvelope {
  return {
    version: SHARED_CONVERSATION_PROTOCOL_VERSION,
    conversationId: CONVERSATION_ID,
    cursor,
    emittedAt: 1_700_000_000_000 + cursor,
    event: value,
  };
}

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => resolvePromise?.(),
  };
}

function rejectedDeferred(): {
  readonly promise: Promise<void>;
  reject(error: Error): void;
} {
  let rejectPromise: ((error: Error) => void) | undefined;
  const promise = new Promise<void>((_resolve, reject) => {
    rejectPromise = reject;
  });
  return {
    promise,
    reject: (error) => rejectPromise?.(error),
  };
}

describe("PlatformBridgeDeliveryAdapter", () => {
  it("accepts only shared snapshot/events and never serializes private envelope fields", async () => {
    const sent: PlatformBridgeOutboundMessage[] = [];
    const adapter = createPlatformBridgeDeliveryAdapter({
      transport: {
        send: async (_channel: string, message) => {
          sent.push(message);
        },
      },
    });
    const channel = adapter.openChannel("telegram:paired-chat", CONVERSATION_ID);

    channel.enqueueSnapshot({
      ...snapshot({
        cursor: 7,
        busy: true,
        assistantText: "safe snapshot\u0000 text",
      }),
      // A runtime cast models an accidental future field; this adapter must
      // destructure only the public projection contract.
      ownerDetail: { path: "C:\\private\\secret.txt", token: "not-for-provider" },
    } as unknown as SharedConversationSnapshot);
    channel.enqueueEvent({
      ...event(8, { kind: "assistant.text.delta", text: "safe reply" }),
      ownerDetail: { rawTimeline: "never-forward" },
    } as unknown as SharedConversationEventEnvelope);
    await channel.waitForIdle();

    expect(sent).toEqual([
      { kind: "snapshot", cursor: 7, status: "running", text: "safe snapshot text" },
      { kind: "text", cursor: 8, text: "safe reply" },
    ]);
    const wire = JSON.stringify(sent);
    expect(wire).not.toContain(CONVERSATION_ID);
    expect(wire).not.toContain("secret.txt");
    expect(wire).not.toContain("not-for-provider");
    expect(wire).not.toContain("never-forward");
  });

  it("suppresses duplicate and out-of-order cursors before provider delivery", async () => {
    const sent: PlatformBridgeOutboundMessage[] = [];
    const adapter = createPlatformBridgeDeliveryAdapter({
      transport: { send: async (_channel: string, message) => void sent.push(message) },
    });
    const channel = adapter.openChannel("discord:paired-channel", CONVERSATION_ID);

    expect(channel.enqueueSnapshot(snapshot())).toBe("accepted");
    expect(channel.enqueueEvent(event(1, { kind: "assistant.text.delta", text: "first" }))).toBe("accepted");
    expect(channel.enqueueEvent(event(1, { kind: "assistant.text.delta", text: "duplicate" }))).toBe("duplicate");
    expect(channel.enqueueEvent(event(0, { kind: "turn.started" }))).toBe("invalid");
    expect(channel.enqueueEvent(event(2, { kind: "turn.completed" }))).toBe("accepted");
    await channel.waitForIdle();

    expect(sent).toEqual([
      { kind: "snapshot", cursor: 0, status: "idle", text: "" },
      { kind: "text", cursor: 1, text: "first" },
      { kind: "status", cursor: 2, status: "turn-completed" },
    ]);
    expect(channel.state()).toEqual({ lastAcceptedCursor: 2, pendingMessages: 0, closed: false });
  });

  it("closes only a slow channel when its bounded pending queue fills", async () => {
    const firstSend = deferred();
    const onBackpressure = vi.fn();
    const send = vi.fn(async () => firstSend.promise);
    const adapter = createPlatformBridgeDeliveryAdapter({
      transport: { send },
      maxPendingMessagesPerChannel: 2,
      onBackpressure,
    });
    const channel = adapter.openChannel("slow-provider-channel", CONVERSATION_ID);

    expect(channel.enqueueSnapshot(snapshot())).toBe("accepted");
    expect(channel.enqueueEvent(event(1, { kind: "turn.started" }))).toBe("accepted");
    expect(channel.enqueueEvent(event(2, { kind: "assistant.text.delta", text: "must-not-buffer" }))).toBe("backpressure");
    expect(channel.state()).toEqual({ lastAcceptedCursor: 2, pendingMessages: 0, closed: true });
    expect(onBackpressure).toHaveBeenCalledOnce();
    expect(onBackpressure).toHaveBeenCalledWith("slow-provider-channel");

    firstSend.resolve();
    await channel.waitForIdle();
    // This mock deliberately ignores its AbortSignal; queued turn status and
    // overflowing text are still discarded for this one slow channel.
    expect(send).toHaveBeenCalledTimes(1);
    expect(adapter.channelCount()).toBe(0);
  });

  it("aborts an in-flight provider send and resolves closed idle waits immediately", async () => {
    const neverSettles = new Promise<void>(() => {});
    let observedSignal: AbortSignal | undefined;
    let observedGeneration: number | undefined;
    const adapter = createPlatformBridgeDeliveryAdapter({
      transport: {
        send: async (
          _channel: string,
          _message,
          delivery,
        ) => {
          observedSignal = delivery.signal;
          observedGeneration = delivery.generation;
          return neverSettles;
        },
      },
    });
    const channel = adapter.openChannel("revoked-provider-channel", CONVERSATION_ID);

    expect(channel.enqueueSnapshot(snapshot())).toBe("accepted");
    expect(observedSignal?.aborted).toBe(false);
    expect(observedGeneration).toBe(1);
    channel.close();

    expect(observedSignal?.aborted).toBe(true);
    await expect(channel.waitForIdle()).resolves.toBeUndefined();
  });

  it("does not let an old rejected send affect a newly paired destination", async () => {
    const oldSend = rejectedDeferred();
    const onDeliveryFailure = vi.fn();
    const generations: number[] = [];
    let sends = 0;
    const adapter = createPlatformBridgeDeliveryAdapter({
      transport: {
        send: async (
          _channel: string,
          _message,
          delivery,
        ) => {
          generations.push(delivery.generation);
          sends += 1;
          return sends === 1 ? oldSend.promise : undefined;
        },
      },
      onDeliveryFailure,
    });
    const oldChannel = adapter.openChannel("same-provider-destination", CONVERSATION_ID);
    expect(oldChannel.enqueueSnapshot(snapshot())).toBe("accepted");

    const replacement = adapter.openChannel("same-provider-destination", CONVERSATION_ID);
    expect(replacement.enqueueSnapshot(snapshot())).toBe("accepted");
    oldSend.reject(new Error("old provider request rejected"));
    await replacement.waitForIdle();
    await Promise.resolve();

    expect(generations).toEqual([1, 2]);
    expect(onDeliveryFailure).not.toHaveBeenCalled();
    expect(replacement.state().closed).toBe(false);
  });

  it("subscribes through SharedConversationProjectionStore and maps only safe projected output", async () => {
    const timeline = createPlatformConversationTimeline();
    const store = createSharedConversationProjectionStore(timeline);
    store.start();
    const sent: PlatformBridgeOutboundMessage[] = [];
    const adapter = createPlatformBridgeDeliveryAdapter({
      transport: { send: async (_channel: string, message) => void sent.push(message) },
    });
    const channel = adapter.openChannel("discord:bridge", CONVERSATION_ID);

    timeline.publish({
      conversationId: CONVERSATION_ID,
      event: {
        kind: "assistant.reasoning.delta",
        ownerDetail: { text: "private chain-of-thought" },
      },
    });
    timeline.publish({
      conversationId: CONVERSATION_ID,
      event: { kind: "assistant.text.delta", text: "before attach" },
    });

    channel.attach(store, () => ({ busy: true }));
    timeline.publish({
      conversationId: CONVERSATION_ID,
      event: {
        kind: "tool.started",
        tool: { name: "shell", groupId: "private", toolUseId: "private", displayOrder: 1 },
        ownerDetail: { input: { command: "cat C:\\private\\secret.txt" } },
      },
    });
    timeline.publish({
      conversationId: CONVERSATION_ID,
      event: { kind: "assistant.text.delta", text: "after attach" },
    });
    await channel.waitForIdle();

    expect(sent).toEqual([
      { kind: "snapshot", cursor: 1, status: "running", text: "before attach" },
      { kind: "status", cursor: 2, status: "tool-running" },
      { kind: "text", cursor: 3, text: "after attach" },
    ]);
    const wire = JSON.stringify(sent);
    expect(wire).not.toContain("chain-of-thought");
    expect(wire).not.toContain("secret.txt");
    expect(wire).not.toContain(CONVERSATION_ID);
  });
});
