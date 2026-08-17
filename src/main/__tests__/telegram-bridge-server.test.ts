import { afterEach, describe, expect, it, vi } from "vitest";
import { MemorySecretStore } from "../../audit/hmac-chain.js";
import type { ConversationSurfaceRuntime } from "../../engine/conversation-surface-runtime.js";
import type { SharedConversationProjectionStore } from "../../engine/shared-conversation-projection.js";
import type { ConversationCommandPort } from "../conversation-command-port.js";
import type { TelegramBotApiResult } from "../telegram-bot-api-client.js";
import {
  maybeStartTelegramConnectionBridge,
  resetTelegramBridgeServerForTests,
  stopTelegramBridgeServer,
} from "../telegram-bridge-server.js";
import {
  BOT_FINGERPRINT,
  BOT_TOKEN,
  BOUND_CONVERSATION,
  OWNER_CHAT_ID,
  ownerPairedAuthority,
  textUpdate,
  type Batch,
} from "./telegram-bridge-fixtures.js";

/** Minimal safe-projection stand-in: only snapshot/subscribe are ever called. */
function projectionStore(): SharedConversationProjectionStore {
  return {
    snapshot: (conversationId: string) => ({
      version: 1,
      conversationId,
      cursor: 1,
      updatedAt: null,
      busy: false,
      awaitingLocalApproval: false,
      assistantText: "safe assistant text",
    }),
    subscribe: () => ({
      replay: {
        conversationId: BOUND_CONVERSATION,
        afterCursor: 1,
        oldestRetainedCursor: null,
        latestCursor: 1,
        snapshotRequired: false,
        events: [],
      },
      unsubscribe: () => {},
    }),
  } as unknown as SharedConversationProjectionStore;
}

/**
 * Drives the REAL paired runtime through the owner-driven connection entry:
 * one shared secret store makes the fixture's digester and the runtime agree
 * on the actor digest, and the authority pairs that digest to the bound
 * conversation with a live approval — the shape a real share leaves behind.
 */
function connectionFixture(overrides: {
  readonly receiptStore?: unknown;
  readonly submit?: () => unknown;
  readonly sendMessage?: () => Promise<TelegramBotApiResult<unknown>>;
} = {}) {
  const secretStore = new MemorySecretStore();
  const { authority } = ownerPairedAuthority(secretStore);

  const batches: Batch[] = [];
  const parked: (() => void)[] = [];
  const sendMessage = vi.fn(
    overrides.sendMessage
      ?? (async (): Promise<TelegramBotApiResult<unknown>> => ({ ok: true, value: { message_id: 1 } })),
  );
  const client = {
    getUpdates: vi.fn(async (input: { signal?: AbortSignal } = {}) => {
      const next = batches.shift();
      if (next !== undefined) return next;
      // Park until stop aborts the poll, so the loop cannot spin.
      return await new Promise<Batch>((resolve) => {
        const release = () => resolve({ ok: true, value: [] });
        parked.push(release);
        input.signal?.addEventListener("abort", release, { once: true });
      });
    }),
    getMe: vi.fn(async () => ({ ok: true as const, value: { username: "a_bot" } })),
    getWebhookInfo: vi.fn(async () => ({ ok: true as const, value: { hasWebhook: false } })),
    sendMessage,
  };
  const createBotApiClient = vi.fn(() => client as never);

  // The command port's submit contract is SYNCHRONOUS: it returns the
  // submission object (whose `completion` promise settles the receipt), or
  // null while streaming.
  const submit = vi.fn<(actor: unknown, command: unknown) => unknown>(
    overrides.submit ?? (() => ({ completion: Promise.resolve() })),
  );
  const onFatal = vi.fn();
  // A recorded offset marks every queued update as LIVE traffic; a null one
  // would make the ingress treat the first batch as pre-pairing backlog and
  // (correctly) skip it.
  let offset: number | null = 100;

  const input = {
    conversationSurfaceRuntime: {
      sharedProjection: projectionStore(),
      activity: { isBusy: () => false },
    } as unknown as ConversationSurfaceRuntime,
    conversationCommandPort: { submit } as unknown as ConversationCommandPort,
    getCurrentConversationId: () => BOUND_CONVERSATION,
    botToken: BOT_TOKEN,
    botFingerprint: BOT_FINGERPRINT,
    authority,
    pollOffset: () => offset,
    recordPollOffset: async (next: number) => {
      offset = next;
    },
    hasPendingPairingCode: () => false,
    redeemPairingCode: async () => false,
    onFatal,
    isPairedOwner: (senderId: string) => senderId === OWNER_CHAT_ID,
    secretStore,
    createBotApiClient,
    ...(overrides.receiptStore === undefined
      ? {}
      : { receiptStore: overrides.receiptStore as never }),
  };

  return { input, client, createBotApiClient, submit, onFatal, sendMessage,
    queue(...next: Batch[]) { batches.push(...next); },
  };
}

async function settled(): Promise<void> {
  // The poll loop hops several awaits between fetching an update and the
  // command port; a few macrotask turns let one dispatch fully settle.
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
}

