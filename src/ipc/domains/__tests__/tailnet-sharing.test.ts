import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNELS } from "../../../contract/app-contract.js";
import { invokeFileIpcHandler } from "./test-helpers.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const intent = Object.freeze({ inputOrigin: "user-keyboard" as const, userActivation: true as const });
const PAIRING_ID = "11111111-1111-4111-8111-111111111111";
const INVITATION_ID = "22222222-2222-4222-8222-222222222222";
const SHARE_ID = "33333333-3333-4333-8333-333333333333";

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
}));

function ownerFixture() {
  let changed: (() => void) | undefined;
  const owner = {
    snapshot: vi.fn(() => ({
      invitations: [{ id: INVITATION_ID, expiresAt: 1_000 }],
      pairings: [{ id: PAIRING_ID, actorFingerprint: "abcdef123456", state: "active", expiresAt: null }],
      shares: [{
        id: SHARE_ID,
        pairingId: PAIRING_ID,
        actorFingerprint: "abcdef123456",
        permission: "observe",
        expiresAt: 2_000,
      }],
    })),
    createInvitation: vi.fn(async () => ({
      id: INVITATION_ID,
      code: "lvis-pair-v1." + "a".repeat(43),
      expiresAt: 1_000,
    })),
    activatePairing: vi.fn(async () => true),
    createCurrentConversationShare: vi.fn(async () => true),
    revokeShare: vi.fn(async () => true),
    revokePairing: vi.fn(async () => true),
    subscribe: vi.fn((listener: () => void) => {
      changed = listener;
      return () => {};
    }),
  };
  return {
    owner,
    emitChanged: () => changed?.(),
  };
}

async function setup(options: { owner?: ReturnType<typeof ownerFixture>; includeWindow?: boolean } = {}) {
  handlers.clear();
  vi.clearAllMocks();
  const f = options.owner ?? ownerFixture();
  const send = vi.fn();
  const { registerTailnetSharingHandlers } = await import("../tailnet-sharing.js");
  registerTailnetSharingHandlers({
    auditLogger: { log: vi.fn() },
    tailnetSharingOwnerService: f.owner,
    getMainWindow: () => options.includeWindow
      ? { isDestroyed: () => false, webContents: { send } }
      : null,
    getAppWindows: () => options.includeWindow
      ? [{ isDestroyed: () => false, webContents: { send } }]
      : [],
  } as never);
  return { ...f, send };
}

async function setupDisabled() {
  handlers.clear();
  vi.clearAllMocks();
  const { registerTailnetSharingHandlers } = await import("../tailnet-sharing.js");
  registerTailnetSharingHandlers({
    auditLogger: { log: vi.fn() },
    getMainWindow: () => null,
  } as never);
}

beforeEach(() => {
  handlers.clear();
});

describe("Tailnet sharing owner IPC boundary", () => {
  it("is disabled before it evaluates mutation payloads", async () => {
    await setupDisabled();

    await expect(invokeFileIpcHandler(handlers, CHANNELS.tailnetSharing.snapshot))
      .resolves.toEqual({ ok: false, error: "tailnet-sharing-disabled" });
    await expect(invokeFileIpcHandler(handlers, CHANNELS.tailnetSharing.createInvitation, {}))
      .resolves.toEqual({ ok: false, error: "tailnet-sharing-disabled" });
  });

  it("rejects plugin-frame, missing-intent, and renderer-supplied conversation inputs", async () => {
    const f = await setup();

    const handler = handlers.get(CHANNELS.tailnetSharing.createCurrentConversationShare)!;
    await expect(Promise.resolve(handler(
      { senderFrame: { url: "file:///app/plugin-ui-shell.html" } } as never,
      { intent, pairingId: PAIRING_ID, permission: "observe" },
    ))).resolves.toEqual({ ok: false, error: "unauthorized-frame" });

    await expect(invokeFileIpcHandler(handlers, CHANNELS.tailnetSharing.createInvitation, {}))
      .resolves.toEqual({ ok: false, error: "user-keyboard-required" });
    await expect(invokeFileIpcHandler(handlers, CHANNELS.tailnetSharing.createCurrentConversationShare, {
      intent,
      pairingId: PAIRING_ID,
      permission: "observe",
      conversationId: "renderer-must-not-name-this",
    })).resolves.toEqual({ ok: false, error: "tailnet-sharing-input-invalid" });
    expect(f.owner.createCurrentConversationShare).not.toHaveBeenCalled();
  });

  it("projects only the safe wire schema, invokes allowed mutations, and broadcasts a data-free hint", async () => {
    const f = await setup({ includeWindow: true });

    await expect(invokeFileIpcHandler(handlers, CHANNELS.tailnetSharing.snapshot))
      .resolves.toMatchObject({ ok: true, snapshot: { pairings: [{ id: PAIRING_ID }] } });
    await expect(invokeFileIpcHandler(handlers, CHANNELS.tailnetSharing.createInvitation, {
      intent,
      duration: "10m",
    })).resolves.toMatchObject({
      ok: true,
      invitation: { id: INVITATION_ID, code: /^lvis-pair-v1\./ },
    });
    await expect(invokeFileIpcHandler(handlers, CHANNELS.tailnetSharing.activatePairing, {
      intent,
      id: PAIRING_ID,
    })).resolves.toEqual({ ok: true });
    await expect(invokeFileIpcHandler(handlers, CHANNELS.tailnetSharing.createCurrentConversationShare, {
      intent,
      pairingId: PAIRING_ID,
      permission: "control",
      duration: "1h",
    })).resolves.toEqual({ ok: true });
    await expect(invokeFileIpcHandler(handlers, CHANNELS.tailnetSharing.revokeShare, {
      intent,
      id: SHARE_ID,
    })).resolves.toEqual({ ok: true });
    await expect(invokeFileIpcHandler(handlers, CHANNELS.tailnetSharing.revokePairing, {
      intent,
      id: PAIRING_ID,
    })).resolves.toEqual({ ok: true });

    expect(f.owner.createCurrentConversationShare).toHaveBeenCalledWith(PAIRING_ID, "control", "1h");
    f.emitChanged();
    expect(f.send).toHaveBeenCalledWith(CHANNELS.tailnetSharing.changed, {});
  });

  it("fails closed when an owner facade tries to return a broadened snapshot or invitation", async () => {
    const f = ownerFixture();
    f.owner.snapshot.mockReturnValue({
      invitations: [],
      pairings: [],
      shares: [],
      rawConversationId: "must-not-leak",
    } as never);
    f.owner.createInvitation.mockResolvedValue({
      id: INVITATION_ID,
      code: "not-a-one-time-code",
      expiresAt: 1_000,
    });
    await setup({ owner: f });

    await expect(invokeFileIpcHandler(handlers, CHANNELS.tailnetSharing.snapshot))
      .resolves.toEqual({ ok: false, error: "tailnet-sharing-unavailable" });
    await expect(invokeFileIpcHandler(handlers, CHANNELS.tailnetSharing.createInvitation, { intent }))
      .resolves.toEqual({ ok: false, error: "tailnet-sharing-operation-rejected" });
  });
});
