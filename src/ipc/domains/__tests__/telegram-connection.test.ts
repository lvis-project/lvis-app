import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNELS } from "../../../contract/app-contract.js";
import { invokeFileIpcHandler } from "./test-helpers.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const intent = Object.freeze({ inputOrigin: "user-keyboard" as const, userActivation: true as const });
const PAIRING_ID = "11111111-1111-4111-8111-111111111111";
const APPROVAL_ID = "22222222-2222-4222-8222-222222222222";
const CODE_ID = "33333333-3333-4333-8333-333333333333";
const BOT_TOKEN = "123456789:SENTINEL-bot-token-for-the-ipc-test";
const PAIRING_CODE = "lvis-tg-v1." + "a".repeat(43);
const PLUGIN_FRAME = { senderFrame: { url: "file:///app/plugin-ui-shell.html" } };

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
}));

const MUTATION_CHANNELS = [
  CHANNELS.telegramConnection.connect,
  CHANNELS.telegramConnection.disconnect,
  CHANNELS.telegramConnection.pause,
  CHANNELS.telegramConnection.resume,
  CHANNELS.telegramConnection.createPairingCode,
  CHANNELS.telegramConnection.revokePairing,
  CHANNELS.telegramConnection.approveCurrentConversation,
  CHANNELS.telegramConnection.revokeApproval,
] as const;

const ALL_CHANNELS = [CHANNELS.telegramConnection.snapshot, ...MUTATION_CHANNELS] as const;

/** A minimal valid payload per channel, so only the tested gate can fail. */
const VALID_PAYLOAD: Readonly<Record<string, Record<string, unknown>>> = Object.freeze({
  [CHANNELS.telegramConnection.connect]: { intent, botToken: BOT_TOKEN },
  [CHANNELS.telegramConnection.disconnect]: { intent },
  [CHANNELS.telegramConnection.pause]: { intent },
  [CHANNELS.telegramConnection.resume]: { intent },
  [CHANNELS.telegramConnection.createPairingCode]: { intent },
  [CHANNELS.telegramConnection.revokePairing]: { intent, id: PAIRING_ID },
  [CHANNELS.telegramConnection.approveCurrentConversation]: { intent, duration: "8h" },
  [CHANNELS.telegramConnection.revokeApproval]: { intent, id: APPROVAL_ID },
});

/** Well-formed enough to reach the guard, wrong enough for it to reject. */
const INVALID_PAYLOAD: Readonly<Record<string, Record<string, unknown>>> = Object.freeze({
  [CHANNELS.telegramConnection.connect]: { intent, botToken: "not-a-bot-token" },
  [CHANNELS.telegramConnection.disconnect]: { intent, extra: true },
  [CHANNELS.telegramConnection.pause]: { intent, extra: true },
  [CHANNELS.telegramConnection.resume]: { intent, extra: true },
  [CHANNELS.telegramConnection.createPairingCode]: { intent, extra: true },
  [CHANNELS.telegramConnection.revokePairing]: { intent, id: "not-a-uuid" },
  [CHANNELS.telegramConnection.approveCurrentConversation]: { intent, duration: "72h" },
  [CHANNELS.telegramConnection.revokeApproval]: { intent, id: "not-a-uuid" },
});

function serviceFixture() {
  let changed: (() => void) | undefined;
  const service = {
    snapshot: vi.fn(() => ({
      ok: true,
      snapshot: {
        state: "active",
        botUsername: "lvis_owner_bot",
        pairing: { id: PAIRING_ID, accountFingerprint: "abcdef123456" },
        approval: { id: APPROVAL_ID, expiresAt: 2_000, matchesCurrentConversation: true },
        pendingCode: null,
        lastErrorCode: null,
      },
    })),
    connect: vi.fn(async () => ({ ok: true })),
    disconnect: vi.fn(async () => ({ ok: true })),
    pause: vi.fn(async () => ({ ok: true })),
    resume: vi.fn(async () => ({ ok: true })),
    createPairingCode: vi.fn(async () => ({
      ok: true,
      pairingCode: {
        id: CODE_ID,
        code: PAIRING_CODE,
        expiresAt: 3_000,
        botUsername: "lvis_owner_bot",
      },
    })),
    revokePairing: vi.fn(async () => ({ ok: true })),
    approveCurrentConversation: vi.fn(async () => ({ ok: true })),
    revokeApproval: vi.fn(async () => ({ ok: true })),
    subscribe: vi.fn((listener: () => void) => {
      changed = listener;
      return () => {};
    }),
  };
  return { service, emitChanged: () => changed?.() };
}