afterEach(async () => {
  await stopTelegramBridgeServer();
  resetTelegramBridgeServerForTests();
  vi.unstubAllGlobals();
});

describe("Telegram bridge lifecycle (owner-driven connection)", () => {
  it("starts one bridge, answers a concurrent connect with the same handle, and stops it", async () => {
    const f = connectionFixture();
    await expect(maybeStartTelegramConnectionBridge(f.input)).resolves.toEqual({ port: null });
    // Already active ⇒ the same activation, not a second poll loop.
    await expect(maybeStartTelegramConnectionBridge(f.input)).resolves.toEqual({ port: null });
    expect(f.createBotApiClient).toHaveBeenCalledOnce();

    await Promise.all([stopTelegramBridgeServer(), stopTelegramBridgeServer()]);
    // A stopped bridge is not restarted by the stop itself.
    expect(f.createBotApiClient).toHaveBeenCalledOnce();
  });

  it("admits Telegram's 4,096-UTF-16-unit text bound and no more", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));
    const f = connectionFixture({
      receiptStore: {
        reserve: vi.fn(() => ({ kind: "reserved" })),
        releaseReserved: vi.fn(),
        settle: vi.fn(),
      },
    });
    expect("😀".repeat(2_048)).toHaveLength(4_096);
    f.queue(
      { ok: true, value: [textUpdate(101, "😀".repeat(2_048))] },
      { ok: true, value: [textUpdate(102, "😀".repeat(2_049))] },
    );
    await maybeStartTelegramConnectionBridge(f.input);
    await settled();

    // Exactly the in-bound message reached the conversation; the one-emoji
    // overflow died as an invalid envelope before authorization.
    expect(f.submit).toHaveBeenCalledOnce();
    // submit(actor, command): the text rides the command payload.
    expect(f.submit.mock.calls[0]?.[1]).toMatchObject({
      kind: "message.send",
      payload: { input: "😀".repeat(2_048) },
    });
  });

  it("gives the shared inbound core its logger so a permanently lost delivery is not silent", async () => {
    const reserve = vi.fn(() => {
      throw new Error("receipt store unavailable");
    });
    const f = connectionFixture({
      receiptStore: { reserve, releaseReserved: vi.fn(), settle: vi.fn() },
    });
    const log = vi.fn();
    f.queue({ ok: true, value: [textUpdate(201, "needs a durable receipt")] });
    await maybeStartTelegramConnectionBridge({ ...f.input, log });
    await settled();

    expect(reserve).toHaveBeenCalledOnce();
    expect(f.submit).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().some((line) => String(line).includes("receipt"))).toBe(true);
  });

  it("restarts after an owner disconnect but stays closed after app shutdown", async () => {
    const f = connectionFixture();
    await expect(maybeStartTelegramConnectionBridge(f.input)).resolves.toEqual({ port: null });
    await stopTelegramBridgeServer("user");
    await expect(maybeStartTelegramConnectionBridge(f.input)).resolves.toEqual({ port: null });
    expect(f.createBotApiClient).toHaveBeenCalledTimes(2);

    await stopTelegramBridgeServer("shutdown");
    await expect(maybeStartTelegramConnectionBridge(f.input)).resolves.toBeNull();
    expect(f.createBotApiClient).toHaveBeenCalledTimes(2);
  });

  it("starts a reconnect issued in the same tick as the disconnect", async () => {
    const f = connectionFixture();
    await maybeStartTelegramConnectionBridge(f.input);

    const stopping = stopTelegramBridgeServer("user");
    const restarting = maybeStartTelegramConnectionBridge(f.input);
    await stopping;
    await expect(restarting).resolves.toEqual({ port: null });
    expect(f.createBotApiClient).toHaveBeenCalledTimes(2);
  });

  it("settles a receipt reserved before a reconnect instead of stranding it", async () => {
    let releaseCompletion: (() => void) | undefined;
    const reserve = vi.fn(() => ({ kind: "reserved" }));
    const settle = vi.fn();
    const receiptStore = { reserve, releaseReserved: vi.fn(), settle };
    const f = connectionFixture({
      receiptStore,
      submit: () => ({
        completion: new Promise<void>((resolve) => {
          releaseCompletion = resolve;
        }),
      }),
    });
    f.queue({ ok: true, value: [textUpdate(301, "reserved before the reconnect")] });
    await maybeStartTelegramConnectionBridge(f.input);
    await settled();
    expect(reserve).toHaveBeenCalledOnce();
    expect(f.submit).toHaveBeenCalledOnce();
    expect(settle).not.toHaveBeenCalled();

    // Owner disconnects and reconnects while the turn is still running; the
    // receipt was reserved under the FIRST activation and must still settle
    // when that turn's completion finally lands.
    await stopTelegramBridgeServer("user");
    await maybeStartTelegramConnectionBridge(f.input);
    releaseCompletion?.();
    await settled();
    expect(settle).toHaveBeenCalledOnce();
  });
});
