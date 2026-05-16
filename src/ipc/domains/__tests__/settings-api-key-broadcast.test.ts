/**
 * MAJOR-3 regression: all 4 secret-mutation handlers broadcast SETTINGS.updated
 * to all app windows so the reviewer tab auto-unlocks without a full reload:
 *   - lvis:settings:set-api-key
 *   - lvis:settings:delete-api-key
 *   - lvis:settings:set-web-api-key
 *   - lvis:settings:delete-web-api-key
 *   - lvis:settings:marketplace:set-api-key
 *   - lvis:settings:marketplace:delete-api-key
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

function makeDeps(appWindows: ReturnType<typeof makeWindow>[], vendorBaseUrl?: string) {
  return {
    settingsService: {
      getAll: vi.fn(() => ({ llm: { provider: "openai" } })),
      get: vi.fn(() => ({
        provider: "openai",
        vendors: { "azure-foundry": { baseUrl: vendorBaseUrl ?? null } },
      })),
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

describe("delete-api-key broadcast (MAJOR-3)", () => {
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

// ─── MAJOR-3: set/delete-web-api-key broadcast ────────────────────────

describe("set-web-api-key broadcast (MAJOR-3)", () => {
  it("broadcasts SETTINGS.updated to all app windows after storing the web key", async () => {
    const windows = [makeWindow(), makeWindow()];
    const deps = makeDeps(windows);
    const snapshot = { llm: { provider: "openai" } };
    deps.settingsService.getAll.mockReturnValue(snapshot);

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    await invoke("lvis:settings:set-web-api-key", "bing", "bing-key-123");

    expect(deps.settingsService.setSecret).toHaveBeenCalledWith("web.apiKey.bing", "bing-key-123");
    for (const win of windows) {
      expect(win.webContents.send).toHaveBeenCalledWith(SETTINGS.updated, snapshot);
    }
  });
});

describe("delete-web-api-key broadcast (MAJOR-3)", () => {
  it("broadcasts SETTINGS.updated to all app windows after deleting the web key", async () => {
    const windows = [makeWindow(), makeWindow()];
    const deps = makeDeps(windows);
    const snapshot = { llm: { provider: "openai" } };
    deps.settingsService.getAll.mockReturnValue(snapshot);

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    await invoke("lvis:settings:delete-web-api-key", "bing");

    expect(deps.settingsService.deleteSecret).toHaveBeenCalledWith("web.apiKey.bing");
    for (const win of windows) {
      expect(win.webContents.send).toHaveBeenCalledWith(SETTINGS.updated, snapshot);
    }
  });
});

// ─── MAJOR-3: marketplace:set/delete-api-key broadcast ───────────────

describe("marketplace:set-api-key broadcast (MAJOR-3)", () => {
  it("broadcasts SETTINGS.updated to all app windows after storing marketplace key", async () => {
    const windows = [makeWindow(), makeWindow()];
    const deps = makeDeps(windows);
    const snapshot = { llm: { provider: "openai" } };
    deps.settingsService.getAll.mockReturnValue(snapshot);

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    await invoke("lvis:settings:marketplace:set-api-key", "mkt-key-xyz");

    expect(deps.settingsService.setSecret).toHaveBeenCalledWith("marketplace.apiKey", "mkt-key-xyz");
    for (const win of windows) {
      expect(win.webContents.send).toHaveBeenCalledWith(SETTINGS.updated, snapshot);
    }
  });
});

describe("marketplace:delete-api-key broadcast (MAJOR-3)", () => {
  it("broadcasts SETTINGS.updated to all app windows after deleting marketplace key", async () => {
    const windows = [makeWindow(), makeWindow()];
    const deps = makeDeps(windows);
    const snapshot = { llm: { provider: "openai" } };
    deps.settingsService.getAll.mockReturnValue(snapshot);

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    await invoke("lvis:settings:marketplace:delete-api-key");

    expect(deps.settingsService.deleteSecret).toHaveBeenCalledWith("marketplace.apiKey");
    for (const win of windows) {
      expect(win.webContents.send).toHaveBeenCalledWith(SETTINGS.updated, snapshot);
    }
  });
});

// ─── LOW-2: settings:update validates vendors["azure-foundry"].baseUrl ────────

describe("LOW-2: settings:update validates azure-foundry baseUrl at write time", () => {
  it("returns invalid-foundry-endpoint when baseUrl is HTTP (not HTTPS)", async () => {
    const windows: ReturnType<typeof makeWindow>[] = [];
    const deps = makeDeps(windows);

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    const result = await invoke("lvis:settings:update", {
      llm: { vendors: { "azure-foundry": { baseUrl: "http://proj.services.ai.azure.com" } } },
    });

    expect(result).toMatchObject({ ok: false, error: "invalid-foundry-endpoint" });
    // Must NOT have called settingsService.patch with invalid endpoint
    expect(deps.settingsService.patch).not.toHaveBeenCalled();
  });

  it("returns invalid-foundry-endpoint when baseUrl has non-azure hostname", async () => {
    const windows: ReturnType<typeof makeWindow>[] = [];
    const deps = makeDeps(windows);

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    const result = await invoke("lvis:settings:update", {
      llm: { vendors: { "azure-foundry": { baseUrl: "https://evil.example.com" } } },
    });

    expect(result).toMatchObject({ ok: false, error: "invalid-foundry-endpoint" });
    expect(deps.settingsService.patch).not.toHaveBeenCalled();
  });

  it("passes through and patches when baseUrl is a valid Foundry endpoint", async () => {
    const windows: ReturnType<typeof makeWindow>[] = [];
    const deps = makeDeps(windows);
    deps.settingsService.patch.mockResolvedValue({ ok: true });

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    const patch = {
      llm: { vendors: { "azure-foundry": { baseUrl: "https://proj.services.ai.azure.com" } } },
    };
    await invoke("lvis:settings:update", patch);

    expect(deps.settingsService.patch).toHaveBeenCalledWith(patch);
  });

  it("passes through updates that don't touch azure-foundry baseUrl", async () => {
    const windows: ReturnType<typeof makeWindow>[] = [];
    const deps = makeDeps(windows);
    deps.settingsService.patch.mockResolvedValue({ ok: true });

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    const patch = { llm: { provider: "openai" } };
    await invoke("lvis:settings:update", patch);

    expect(deps.settingsService.patch).toHaveBeenCalledWith(patch);
  });
});
