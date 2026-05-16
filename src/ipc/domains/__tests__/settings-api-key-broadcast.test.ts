/**
 * M3 regression: set-api-key and delete-api-key broadcast SETTINGS.updated
 * to all app windows so the reviewer tab auto-unlocks without a full reload.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SETTINGS } from "../../../shared/ipc-channels.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
}));

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`No handler registered for: ${channel}`);
  return Promise.resolve(fn({ frameId: 0, processId: 0, frame: { url: "lvis://app" } } as never, ...args));
}

function makeWindow() {
  return {
    isDestroyed: vi.fn(() => false),
    webContents: {
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
    },
  };
}

function makeDeps(appWindows: ReturnType<typeof makeWindow>[]) {
  return {
    settingsService: {
      getAll: vi.fn(() => ({ llm: { provider: "openai" } })),
      get: vi.fn(() => ({ provider: "openai" })),
      patch: vi.fn(async (p: unknown) => p),
      getSecret: vi.fn(() => null),
      setSecret: vi.fn(async () => undefined),
      deleteSecret: vi.fn(async () => undefined),
    },
    conversationLoop: {
      refreshProvider: vi.fn(),
    },
    auditLogger: { log: vi.fn() },
    getAppWindows: vi.fn(() => appWindows),
  };
}

beforeEach(() => {
  handlers.clear();
  vi.resetModules();
});

describe("set-api-key broadcast (M3)", () => {
  it("broadcasts SETTINGS.updated to all app windows after storing the key", async () => {
    const windows = [makeWindow(), makeWindow()];
    const deps = makeDeps(windows);
    const snapshot = { llm: { provider: "openai" } };
    deps.settingsService.getAll.mockReturnValue(snapshot);

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    await invoke("lvis:settings:set-api-key", "claude", "sk-ant-test");

    expect(deps.settingsService.setSecret).toHaveBeenCalledWith("llm.apiKey.claude", "sk-ant-test");
    expect(deps.conversationLoop.refreshProvider).toHaveBeenCalled();
    for (const win of windows) {
      expect(win.webContents.send).toHaveBeenCalledWith(SETTINGS.updated, snapshot);
    }
  });

  it("broadcasts to all windows, skipping destroyed ones via sendToWindow", async () => {
    const liveWindow = makeWindow();
    const deadWindow = makeWindow();
    deadWindow.isDestroyed.mockReturnValue(true);
    const deps = makeDeps([liveWindow, deadWindow]);

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    await invoke("lvis:settings:set-api-key", "azure-foundry", "az-key");

    // live window gets the broadcast; destroyed window is skipped by sendToWindow
    expect(liveWindow.webContents.send).toHaveBeenCalledWith(SETTINGS.updated, expect.anything());
    expect(deadWindow.webContents.send).not.toHaveBeenCalled();
  });
});

describe("delete-api-key broadcast (M3)", () => {
  it("broadcasts SETTINGS.updated to all app windows after deleting the key", async () => {
    const windows = [makeWindow(), makeWindow()];
    const deps = makeDeps(windows);
    const snapshot = { llm: { provider: "openai" } };
    deps.settingsService.getAll.mockReturnValue(snapshot);

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    await invoke("lvis:settings:delete-api-key", "gemini");

    expect(deps.settingsService.deleteSecret).toHaveBeenCalledWith("llm.apiKey.gemini");
    expect(deps.conversationLoop.refreshProvider).toHaveBeenCalled();
    for (const win of windows) {
      expect(win.webContents.send).toHaveBeenCalledWith(SETTINGS.updated, snapshot);
    }
  });
});
