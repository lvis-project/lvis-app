import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationSurfaceRuntime } from "../../engine/conversation-surface-runtime.js";
import type { ConversationCommandPort } from "../conversation-command-port.js";
import type { TelegramPlatformRuntime } from "../telegram-platform-runtime.js";
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

afterEach(async () => {
  await stopTelegramBridgeServer();
  resetTelegramBridgeServerForTests();
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
});
