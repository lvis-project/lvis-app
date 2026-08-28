import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNELS, MAIN_CHAT_GROUP_ID } from "../../../contract/app-contract.js";
import { invokeFileIpcHandler } from "./test-helpers.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const intent = Object.freeze({ inputOrigin: "user-keyboard" as const, userActivation: true as const });
const CONVERSATION_ID = "conv-away-1";
/** A second tile, holding a conversation of its own. */
const TILE_GROUP = "group-2";
const TILE_CONVERSATION_ID = "conv-away-tile-2";

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
}));

function gateFixture(overrides: {
  arm?: boolean;
  snapshot?: unknown;
} = {}) {
  return {
    armAwayAuthority: vi.fn(() => overrides.arm ?? true),
    retireAwayAuthority: vi.fn(() => true),
    awayAuthoritySnapshot: vi.fn(() => overrides.snapshot ?? null),
  };
}

async function setup(options: {
  gate?: ReturnType<typeof gateFixture>;
  sessionId?: string;
} = {}) {
  handlers.clear();
  vi.clearAllMocks();
  const gate = options.gate ?? gateFixture();
  const auditLogger = { log: vi.fn() };
  const primaryLoop = { getSessionId: vi.fn(() => options.sessionId ?? CONVERSATION_ID) };
  const tileLoop = { getSessionId: vi.fn(() => TILE_CONVERSATION_ID) };
  // Two tiles are open. Arming names one of them; a name the window is not
  // showing resolves to nothing.
  const findChatGroupLoop = vi.fn((chatGroupId: string) => {
    if (chatGroupId === MAIN_CHAT_GROUP_ID) return primaryLoop;
    if (chatGroupId === TILE_GROUP) return tileLoop;
    return undefined;
  });
  const { registerAwayAuthorityHandlers } = await import("../away-authority.js");
  registerAwayAuthorityHandlers({
    auditLogger,
    approvalGate: gate,
    conversationLoop: primaryLoop,
    findChatGroupLoop,
    getMainWindow: () => null,
  } as never);
  return { gate, auditLogger, findChatGroupLoop };
}

async function setupDisabled() {
  handlers.clear();
  vi.clearAllMocks();
  const { registerAwayAuthorityHandlers } = await import("../away-authority.js");
  registerAwayAuthorityHandlers({
    auditLogger: { log: vi.fn() },
    conversationLoop: { getSessionId: vi.fn(() => CONVERSATION_ID) },
    findChatGroupLoop: vi.fn(() => ({ getSessionId: vi.fn(() => CONVERSATION_ID) })),
    getMainWindow: () => null,
  } as never);
}

/** A payload that is valid in every respect, so a test can spoil exactly one field. */
function armPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    intent,
    chatGroupId: MAIN_CHAT_GROUP_ID,
    mode: "read-only",
    directories: ["/home/owner/project"],
    duration: "1h",
    budget: 10,
    ...overrides,
  };
}

/** An IPC event whose sender frame is a plugin shell, never the host renderer. */
const PLUGIN_FRAME_EVENT = {
  frameId: 0,
  processId: 0,
  senderFrame: { url: "file:///app/plugin-ui-shell.html" },
} as never;

beforeEach(() => {
  handlers.clear();
});