async function setup(options: {
  service?: ReturnType<typeof serviceFixture>;
  includeWindow?: boolean;
} = {}) {
  handlers.clear();
  vi.clearAllMocks();
  const f = options.service ?? serviceFixture();
  const send = vi.fn();
  const log = vi.fn();
  const { registerTelegramConnectionHandlers } = await import("../telegram-connection.js");
  registerTelegramConnectionHandlers({
    auditLogger: { log },
    telegramConnectionService: f.service,
    getMainWindow: () => options.includeWindow
      ? { isDestroyed: () => false, webContents: { send } }
      : null,
    getAppWindows: () => options.includeWindow
      ? [{ isDestroyed: () => false, webContents: { send } }]
      : [],
  } as never);
  return { ...f, send, log };
}

async function setupDisabled() {
  handlers.clear();
  vi.clearAllMocks();
  const log = vi.fn();
  const { registerTelegramConnectionHandlers } = await import("../telegram-connection.js");
  registerTelegramConnectionHandlers({
    auditLogger: { log },
    getMainWindow: () => null,
  } as never);
  return { log };
}

beforeEach(() => {
  handlers.clear();
});

describe("Telegram connection owner IPC boundary", () => {
  it("registers every channel even with no service and answers disabled", async () => {
    await setupDisabled();

    for (const channel of ALL_CHANNELS) {
      expect(handlers.has(channel)).toBe(true);
    }
    await expect(invokeFileIpcHandler(handlers, CHANNELS.telegramConnection.snapshot))
      .resolves.toEqual({ ok: false, error: "telegram-connection-disabled" });
    for (const channel of MUTATION_CHANNELS) {
      await expect(invokeFileIpcHandler(handlers, channel, VALID_PAYLOAD[channel]))
        .resolves.toEqual({ ok: false, error: "telegram-connection-disabled" });
    }
  });

  it("rejects a plugin frame before it consults the service", async () => {
    const f = await setup();

    for (const channel of ALL_CHANNELS) {
      const handler = handlers.get(channel)!;
      await expect(Promise.resolve(handler(PLUGIN_FRAME as never, VALID_PAYLOAD[channel])))
        .resolves.toEqual({ ok: false, error: "unauthorized-frame" });
    }
    expect(f.log).toHaveBeenCalledTimes(ALL_CHANNELS.length);
    expect(f.service.connect).not.toHaveBeenCalled();
    expect(f.service.snapshot).not.toHaveBeenCalled();
    expect(f.service.approveCurrentConversation).not.toHaveBeenCalled();
  });

  it("checks the sender before the service and the service before the intent", async () => {
    const disabled = await setupDisabled();

    // No service AND a plugin frame: the frame check must answer first.
    const handler = handlers.get(CHANNELS.telegramConnection.connect)!;
    await expect(Promise.resolve(handler(PLUGIN_FRAME as never, { intent, botToken: BOT_TOKEN })))
      .resolves.toEqual({ ok: false, error: "unauthorized-frame" });
    expect(disabled.log).toHaveBeenCalledTimes(1);

    // No service AND no intent: the service check must answer first.
    await expect(invokeFileIpcHandler(handlers, CHANNELS.telegramConnection.connect, {}))
      .resolves.toEqual({ ok: false, error: "telegram-connection-disabled" });
  });

  it("requires a live keyboard intent before it validates the payload", async () => {
    const f = await setup();

    for (const channel of MUTATION_CHANNELS) {
      // Payload is invalid too; the intent gate must still be the one to answer.
      const { intent: _dropped, ...withoutIntent } = INVALID_PAYLOAD[channel]!;
      await expect(invokeFileIpcHandler(handlers, channel, withoutIntent))
        .resolves.toEqual({ ok: false, error: "user-keyboard-required" });
      await expect(invokeFileIpcHandler(handlers, channel, {
        ...withoutIntent,
        intent: { inputOrigin: "plugin", userActivation: false },
      })).resolves.toEqual({ ok: false, error: "user-keyboard-required" });
    }
    expect(f.service.connect).not.toHaveBeenCalled();
    expect(f.service.revokePairing).not.toHaveBeenCalled();
  });

  it("rejects a payload the shared guard refuses", async () => {
    const f = await setup();

    for (const channel of MUTATION_CHANNELS) {
      await expect(invokeFileIpcHandler(handlers, channel, INVALID_PAYLOAD[channel]))
        .resolves.toEqual({ ok: false, error: "telegram-connection-input-invalid" });
    }
    // A renderer must not be able to name a conversation on the approve channel.
    await expect(invokeFileIpcHandler(
      handlers,
      CHANNELS.telegramConnection.approveCurrentConversation,
      { intent, conversationId: "renderer-must-not-name-this" },
    )).resolves.toEqual({ ok: false, error: "telegram-connection-input-invalid" });
    expect(f.service.connect).not.toHaveBeenCalled();
    expect(f.service.approveCurrentConversation).not.toHaveBeenCalled();
  });

  it("passes authorized gestures through and broadcasts a data-free hint", async () => {
    const f = await setup({ includeWindow: true });

    await expect(invokeFileIpcHandler(handlers, CHANNELS.telegramConnection.snapshot))
      .resolves.toMatchObject({ ok: true, snapshot: { state: "active", botUsername: "lvis_owner_bot" } });
    for (const channel of MUTATION_CHANNELS) {
      const result = await invokeFileIpcHandler(handlers, channel, VALID_PAYLOAD[channel]);
      if (channel === CHANNELS.telegramConnection.createPairingCode) {
        expect(result).toMatchObject({ ok: true, pairingCode: { id: CODE_ID, code: PAIRING_CODE } });
      } else {
        expect(result).toEqual({ ok: true });
      }
    }

    expect(f.service.connect).toHaveBeenCalledWith(BOT_TOKEN);
    expect(f.service.revokePairing).toHaveBeenCalledWith(PAIRING_ID);
    expect(f.service.revokeApproval).toHaveBeenCalledWith(APPROVAL_ID);
    expect(f.service.approveCurrentConversation).toHaveBeenCalledWith("8h");

    f.emitChanged();
    expect(f.send).toHaveBeenCalledWith(CHANNELS.telegramConnection.changed, {});
  });

  it("fails closed when the service returns a broadened or unknown shape", async () => {
    const f = serviceFixture();
    f.service.snapshot.mockReturnValue({
      ok: true,
      snapshot: {
        state: "active",
        botUsername: "lvis_owner_bot",
        pairing: null,
        approval: null,
        pendingCode: null,
        lastErrorCode: null,
        rawChatId: "-1009988776655",
      },
    } as never);
    f.service.connect.mockResolvedValue({ ok: true, botToken: BOT_TOKEN } as never);
    f.service.createPairingCode.mockResolvedValue({
      ok: true,
      pairingCode: { id: CODE_ID, code: "not-a-one-time-code", expiresAt: 3_000, botUsername: "lvis_owner_bot" },
    } as never);
    await setup({ service: f });

    await expect(invokeFileIpcHandler(handlers, CHANNELS.telegramConnection.snapshot))
      .resolves.toEqual({ ok: false, error: "telegram-connection-unavailable" });
    await expect(invokeFileIpcHandler(handlers, CHANNELS.telegramConnection.connect, {
      intent,
      botToken: BOT_TOKEN,
    })).resolves.toEqual({ ok: false, error: "telegram-connection-operation-rejected" });
    await expect(invokeFileIpcHandler(handlers, CHANNELS.telegramConnection.createPairingCode, {
      intent,
    })).resolves.toEqual({ ok: false, error: "telegram-connection-operation-rejected" });
  });

  it("maps a thrown service error to a stable code", async () => {
    const f = serviceFixture();
    f.service.snapshot.mockImplementation(() => {
      throw new Error("bot token 123456789:leak");
    });
    f.service.disconnect.mockRejectedValue(new Error("bot token 123456789:leak"));
    await setup({ service: f });

    await expect(invokeFileIpcHandler(handlers, CHANNELS.telegramConnection.snapshot))
      .resolves.toEqual({ ok: false, error: "telegram-connection-unavailable" });
    await expect(invokeFileIpcHandler(handlers, CHANNELS.telegramConnection.disconnect, { intent }))
      .resolves.toEqual({ ok: false, error: "telegram-connection-operation-rejected" });
  });
});
