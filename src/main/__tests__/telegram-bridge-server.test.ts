import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTailnetControllerReceiptStore } from "../../api/tailnet-controller-receipt-store.js";
import type { ConversationSurfaceRuntime } from "../../engine/conversation-surface-runtime.js";
import type { SharedConversationProjectionStore } from "../../engine/shared-conversation-projection.js";
import type { PlatformBridgeBinding } from "../../shared/chat-origin.js";
import type { ConversationCommandPort } from "../conversation-command-port.js";
import type { TelegramPlatformRoute, TelegramPlatformRuntime } from "../telegram-platform-runtime.js";
import {
  DEFAULT_TELEGRAM_BRIDGE_PORT,
  DEFAULT_TELEGRAM_WEBHOOK_PATH,
  maybeStartTelegramBridgeServer,
  resetTelegramBridgeServerForTests,
  resolveTelegramBridgeConfig,
  stopTelegramBridgeServer,
} from "../telegram-bridge-server.js";

const BOT_TOKEN = "123456789:abcdefghijklmnopqrstuvwxyz_ABCDEF";
const WEBHOOK_SECRET = "a".repeat(43);
const OWNER_CHAT_ID = "123456789";
const BOUND_CONVERSATION = "active-conversation";

type WebhookGateway = { handleWebhook(input: unknown): Promise<string> };

function webhookBody(updateId: number, text = "hello from Telegram"): Uint8Array {
  return Buffer.from(JSON.stringify({
    update_id: updateId,
    message: {
      message_id: updateId + 1,
      date: 1_700_000_000,
      from: { id: Number(OWNER_CHAT_ID), is_bot: false },
      chat: { id: Number(OWNER_CHAT_ID), type: "private" },
      text,
    },
  }), "utf8");
}

function startedGateway(startServer: { mock: { calls: unknown[][] } }): WebhookGateway {
  const calls = startServer.mock.calls;
  const [first] = calls[calls.length - 1] ?? [];
  return (first as { gateway: WebhookGateway }).gateway;
}

function pairedRoute(): TelegramPlatformRoute {
  const binding: PlatformBridgeBinding = Object.freeze({
    bridgeId: "1e7d0f3a-0000-4000-8000-00000000a001",
    bridgeEpoch: 1,
    routeId: "1e7d0f3a-0000-4000-8000-00000000a002",
    routeEpoch: 1,
    scope: "1e7d0f3a-0000-4000-8000-00000000a003",
  });
  return Object.freeze({
    chatId: OWNER_CHAT_ID,
    conversationId: BOUND_CONVERSATION,
    actorDigest: "c".repeat(64),
    binding,
    bridgeBinding: binding,
  });
}

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

function runtime(): ConversationSurfaceRuntime {
  return {
    sharedProjection: {},
    activity: { isBusy: () => false },
  } as ConversationSurfaceRuntime;
}

function commandPort(): ConversationCommandPort {
  return { submit: vi.fn() } as unknown as ConversationCommandPort;
}

function configuredEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    LVIS_TELEGRAM_BRIDGE: "1",
    LVIS_TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    LVIS_TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
    LVIS_TELEGRAM_ALLOWED_USER_IDS: "123456789",
    ...overrides,
  };
}

function fixture() {
  const dispose = vi.fn();
  const bridgeRuntime = {
    authorize: vi.fn(() => null),
    routes: [],
    isRouteCurrent: vi.fn(() => true),
    dispose,
  } as unknown as TelegramPlatformRuntime;
  const close = vi.fn(async (): Promise<void> => {});
  const startServer = vi.fn(async (input: { port: number }) => ({
    port: input.port,
    close,
  }));
  const createRuntime = vi.fn(() => bridgeRuntime);
  const createReceiptStore = vi.fn(() => ({
    reserve: vi.fn(),
    releaseReserved: vi.fn(),
    settle: vi.fn(),
  }));
  return {
    dispose,
    close,
    startServer,
    createRuntime,
    createReceiptStore,
    input: {
      conversationSurfaceRuntime: runtime(),
      conversationCommandPort: commandPort(),
      getCurrentConversationId: () => "active-conversation",
      getCurrentConversationEpoch: () => 0,
      env: configuredEnv(),
      dependencies: {
        createRuntime: createRuntime as never,
        createReceiptStore: createReceiptStore as never,
        startServer: startServer as never,
      },
    },
  };
}