describe("Away authority arm IPC boundary", () => {
  it("registers all three channels even with no approval gate", async () => {
    await setupDisabled();

    expect([...handlers.keys()].sort()).toEqual([
      CHANNELS.awayAuthority.arm,
      CHANNELS.awayAuthority.disarm,
      CHANNELS.awayAuthority.status,
    ].sort());
  });

  it("answers a frozen disabled result on every channel with no approval gate", async () => {
    await setupDisabled();

    for (const channel of [
      CHANNELS.awayAuthority.status,
      CHANNELS.awayAuthority.arm,
      CHANNELS.awayAuthority.disarm,
    ]) {
      const result = await invokeFileIpcHandler(handlers, channel, armPayload());
      expect(result).toEqual({ ok: false, error: "away-authority-disabled" });
      expect(Object.isFrozen(result)).toBe(true);
    }
  });

  it("rejects a non-host-renderer sender before reading the payload", async () => {
    const { gate, auditLogger } = await setup();

    const armed = await Promise.resolve(
      handlers.get(CHANNELS.awayAuthority.arm)!(PLUGIN_FRAME_EVENT, armPayload()),
    );
    const disarmed = await Promise.resolve(
      handlers.get(CHANNELS.awayAuthority.disarm)!(PLUGIN_FRAME_EVENT, { intent }),
    );
    const status = await Promise.resolve(
      handlers.get(CHANNELS.awayAuthority.status)!(PLUGIN_FRAME_EVENT),
    );

    expect(armed).toEqual({ ok: false, error: "unauthorized-frame" });
    expect(disarmed).toEqual({ ok: false, error: "unauthorized-frame" });
    expect(status).toEqual({ ok: false, error: "unauthorized-frame" });
    expect(gate.armAwayAuthority).not.toHaveBeenCalled();
    expect(gate.retireAwayAuthority).not.toHaveBeenCalled();
    expect(gate.awayAuthoritySnapshot).not.toHaveBeenCalled();
    expect(auditLogger.log).toHaveBeenCalledTimes(3);
  });

  it("requires a live keyboard intent to arm or disarm", async () => {
    const { gate } = await setup();
    const noIntent = armPayload();
    delete noIntent.intent;

    await expect(invokeFileIpcHandler(handlers, CHANNELS.awayAuthority.arm, noIntent))
      .resolves.toEqual({ ok: false, error: "user-keyboard-required" });
    await expect(invokeFileIpcHandler(handlers, CHANNELS.awayAuthority.disarm, {}))
      .resolves.toEqual({ ok: false, error: "user-keyboard-required" });
    expect(gate.armAwayAuthority).not.toHaveBeenCalled();
    expect(gate.retireAwayAuthority).not.toHaveBeenCalled();
  });

  it("rejects a replayed intent that is not a current keyboard gesture", async () => {
    const { gate } = await setup();

    await expect(invokeFileIpcHandler(
      handlers,
      CHANNELS.awayAuthority.arm,
      armPayload({ intent: { inputOrigin: "user-keyboard", userActivation: false } }),
    )).resolves.toEqual({ ok: false, error: "user-keyboard-required" });
    expect(gate.armAwayAuthority).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown mode", armPayload({ mode: "read-network" })],
    ["a mode the parser would reject outright", armPayload({ mode: "shell" })],
    ["a duration outside the offered presets", armPayload({ duration: "12h" })],
    ["a budget outside the offered presets", armPayload({ budget: 500 })],
    ["a directory list that is not an array", armPayload({ directories: "/home/owner" })],
    ["an empty-string directory", armPayload({ directories: [""] })],
    ["more directories than the wire allows", armPayload({
      directories: Array.from({ length: 17 }, (_unused, index) => `/home/owner/p${index}`),
    })],
    ["an extra field", armPayload({ conversationId: "conv-other" })],
    ["no chat group at all", (() => { const p = armPayload(); delete p["chatGroupId"]; return p; })()],
    ["a blank chat group", armPayload({ chatGroupId: "   " })],
    ["a chat group that is not a string", armPayload({ chatGroupId: 2 })],
  ])("refuses %s without calling the gate", async (_label, payload) => {
    const { gate } = await setup();

    await expect(invokeFileIpcHandler(handlers, CHANNELS.awayAuthority.arm, payload))
      .resolves.toEqual({ ok: false, error: "away-authority-input-invalid" });
    expect(gate.armAwayAuthority).not.toHaveBeenCalled();
  });

  it("arms read-only with the conversation main resolved, never one the caller named", async () => {
    const { gate } = await setup();

    await expect(invokeFileIpcHandler(handlers, CHANNELS.awayAuthority.arm, armPayload()))
      .resolves.toEqual({ ok: true });
    expect(gate.armAwayAuthority).toHaveBeenCalledWith({
      conversationId: CONVERSATION_ID,
      categories: ["read"],
      directories: ["/home/owner/project"],
      ttlMs: 60 * 60 * 1000,
      budget: 10,
    });
  });

  it("arms write only as read plus write, at the longest offered lifetime", async () => {
    const { gate } = await setup();

    await expect(invokeFileIpcHandler(
      handlers,
      CHANNELS.awayAuthority.arm,
      armPayload({ mode: "read-write", duration: "4h", budget: 50 }),
    )).resolves.toEqual({ ok: true });
    expect(gate.armAwayAuthority).toHaveBeenCalledWith(expect.objectContaining({
      categories: ["read", "write"],
      ttlMs: 4 * 60 * 60 * 1000,
      budget: 50,
    }));
  });

  it.each([
    ["30m", 30 * 60 * 1000],
    ["1h", 60 * 60 * 1000],
    ["2h", 2 * 60 * 60 * 1000],
    ["4h", 4 * 60 * 60 * 1000],
  ])("maps the %s preset to its own lifetime", async (duration, ttlMs) => {
    const { gate } = await setup();

    await invokeFileIpcHandler(handlers, CHANNELS.awayAuthority.arm, armPayload({ duration }));

    expect(gate.armAwayAuthority).toHaveBeenCalledWith(expect.objectContaining({ ttlMs }));
  });

  it("reports the gate's refusal rather than claiming an arming that did not happen", async () => {
    const { gate } = await setup({ gate: gateFixture({ arm: false }) });

    await expect(invokeFileIpcHandler(handlers, CHANNELS.awayAuthority.arm, armPayload()))
      .resolves.toEqual({ ok: false, error: "away-authority-operation-rejected" });
    expect(gate.armAwayAuthority).toHaveBeenCalledTimes(1);
  });

  it("arms the conversation the NAMED tile is holding, not the primary one", async () => {
    const { gate, findChatGroupLoop } = await setup();

    await expect(invokeFileIpcHandler(
      handlers,
      CHANNELS.awayAuthority.arm,
      armPayload({ chatGroupId: TILE_GROUP }),
    )).resolves.toEqual({ ok: true });

    expect(findChatGroupLoop).toHaveBeenCalledWith(TILE_GROUP);
    expect(gate.armAwayAuthority).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: TILE_CONVERSATION_ID,
    }));
  });

  it("refuses a tile the window is not showing rather than arming the primary", async () => {
    const { gate } = await setup();

    await expect(invokeFileIpcHandler(
      handlers,
      CHANNELS.awayAuthority.arm,
      armPayload({ chatGroupId: "group-that-was-closed" }),
    )).resolves.toEqual({ ok: false, error: "away-authority-operation-rejected" });
    expect(gate.armAwayAuthority).not.toHaveBeenCalled();
  });

  it("refuses to arm when no conversation is open", async () => {
    const { gate } = await setup({ sessionId: "" });

    await expect(invokeFileIpcHandler(handlers, CHANNELS.awayAuthority.arm, armPayload()))
      .resolves.toEqual({ ok: false, error: "away-authority-operation-rejected" });
    expect(gate.armAwayAuthority).not.toHaveBeenCalled();
  });

  it("disarms as the desk and reports success even when nothing was armed", async () => {
    const gate = gateFixture();
    gate.retireAwayAuthority.mockReturnValue(false);
    await setup({ gate });

    await expect(invokeFileIpcHandler(handlers, CHANNELS.awayAuthority.disarm, { intent }))
      .resolves.toEqual({ ok: true });
    expect(gate.retireAwayAuthority).toHaveBeenCalledWith("desk-disarm");
  });

  it("projects a live grant into the desk status", async () => {
    const gate = gateFixture({
      snapshot: {
        conversationId: CONVERSATION_ID,
        categories: ["read", "write"],
        directories: ["/home/owner/project"],
        expiresAt: Date.now() + 60_000,
        remaining: 7,
      },
    });
    await setup({ gate });

    await expect(invokeFileIpcHandler(handlers, CHANNELS.awayAuthority.status))
      .resolves.toEqual({
        ok: true,
        status: {
          writable: true,
          directories: ["/home/owner/project"],
          expiresAt: expect.any(Number),
          remaining: 7,
        },
      });
  });

  it("reports a read-only grant as not writable", async () => {
    const gate = gateFixture({
      snapshot: {
        conversationId: CONVERSATION_ID,
        categories: ["read"],
        directories: ["/home/owner/project"],
        expiresAt: Date.now() + 60_000,
        remaining: 3,
      },
    });
    await setup({ gate });

    const result = await invokeFileIpcHandler(handlers, CHANNELS.awayAuthority.status) as {
      status: { writable: boolean };
    };
    expect(result.status.writable).toBe(false);
  });

  it("reports an expired grant as nothing armed without writing a desk-disarm row", async () => {
    const gate = gateFixture({
      snapshot: {
        conversationId: CONVERSATION_ID,
        categories: ["read"],
        directories: ["/home/owner/project"],
        // `awayAuthoritySnapshot` does no time check, so this is exactly the
        // state that would otherwise be displayed as armed.
        expiresAt: Date.now() - 1,
        remaining: 5,
      },
    });
    await setup({ gate });

    await expect(invokeFileIpcHandler(handlers, CHANNELS.awayAuthority.status))
      .resolves.toEqual({ ok: true, status: null });
    expect(gate.retireAwayAuthority).not.toHaveBeenCalled();
  });

  it("reports nothing armed when the gate holds no grant", async () => {
    await setup();

    await expect(invokeFileIpcHandler(handlers, CHANNELS.awayAuthority.status))
      .resolves.toEqual({ ok: true, status: null });
  });

  it("does not require a keyboard intent to read the status", async () => {
    const gate = gateFixture({
      snapshot: {
        conversationId: CONVERSATION_ID,
        categories: ["read"],
        directories: ["/home/owner/project"],
        expiresAt: Date.now() + 60_000,
        remaining: 2,
      },
    });
    await setup({ gate });

    await expect(invokeFileIpcHandler(handlers, CHANNELS.awayAuthority.status))
      .resolves.toMatchObject({ ok: true });
  });

  it("turns a throwing gate into a failure result rather than a rejected invoke", async () => {
    const gate = gateFixture();
    gate.armAwayAuthority.mockImplementation(() => { throw new Error("boom"); });
    gate.awayAuthoritySnapshot.mockImplementation(() => { throw new Error("boom"); });
    await setup({ gate });

    await expect(invokeFileIpcHandler(handlers, CHANNELS.awayAuthority.arm, armPayload()))
      .resolves.toEqual({ ok: false, error: "away-authority-operation-rejected" });
    await expect(invokeFileIpcHandler(handlers, CHANNELS.awayAuthority.status))
      .resolves.toEqual({ ok: false, error: "away-authority-unavailable" });
  });
});
