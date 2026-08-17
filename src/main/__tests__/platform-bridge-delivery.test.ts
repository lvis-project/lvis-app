import { describe, expect, it, vi } from "vitest";
import {
  createPlatformBridgeDeliveryAdapter,
  platformBridgeDeliverySendFailureError,
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

  it("carries the share-safe failure summary on a failed turn and drops a forged one", async () => {
    const sent: PlatformBridgeOutboundMessage[] = [];
    const adapter = createPlatformBridgeDeliveryAdapter({
      transport: { send: async (_channel: string, message) => void sent.push(message) },
    });
    const channel = adapter.openChannel("telegram:failed-chat", CONVERSATION_ID);

    channel.enqueueEvent(event(1, {
      kind: "turn.failed",
      failure: { category: "rate-limit", summary: "The model rate limit was hit. Retry shortly." },
    }));
    channel.enqueueEvent(event(2, {
      kind: "turn.failed",
      failure: {
        category: "stack-trace",
        summary: "at C:\\private\\secret.ts:1 token sk-FAKE-TOKEN-123",
      } as unknown as { category: "provider"; summary: string },
    }));
    channel.enqueueEvent(event(3, { kind: "turn.failed" }));
    await channel.waitForIdle();

    expect(sent).toEqual([
      {
        kind: "status",
        cursor: 1,
        status: "turn-failed",
        failure: { category: "rate-limit", summary: "The model rate limit was hit. Retry shortly." },
      },
      { kind: "status", cursor: 2, status: "turn-failed" },
      { kind: "status", cursor: 3, status: "turn-failed" },
    ]);
    const wire = JSON.stringify(sent);
    expect(wire).not.toContain("secret.ts");
    expect(wire).not.toContain("sk-FAKE-TOKEN-123");
  });

  it("bounds text by UTF-16 unit and keeps the newest end of a snapshot", async () => {
    const sent: PlatformBridgeOutboundMessage[] = [];
    const adapter = createPlatformBridgeDeliveryAdapter({
      transport: { send: async (_channel: string, message) => void sent.push(message) },
      maxTextChars: 8,
    });

    // The projection retains the TAIL of a long reply, so a head-bounded
    // snapshot delivers its oldest retained words and drops the newest.
    const tail = adapter.openChannel("telegram:tail-chat", CONVERSATION_ID);
    tail.enqueueSnapshot(snapshot({ cursor: 1, assistantText: "oldest-middle-newest" }));
    // Six emoji are twelve UTF-16 units: a code-point bound would send all six.
    tail.enqueueEvent(event(2, { kind: "assistant.text.delta", text: "😀".repeat(6) }));
    await tail.waitForIdle();

    // Neither end may be cut through the middle of a surrogate pair.
    const pairs = adapter.openChannel("telegram:pair-chat", CONVERSATION_ID);
    pairs.enqueueSnapshot(snapshot({ cursor: 1, assistantText: `${"😀".repeat(4)}a` }));
    pairs.enqueueEvent(event(2, { kind: "assistant.text.delta", text: `a${"😀".repeat(4)}` }));
    await pairs.waitForIdle();

    expect(sent).toEqual([
      { kind: "snapshot", cursor: 1, status: "idle", text: "e-newest" },
      { kind: "text", cursor: 2, text: "😀".repeat(4) },
      { kind: "snapshot", cursor: 1, status: "idle", text: `${"😀".repeat(3)}a` },
      { kind: "text", cursor: 2, text: `a${"😀".repeat(3)}` },
    ]);
    for (const message of sent) {
      if (message.kind === "status") continue;
      expect(message.text.length).toBeLessThanOrEqual(8);
    }
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

  it("forwards the coarse approval tool identifier and resumes with plain tool status after the decision", async () => {
    const sent: PlatformBridgeOutboundMessage[] = [];
    const adapter = createPlatformBridgeDeliveryAdapter({
      transport: { send: async (_channel: string, message) => void sent.push(message) },
    });
    const channel = adapter.openChannel("telegram:approval-wait", CONVERSATION_ID);

    expect(channel.enqueueSnapshot(snapshot())).toBe("accepted");
    expect(channel.enqueueEvent(
      event(1, { kind: "approval.waiting-local", tool: "builtin:list_files" }),
    )).toBe("accepted");
    // A malformed identifier is dropped at this boundary, never forwarded.
    expect(channel.enqueueEvent(
      event(2, { kind: "approval.waiting-local", tool: "unsafe tool C:\\private\\path" }),
    )).toBe("accepted");
    // The local decision resumes the turn through the ordinary tool status.
    expect(channel.enqueueEvent(event(3, { kind: "tool.state", state: "running" }))).toBe("accepted");
    await channel.waitForIdle();

    expect(sent).toEqual([
      { kind: "snapshot", cursor: 0, status: "idle", text: "" },
      { kind: "status", cursor: 1, status: "awaiting-local-approval", tool: "builtin:list_files" },
      { kind: "status", cursor: 2, status: "awaiting-local-approval" },
      { kind: "status", cursor: 3, status: "tool-running" },
    ]);
    expect(JSON.stringify(sent)).not.toContain("private");
  });

  it("lets a provider compact only queued safe messages and retain split current-cursor chunks", async () => {
    const firstSend = deferred();
    const sent: PlatformBridgeOutboundMessage[] = [];
    const queuedCursors: number[][] = [];
    const adapter = createPlatformBridgeDeliveryAdapter({
      transport: {
        send: async (_channel: string, message) => {
          sent.push(message);
          if (message.kind === "snapshot") await firstSend.promise;
        },
      },
      maxPendingMessagesPerChannel: 3,
      coalesceQueuedMessages: (queued, incoming) => {
        queuedCursors.push(queued.map((entry) => entry.cursor));
        if (incoming.cursor === 2) {
          return [{
            cursor: 2,
            message: { kind: "text", cursor: 2, text: "merged latest text" },
          }];
        }
        if (incoming.cursor === 3) {
          return [
            { cursor: 3, message: { kind: "text", cursor: 3, text: "chunk one" } },
            { cursor: 3, message: { kind: "text", cursor: 3, text: "chunk two" } },
          ];
        }
        return [...queued, incoming];
      },
    });
    const channel = adapter.openChannel("telegram:coalesced", CONVERSATION_ID);

    expect(channel.enqueueSnapshot(snapshot())).toBe("accepted");
    expect(channel.enqueueEvent(event(1, { kind: "assistant.text.delta", text: "first" }))).toBe("accepted");
    expect(channel.enqueueEvent(event(2, { kind: "assistant.text.delta", text: "second" }))).toBe("accepted");
    expect(channel.enqueueEvent(event(3, { kind: "assistant.text.delta", text: "third" }))).toBe("accepted");
    // Cursor 0 is in flight and therefore never reaches provider compaction.
    expect(queuedCursors[2]).toEqual([1]);
    expect(channel.state().pendingMessages).toBe(3);

    firstSend.resolve();
    await channel.waitForIdle();

    expect(sent).toEqual([
      { kind: "snapshot", cursor: 0, status: "idle", text: "" },
      { kind: "text", cursor: 3, text: "chunk one" },
      { kind: "text", cursor: 3, text: "chunk two" },
    ]);
  });

  it("contains a malformed provider coalescer result without throwing into the projection producer", () => {
    const onDeliveryFailure = vi.fn();
    const adapter = createPlatformBridgeDeliveryAdapter({
      transport: { send: async () => undefined },
      onDeliveryFailure,
      coalesceQueuedMessages: (_queued, incoming) => {
        const valid = [{
          cursor: incoming.cursor,
          message: incoming.message,
        }];
        // Validation can read this array safely, but normalization must also be
        // guarded because provider code is an extension boundary.
        return new Proxy(valid, {
          get(target, property, receiver) {
            if (property === "map") throw new Error("provider-map-failure");
            return Reflect.get(target, property, receiver);
          },
        }) as unknown as readonly typeof incoming[];
      },
    });
    const channel = adapter.openChannel("telegram:bad-coalescer", CONVERSATION_ID);

    expect(channel.enqueueSnapshot(snapshot())).toBe("closed");
    expect(channel.state().closed).toBe(true);
    expect(onDeliveryFailure).toHaveBeenCalledOnce();
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

  it("retries a transiently failing send in place and preserves per-channel ordering", async () => {
    const sent: string[] = [];
    const delays: number[] = [];
    const onDeliveryFailure = vi.fn();
    let failuresRemaining = 1;
    const adapter = createPlatformBridgeDeliveryAdapter({
      transport: {
        send: async (_channel: string, message) => {
          if (failuresRemaining > 0) {
            failuresRemaining -= 1;
            throw platformBridgeDeliverySendFailureError("telegram-delivery-failed", {
              transient: true,
              reason: "network",
            });
          }
          sent.push(message.kind === "text" ? message.text : message.kind);
        },
      },
      maxTransientSendRetries: 2,
      retryBackoffBaseMs: 7,
      wait: async (milliseconds) => void delays.push(milliseconds),
      onDeliveryFailure,
    });
    const channel = adapter.openChannel("paired-chat", CONVERSATION_ID);

    expect(channel.enqueueEvent(event(1, { kind: "assistant.text.delta", text: "first" }))).toBe("accepted");
    expect(channel.enqueueEvent(event(2, { kind: "assistant.text.delta", text: "second" }))).toBe("accepted");
    await channel.waitForIdle();

    // The blip cost one backoff wait, not the channel or the turn's ordering.
    expect(sent).toEqual(["first", "second"]);
    expect(delays).toEqual([7]);
    expect(onDeliveryFailure).not.toHaveBeenCalled();
    expect(channel.state().closed).toBe(false);
  });

  it("closes with an exhaustion reason after bounded transient retries with doubling backoff", async () => {
    const delays: number[] = [];
    const failures: Array<string | undefined> = [];
    let attempts = 0;
    const adapter = createPlatformBridgeDeliveryAdapter({
      transport: {
        send: async () => {
          attempts += 1;
          throw platformBridgeDeliverySendFailureError("telegram-delivery-failed", {
            transient: true,
            reason: "http-502",
          });
        },
      },
      maxTransientSendRetries: 2,
      retryBackoffBaseMs: 3,
      wait: async (milliseconds) => void delays.push(milliseconds),
      onDeliveryFailure: (_channel, reason) => void failures.push(reason),
    });
    const channel = adapter.openChannel("paired-chat", CONVERSATION_ID);

    expect(channel.enqueueEvent(event(1, { kind: "assistant.text.delta", text: "reply" }))).toBe("accepted");
    await channel.waitForIdle();

    expect(attempts).toBe(3);
    expect(delays).toEqual([3, 6]);
    expect(failures).toEqual(["http-502-retries-exhausted"]);
    expect(channel.state().closed).toBe(true);
  });

  it("closes immediately with the classified reason on a permanent failure and treats unmarked throws as permanent", async () => {
    const runCase = async (error: Error): Promise<{ attempts: number; reason: string | undefined }> => {
      const failures: Array<string | undefined> = [];
      let attempts = 0;
      const adapter = createPlatformBridgeDeliveryAdapter({
        transport: {
          send: async () => {
            attempts += 1;
            throw error;
          },
        },
        wait: async () => undefined,
        onDeliveryFailure: (_channel, reason) => void failures.push(reason),
      });
      const channel = adapter.openChannel("paired-chat", CONVERSATION_ID);
      channel.enqueueEvent(event(1, { kind: "assistant.text.delta", text: "reply" }));
      await channel.waitForIdle();
      expect(channel.state().closed).toBe(true);
      return { attempts, reason: failures[0] };
    };

    expect(await runCase(
      platformBridgeDeliverySendFailureError("telegram-delivery-failed", {
        transient: false,
        reason: "api-403",
      }),
    )).toEqual({ attempts: 1, reason: "api-403" });
    // Fail closed: a transport that throws without classifying gets no retries.
    expect(await runCase(new Error("unmarked provider throw"))).toEqual({
      attempts: 1,
      reason: "unclassified",
    });
  });

  it("honors a provider retry-after hint but caps every retry delay", async () => {
    const delays: number[] = [];
    let failuresRemaining = 2;
    const adapter = createPlatformBridgeDeliveryAdapter({
      transport: {
        send: async () => {
          if (failuresRemaining > 0) {
            failuresRemaining -= 1;
            throw platformBridgeDeliverySendFailureError("telegram-delivery-failed", {
              transient: true,
              reason: "api-429",
              retryAfterMs: failuresRemaining === 1 ? 5_000 : 100,
            });
          }
        },
      },
      maxTransientSendRetries: 2,
      retryBackoffBaseMs: 1,
      maxRetryDelayMs: 2_000,
      wait: async (milliseconds) => void delays.push(milliseconds),
    });
    const channel = adapter.openChannel("paired-chat", CONVERSATION_ID);

    channel.enqueueEvent(event(1, { kind: "assistant.text.delta", text: "reply" }));
    await channel.waitForIdle();

    // First hint (5s) is capped to 2s; second hint (100ms) beats the backoff.
    expect(delays).toEqual([2_000, 100]);
    expect(channel.state().closed).toBe(false);
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