/**
 * A fixture whose runtime admits the owner DM, so a webhook actually reaches
 * authorization, opens a safe delivery channel, and reserves a durable receipt.
 * `fixture()` deliberately authorizes nothing, which is the wrong shape for the
 * reconnect and drain invariants.
 */
function pairedFixture(overrides: {
  readonly receiptStore?: unknown;
  readonly submit?: () => Promise<unknown>;
} = {}) {
  const route = pairedRoute();
  const dispose = vi.fn();
  const bridgeRuntime = {
    authorize: vi.fn(() => ({
      actorDigest: route.actorDigest,
      conversationDigest: "d".repeat(64),
      bridgeBinding: route.binding,
      bridgeGuard: { isCurrent: () => true },
    })),
    routes: [route],
    routeForEnvelope: vi.fn(() => route),
    isRouteCurrent: vi.fn(() => true),
    dispose,
  } as unknown as TelegramPlatformRuntime;
  const close = vi.fn(async (): Promise<void> => {});
  const startServer = vi.fn(async (input: { port: number }) => ({ port: input.port, close }));
  const submit = vi.fn(overrides.submit ?? (async () => ({ ok: true })));
  return {
    route,
    dispose,
    close,
    startServer,
    submit,
    input: {
      conversationSurfaceRuntime: {
        sharedProjection: projectionStore(),
        activity: { isBusy: () => false },
      } as unknown as ConversationSurfaceRuntime,
      conversationCommandPort: { submit } as unknown as ConversationCommandPort,
      getCurrentConversationId: () => BOUND_CONVERSATION,
      getCurrentConversationEpoch: () => 0,
      env: configuredEnv(),
      ...(overrides.receiptStore === undefined ? {} : { receiptStore: overrides.receiptStore as never }),
      dependencies: {
        createRuntime: vi.fn(() => bridgeRuntime) as never,
        startServer: startServer as never,
      },
    },
  };
}

afterEach(async () => {
  await stopTelegramBridgeServer();
  resetTelegramBridgeServerForTests();
  vi.unstubAllGlobals();
});

