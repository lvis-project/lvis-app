import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNELS } from "../../../contract/app-contract.js";
import { invokeFileIpcHandler } from "./test-helpers.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const intent = Object.freeze({ inputOrigin: "user-keyboard" as const, userActivation: true as const });
const CAPABILITY = "lvis.example.com/cap/conversation-observer";

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
}));

const CONFIG = Object.freeze({
  enabled: true,
  expectedAppCapability: CAPABILITY,
  port: 46_173,
  controllerEnabled: false,
  pairedSharingEnabled: true,
  webEnabled: false,
  webOrigin: "",
});

function snapshotFixture() {
  return {
    saved: CONFIG,
    effective: CONFIG,
    provenance: {
      enabled: "file" as const,
      expectedAppCapability: "file" as const,
      port: "unset" as const,
      controllerEnabled: "unset" as const,
      pairedSharingEnabled: "file" as const,
      webEnabled: "unset" as const,
      webOrigin: "unset" as const,
    },
    listeningPort: 46_173,
    lastStartError: null,
    restartRequired: false,
    pairedSharingBootstrapFailed: false,
  };
}

async function setup(overrides: {
  snapshot?: () => Promise<unknown>;
  apply?: (config: unknown) => Promise<void>;
} = {}) {
  handlers.clear();
  vi.clearAllMocks();
  const service = {
    snapshot: vi.fn(overrides.snapshot ?? (async () => snapshotFixture())),
    apply: vi.fn(overrides.apply ?? (async () => undefined)),
  };
  const { registerTailnetObserverHandlers } = await import("../tailnet-observer.js");
  registerTailnetObserverHandlers({
    auditLogger: { log: vi.fn() },
    tailnetObserverConfigService: service,
    getMainWindow: () => null,
  } as never);
  return service;
}

async function setupDisabled() {
  handlers.clear();
  vi.clearAllMocks();
  const { registerTailnetObserverHandlers } = await import("../tailnet-observer.js");
  registerTailnetObserverHandlers({
    auditLogger: { log: vi.fn() },
    getMainWindow: () => null,
  } as never);
}

beforeEach(() => {
  handlers.clear();
});

describe("Tailnet observer configuration IPC boundary", () => {
  it("is unavailable before it evaluates any payload", async () => {
    await setupDisabled();

    await expect(invokeFileIpcHandler(handlers, CHANNELS.tailnetObserver.snapshot))
      .resolves.toEqual({ ok: false, error: "tailnet-observer-unavailable" });
    await expect(invokeFileIpcHandler(handlers, CHANNELS.tailnetObserver.apply, { intent, config: CONFIG }))
      .resolves.toEqual({ ok: false, error: "tailnet-observer-unavailable" });
  });

  it("rejects a plugin frame, and a proposal with no live keyboard intent", async () => {
    const service = await setup();

    const handler = handlers.get(CHANNELS.tailnetObserver.apply)!;
    await expect(Promise.resolve(handler(
      { senderFrame: { url: "file:///app/plugin-ui-shell.html" } } as never,
      { intent, config: CONFIG },
    ))).resolves.toEqual({ ok: false, error: "unauthorized-frame" });

    await expect(invokeFileIpcHandler(handlers, CHANNELS.tailnetObserver.apply, { config: CONFIG }))
      .resolves.toEqual({ ok: false, error: "user-keyboard-required" });

    expect(service.apply).not.toHaveBeenCalled();
  });

  it("refuses a malformed proposal without reaching the host service", async () => {
    const service = await setup();

    for (const config of [
      undefined,
      { ...CONFIG, port: "46173" },
      { ...CONFIG, enabled: "yes" },
      { ...CONFIG, port: 1.5 },
      [CONFIG],
    ]) {
      await expect(invokeFileIpcHandler(handlers, CHANNELS.tailnetObserver.apply, { intent, config }))
        .resolves.toEqual({ ok: false, error: "tailnet-observer-input-invalid" });
    }
    expect(service.apply).not.toHaveBeenCalled();
  });

  it("passes a valid proposal through and returns the host's own rejection code", async () => {
    const accepted = await setup();
    await expect(invokeFileIpcHandler(handlers, CHANNELS.tailnetObserver.apply, { intent, config: CONFIG }))
      .resolves.toEqual({ ok: true });
    expect(accepted.apply).toHaveBeenCalledWith(CONFIG);

    // The resolver's kebab code is what makes "why is it not up" answerable in
    // the app; it must survive the boundary rather than flatten to a generic.
    await setup({
      apply: async () => {
        throw new Error("tailnet-web-origin-missing-or-invalid");
      },
    });
    await expect(invokeFileIpcHandler(handlers, CHANNELS.tailnetObserver.apply, { intent, config: CONFIG }))
      .resolves.toEqual({ ok: false, error: "tailnet-web-origin-missing-or-invalid" });
  });

  it("never lets a non-code error message out as an error code", async () => {
    await setup({
      apply: async () => {
        throw new Error("EACCES: permission denied, open 'C:\\Users\\example\\.lvis\\tailnet\\observer.json'");
      },
    });

    await expect(invokeFileIpcHandler(handlers, CHANNELS.tailnetObserver.apply, { intent, config: CONFIG }))
      .resolves.toEqual({ ok: false, error: "tailnet-observer-write-failed" });
  });

  it("validates the snapshot it returns rather than trusting the service", async () => {
    await setup({ snapshot: async () => ({ ...snapshotFixture(), listeningPort: "46173" }) });

    await expect(invokeFileIpcHandler(handlers, CHANNELS.tailnetObserver.snapshot))
      .resolves.toEqual({ ok: false, error: "tailnet-observer-unavailable" });
  });

  it("returns the snapshot on the happy path", async () => {
    await setup();

    await expect(invokeFileIpcHandler(handlers, CHANNELS.tailnetObserver.snapshot))
      .resolves.toEqual({ ok: true, snapshot: snapshotFixture() });
  });
});
