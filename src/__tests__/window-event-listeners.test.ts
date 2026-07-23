/**
 * registerWindowEventListeners — re-attachment after render-process-gone recovery.
 *
 * Verifies that maximize / fullscreen broadcast listeners work correctly on a
 * fresh BrowserWindow instance, ensuring recovery paths (macOS re-activation,
 * handleLvisUri window re-creation) don't silently lose these listeners.
 *
 * Strategy: create a minimal BrowserWindow fake with an EventEmitter-style
 * on() / emit() and a spy for webContents.send, then call
 * registerWindowEventListeners and fire each event.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Electron mock ────────────────────────────────────────────────────────────

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  app: { getVersion: vi.fn(() => "0.0.0"), isPackaged: false },
  shell: {},
  dialog: {},
}));

// ─── Other transitive mocks required by ipc-bridge.ts ────────────────────────

vi.mock("../permissions/policy-store.js", () => ({
  loadPolicy: vi.fn(async () => ({ mode: "default", rules: [] })),
  savePolicy: vi.fn(),
}));
vi.mock("../audit/dlp-filter.js", () => ({
  redactForLLM: vi.fn((x: unknown) => x),
  initDlpAudit: vi.fn(),
}));
vi.mock("../audit/audit-logger.js", () => ({ createAuditLogger: vi.fn() }));
vi.mock("../shared/overlay-trigger-source.js", () => ({
  parseImportedTriggerEnvelope: vi.fn(),
}));

// ─── BrowserWindow stub ───────────────────────────────────────────────────────

function makeFakeWindow() {
  const listeners = new Map<string, Array<() => void>>();
  const sendSpy = vi.fn();
  return {
    on(event: string, fn: () => void) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event)!.push(fn);
    },
    emit(event: string) {
      for (const fn of listeners.get(event) ?? []) fn();
    },
    webContents: { send: sendSpy },
    _sendSpy: sendSpy,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("registerWindowEventListeners", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends window:maximizedChanged true on maximize event", async () => {
    const { registerWindowEventListeners } = await import("../ipc-bridge.js");
    const win = makeFakeWindow();
    registerWindowEventListeners(win as any);
    win.emit("maximize");
    expect(win._sendSpy).toHaveBeenCalledWith("window:maximizedChanged", true);
  });

  it("sends window:maximizedChanged false on unmaximize event", async () => {
    const { registerWindowEventListeners } = await import("../ipc-bridge.js");
    const win = makeFakeWindow();
    registerWindowEventListeners(win as any);
    win.emit("unmaximize");
    expect(win._sendSpy).toHaveBeenCalledWith("window:maximizedChanged", false);
  });

  it("sends window:fullscreenChanged true on enter-full-screen event", async () => {
    const { registerWindowEventListeners } = await import("../ipc-bridge.js");
    const win = makeFakeWindow();
    registerWindowEventListeners(win as any);
    win.emit("enter-full-screen");
    expect(win._sendSpy).toHaveBeenCalledWith("window:fullscreenChanged", true);
  });

  it("sends window:fullscreenChanged false on leave-full-screen event", async () => {
    const { registerWindowEventListeners } = await import("../ipc-bridge.js");
    const win = makeFakeWindow();
    registerWindowEventListeners(win as any);
    win.emit("leave-full-screen");
    expect(win._sendSpy).toHaveBeenCalledWith("window:fullscreenChanged", false);
  });

  it("re-attaches correctly to a second window instance (recovery scenario)", async () => {
    const { registerWindowEventListeners } = await import("../ipc-bridge.js");

    const win1 = makeFakeWindow();
    const win2 = makeFakeWindow();

    registerWindowEventListeners(win1 as any);
    registerWindowEventListeners(win2 as any);

    // Only win2's listeners should fire when win2 emits — no cross-contamination.
    win2.emit("maximize");

    expect(win1._sendSpy).not.toHaveBeenCalled();
    expect(win2._sendSpy).toHaveBeenCalledWith("window:maximizedChanged", true);
  });

  it("locks the backwards-compatible runtime facade exports", async () => {
    const bridge = await import("../ipc-bridge.js");

    expect(Object.keys(bridge).sort()).toEqual([
      "UNAUTHORIZED_FRAME",
      "auditUnauthorized",
      "getLastThemePayload",
      "registerIpcHandlers",
      "registerWindowEventListeners",
      "unregisterPluginWebview",
      "validatePluginFrame",
      "validateSender",
    ]);
  });
});