describe("Telegram bridge lifecycle", () => {
  it("is default OFF before any secret, route, receipt, or listener side effect", async () => {
    const f = fixture();
    await expect(maybeStartTelegramBridgeServer({ ...f.input, env: {} })).resolves.toBeNull();
    await expect(maybeStartTelegramBridgeServer({
      ...f.input,
      env: { LVIS_TELEGRAM_BRIDGE: "0", LVIS_TELEGRAM_BOT_TOKEN: "bad/path" },
    })).resolves.toBeNull();
    expect(f.createRuntime).not.toHaveBeenCalled();
    expect(f.createReceiptStore).not.toHaveBeenCalled();
    expect(f.startServer).not.toHaveBeenCalled();
  });

  it("requires explicit credentials, personal routes, and fixed configuration", () => {
    expect(resolveTelegramBridgeConfig({})).toBeNull();
    expect(resolveTelegramBridgeConfig(configuredEnv())).toEqual({
      port: DEFAULT_TELEGRAM_BRIDGE_PORT,
      webhookPath: DEFAULT_TELEGRAM_WEBHOOK_PATH,
      botToken: BOT_TOKEN,
      webhookSecret: WEBHOOK_SECRET,
      allowedUserIds: ["123456789"],
      routeEpoch: 1,
    });

    for (const env of [
      { LVIS_TELEGRAM_BRIDGE: "true" },
      configuredEnv({ LVIS_TELEGRAM_BOT_TOKEN: "" }),
      configuredEnv({ LVIS_TELEGRAM_BOT_TOKEN: "bad/path" }),
      configuredEnv({ LVIS_TELEGRAM_WEBHOOK_SECRET: "too-short" }),
      configuredEnv({ LVIS_TELEGRAM_ALLOWED_USER_IDS: "123,123" }),
      configuredEnv({ LVIS_TELEGRAM_ALLOWED_USER_IDS: "-123" }),
      configuredEnv({ LVIS_TELEGRAM_PORT: "0" }),
      configuredEnv({ LVIS_TELEGRAM_PORT: "65536" }),
      configuredEnv({ LVIS_TELEGRAM_WEBHOOK_PATH: "/telegram?x=1" }),
      configuredEnv({ LVIS_TELEGRAM_ROUTE_EPOCH: "0" }),
    ]) {
      expect(() => resolveTelegramBridgeConfig(env)).toThrow();
    }
  });

  it("starts one literal-loopback bridge and tears its guard down before its listener", async () => {
    const f = fixture();
    await expect(maybeStartTelegramBridgeServer(f.input)).resolves.toEqual({
      port: DEFAULT_TELEGRAM_BRIDGE_PORT,
    });
    await expect(maybeStartTelegramBridgeServer(f.input)).resolves.toEqual({
      port: DEFAULT_TELEGRAM_BRIDGE_PORT,
    });
    expect(f.createRuntime).toHaveBeenCalledWith(expect.objectContaining({
      allowedUserIds: ["123456789"],
      getCurrentConversationId: f.input.getCurrentConversationId,
      routeEpoch: 1,
      botFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(f.startServer).toHaveBeenCalledOnce();
    expect(f.startServer).toHaveBeenCalledWith(expect.objectContaining({
      host: "127.0.0.1",
      port: DEFAULT_TELEGRAM_BRIDGE_PORT,
      path: DEFAULT_TELEGRAM_WEBHOOK_PATH,
      maxBodyBytes: 64 * 1024,
      gateway: expect.any(Object),
    }));

    await Promise.all([stopTelegramBridgeServer(), stopTelegramBridgeServer()]);
    expect(f.dispose).toHaveBeenCalledOnce();
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.dispose.mock.invocationCallOrder[0]).toBeLessThan(f.close.mock.invocationCallOrder[0]!);
  });

  it("admits Telegram's full 4,096-code-point text bound through the UTF-16 core", async () => {
    const f = fixture();
    await maybeStartTelegramBridgeServer(f.input);
    const started = f.startServer.mock.calls[0]?.[0] as unknown as {
      gateway: { handleWebhook(input: unknown): Promise<string> };
    };
    const text = "😀".repeat(4_096);
    const result = await started.gateway.handleWebhook({
      rawBody: Buffer.from(JSON.stringify({
        update_id: 777,
        message: {
          message_id: 778,
          date: 1_700_000_000,
          from: { id: 123456789, is_bot: false },
          chat: { id: 123456789, type: "private" },
          text,
        },
      }), "utf8"),
      headers: { "x-telegram-bot-api-secret-token": WEBHOOK_SECRET },
    });

    // The fixture has no paired authorization, so reaching this result proves
    // the valid Telegram text passed both provider and shared-core validation.
    expect(result).toBe("authorization-denied");
  });
  it("closes a listener that completes startup after shutdown begins", async () => {
    const f = fixture();
    const close = vi.fn(async (): Promise<void> => {});
    let resolveServer: ((value: { port: number; close: typeof close }) => void) | undefined;
    f.startServer.mockImplementationOnce(() => new Promise((resolve) => {
      resolveServer = resolve;
    }));

    const starting = maybeStartTelegramBridgeServer(f.input);
    // Let the async runtime construction reach the injected listener promise
    // before beginning shutdown; otherwise shutdown correctly fences it before
    // any listener is constructed, which is a different race.
    await Promise.resolve();
    await Promise.resolve();
    const stopping = stopTelegramBridgeServer();
    resolveServer?.({ port: DEFAULT_TELEGRAM_BRIDGE_PORT, close });

    await expect(starting).resolves.toBeNull();
    await stopping;
    expect(f.dispose).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("restarts after an owner disconnect but stays closed after app shutdown", async () => {
    const f = fixture();
    await expect(maybeStartTelegramBridgeServer(f.input)).resolves.toEqual({
      port: DEFAULT_TELEGRAM_BRIDGE_PORT,
    });

    // An owner-initiated stop is not the end of the process. Reaching a second
    // listener without the test-only reset is the whole point.
    await stopTelegramBridgeServer("user");
    await expect(maybeStartTelegramBridgeServer(f.input)).resolves.toEqual({
      port: DEFAULT_TELEGRAM_BRIDGE_PORT,
    });
    expect(f.startServer).toHaveBeenCalledTimes(2);

    // Same fixture, different reason: shutdown must still be terminal, so this
    // assertion cannot pass merely because every stop became non-terminal.
    await stopTelegramBridgeServer("shutdown");
    await expect(maybeStartTelegramBridgeServer(f.input)).resolves.toBeNull();
    expect(f.startServer).toHaveBeenCalledTimes(2);
  });

  it("starts a reconnect issued in the same tick as the disconnect", async () => {
    const f = fixture();
    await maybeStartTelegramBridgeServer(f.input);

    const stopping = stopTelegramBridgeServer("user");
    const restarting = maybeStartTelegramBridgeServer(f.input);
    await stopping;

    await expect(restarting).resolves.toEqual({ port: DEFAULT_TELEGRAM_BRIDGE_PORT });
    expect(f.startServer).toHaveBeenCalledTimes(2);
  });

  it("mints a fresh activation epoch for each connect", async () => {
    const f = fixture();
    await maybeStartTelegramBridgeServer(f.input);
    await stopTelegramBridgeServer("user");
    await maybeStartTelegramBridgeServer(f.input);

    const epochs = (f.createRuntime.mock.calls as unknown as { activationEpoch: number }[][])
      .map((call) => call[0]?.activationEpoch);
    expect(epochs).toEqual([1, 2]);
  });

  it("settles a receipt reserved before a reconnect instead of stranding it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lvis-telegram-receipts-"));
    const receiptStore = createTailnetControllerReceiptStore({
      filePath: join(dir, "command-receipts.json"),
    });
    try {
      // The first activation reserves and never completes its turn, so the
      // record is still `reserved` when the owner disconnects.
      const first = pairedFixture({ receiptStore, submit: () => new Promise(() => {}) });
      await maybeStartTelegramBridgeServer(first.input);
      void startedGateway(first.startServer).handleWebhook({
        rawBody: webhookBody(4_242),
        headers: { "x-telegram-bot-api-secret-token": WEBHOOK_SECRET },
      });
      await vi.waitFor(() => expect(first.submit).toHaveBeenCalled());
      await stopTelegramBridgeServer("user");

      const second = pairedFixture({ receiptStore });
      await maybeStartTelegramBridgeServer(second.input);
      const replay = await startedGateway(second.startServer).handleWebhook({
        rawBody: webhookBody(4_242),
        headers: { "x-telegram-bot-api-secret-token": WEBHOOK_SECRET },
      });

      // A per-gateway owner id makes this "command-outcome-unknown" forever,
      // and such records are deliberately never TTL-pruned.
      expect(replay).toBe("duplicate");
      expect(second.submit).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drains an in-flight safe delivery before closing the adapter", async () => {
    let releaseSend: (() => void) | undefined;
    const sent = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => {
      sent();
      await new Promise<void>((resolve) => {
        releaseSend = resolve;
      });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));

    const f = pairedFixture();
    await maybeStartTelegramBridgeServer(f.input);
    void startedGateway(f.startServer).handleWebhook({
      rawBody: webhookBody(9_100),
      headers: { "x-telegram-bot-api-secret-token": WEBHOOK_SECRET },
    });
    await vi.waitFor(() => expect(sent).toHaveBeenCalled());

    const stopping = stopTelegramBridgeServer("user");
    const settled = await Promise.race([
      stopping.then(() => "stopped" as const),
      new Promise<"pending">((resolve) => { setTimeout(() => resolve("pending"), 60); }),
    ]);
    // Draining after `delivery.close()` would make waitForIdle a no-op and this
    // would already read "stopped".
    expect(settled).toBe("pending");

    releaseSend?.();
    await stopping;
    expect(f.close).toHaveBeenCalledOnce();
  });
});
