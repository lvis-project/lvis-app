import { describe, it, expect, vi, beforeEach } from "vitest";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const electronMocks = vi.hoisted(() => ({
  showOpenDialog: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => ""),
  },
  dialog: {
    showOpenDialog: electronMocks.showOpenDialog,
  },
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
  webContents: {
    fromId: vi.fn(),
  },
}));

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`No handler registered for: ${channel}`);
  return Promise.resolve(fn(null, ...args));
}

function makeWindow(options: { destroyed?: boolean } = {}) {
  return {
    isDestroyed: vi.fn(() => options.destroyed ?? false),
    webContents: {
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
    },
  };
}

async function setup() {
  handlers.clear();
  vi.clearAllMocks();
  process.env.LVIS_DEV = "1";
  const devFlags = await import("../../../boot/dev-flags.js");
  devFlags.setIsPackaged(false);
  const appWindows = [makeWindow(), makeWindow()];
  const deps = {
    pluginMarketplace: {
      install: vi.fn(async (_pluginId: string, _scope: string, onProgress: (event: { phase: string }) => void) => {
        onProgress({ phase: "registering" });
        return { pluginId: "agent-hub", installed: true };
      }),
      uninstall: vi.fn(async (pluginId: string) => ({ pluginId, uninstalled: true })),
      installLocal: vi.fn(async () => ({ pluginId: "local-plugin", installed: true })),
    },
    pluginRuntime: {
      addPlugin: vi.fn(async () => undefined),
      removePlugin: vi.fn(async () => undefined),
      mergeConfigOverride: vi.fn(),
    },
    settingsService: {
      get: vi.fn(() => ({ backend: "real-cloud", realCloudBaseUrl: "https://marketplace.example" })),
    },
    auditLogger: {
      log: vi.fn(),
    },
    refreshPluginNotifications: vi.fn(),
    getMainWindow: vi.fn(() => appWindows[0]),
    getAppWindows: vi.fn(() => appWindows),
  };
  const { registerPluginsHandlers } = await import("../plugins.js");
  registerPluginsHandlers(deps as never);
  return { deps, appWindows };
}

beforeEach(() => {
  handlers.clear();
  delete process.env.LVIS_DEV;
  electronMocks.showOpenDialog.mockReset();
});

describe("plugins IPC lifecycle broadcast", () => {
  it("broadcasts marketplace install progress and result to every app window", async () => {
    const { appWindows } = await setup();

    await invoke("lvis:plugins:install", "agent-hub");

    for (const win of appWindows) {
      expect(win.webContents.send).toHaveBeenCalledWith(
        "lvis:plugins:install-progress",
        { slug: "agent-hub", phase: "installing" },
      );
      expect(win.webContents.send).toHaveBeenCalledWith(
        "lvis:plugins:install-progress",
        { slug: "agent-hub", phase: "registering" },
      );
      expect(win.webContents.send).toHaveBeenCalledWith(
        "lvis:plugins:install-progress",
        { slug: "agent-hub", phase: "restarting" },
      );
      expect(win.webContents.send).toHaveBeenCalledWith(
        "lvis:plugins:install-result",
        { slug: "agent-hub", success: true },
      );
    }
  });

  it("broadcasts marketplace install failure when runtime add rolls back", async () => {
    const { deps, appWindows } = await setup();
    deps.pluginRuntime.addPlugin.mockRejectedValueOnce(new Error("runtime failed"));

    await expect(invoke("lvis:plugins:install", "agent-hub")).rejects.toThrow("runtime failed");

    expect(deps.pluginMarketplace.uninstall).toHaveBeenCalledWith("agent-hub");
    for (const win of appWindows) {
      expect(win.webContents.send).toHaveBeenCalledWith(
        "lvis:plugins:install-result",
        { slug: "agent-hub", success: false, error: "runtime failed" },
      );
    }
  });

  it("broadcasts uninstall result to every app window", async () => {
    const { deps, appWindows } = await setup();

    await invoke("lvis:plugins:uninstall", "agent-hub");

    expect(deps.pluginMarketplace.uninstall).toHaveBeenCalledWith("agent-hub");
    expect(deps.pluginRuntime.removePlugin).toHaveBeenCalledWith("agent-hub");
    for (const win of appWindows) {
      expect(win.webContents.send).toHaveBeenCalledWith(
        "lvis:plugins:uninstall-result",
        { slug: "agent-hub", success: true },
      );
    }
  });

  it("removes plugin runtime BEFORE marketplace.uninstall (lifecycle §9 ordering)", async () => {
    // Regression guard for Windows EBUSY on fts5.sqlite-shm/-wal: marketplace
    // uninstall (rm files) must NOT run before runtime stop (close DB
    // handles). If the order regresses, the plugin's worker still holds
    // open SQLite WAL files when rm fires → EBUSY → half-deleted dir.
    const { deps } = await setup();

    await invoke("lvis:plugins:uninstall", "agent-hub");

    const removePluginOrder = deps.pluginRuntime.removePlugin.mock.invocationCallOrder[0];
    const uninstallOrder = deps.pluginMarketplace.uninstall.mock.invocationCallOrder[0];
    expect(removePluginOrder).toBeLessThan(uninstallOrder);
  });

  it("surfaces removePlugin failure as uninstall failure (does not silently mutate registry)", async () => {
    // If removePlugin throws (e.g. dispose chain failure), marketplace
    // uninstall MUST NOT proceed — otherwise registry mutation happens
    // while runtime tracking still references the plugin, leaving
    // listPluginCards showing a ghost card.
    const { deps, appWindows } = await setup();
    deps.pluginRuntime.removePlugin.mockRejectedValueOnce(new Error("dispose chain failed"));

    await expect(invoke("lvis:plugins:uninstall", "agent-hub")).rejects.toThrow("dispose chain failed");

    expect(deps.pluginMarketplace.uninstall).not.toHaveBeenCalled();
    for (const win of appWindows) {
      expect(win.webContents.send).toHaveBeenCalledWith(
        "lvis:plugins:uninstall-result",
        { slug: "agent-hub", success: false, error: "dispose chain failed" },
      );
    }
  });

  it("broadcasts idempotent uninstall success when marketplace entry is already gone", async () => {
    const { deps, appWindows } = await setup();
    deps.pluginMarketplace.uninstall.mockRejectedValueOnce(new Error("Plugin not installed: agent-hub"));

    await expect(invoke("lvis:plugins:uninstall", "agent-hub")).resolves.toEqual({
      pluginId: "agent-hub",
      uninstalled: true,
    });

    expect(deps.pluginRuntime.removePlugin).toHaveBeenCalledWith("agent-hub");
    for (const win of appWindows) {
      expect(win.webContents.send).toHaveBeenCalledWith(
        "lvis:plugins:uninstall-result",
        { slug: "agent-hub", success: true },
      );
    }
  });

  it("broadcasts local install success to every app window", async () => {
    const { deps, appWindows } = await setup();
    electronMocks.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ["/tmp/local-plugin"],
    });

    await invoke("lvis:plugins:install-local");

    expect(deps.pluginMarketplace.installLocal).toHaveBeenCalledWith("/tmp/local-plugin");
    expect(deps.pluginRuntime.addPlugin).toHaveBeenCalledWith("local-plugin");
    for (const win of appWindows) {
      expect(win.webContents.send).toHaveBeenCalledWith(
        "lvis:plugins:install-result",
        { slug: "local-plugin", success: true },
      );
    }
  });

  it("broadcasts local install failure after rollback when runtime add fails", async () => {
    const { deps, appWindows } = await setup();
    electronMocks.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ["/tmp/local-plugin"],
    });
    deps.pluginRuntime.addPlugin.mockRejectedValueOnce(new Error("local runtime failed"));

    await expect(invoke("lvis:plugins:install-local")).rejects.toThrow("local runtime failed");

    expect(deps.pluginMarketplace.uninstall).toHaveBeenCalledWith("local-plugin");
    for (const win of appWindows) {
      expect(win.webContents.send).toHaveBeenCalledWith(
        "lvis:plugins:install-result",
        { slug: "local-plugin", success: false, error: "local runtime failed" },
      );
    }
  });

  it("skips destroyed app windows during lifecycle broadcast", async () => {
    handlers.clear();
    vi.clearAllMocks();
    process.env.LVIS_DEV = "1";
    const devFlags = await import("../../../boot/dev-flags.js");
    devFlags.setIsPackaged(false);
    const liveWindow = makeWindow();
    const destroyedWindow = makeWindow({ destroyed: true });
    const deps = {
      pluginMarketplace: {
        install: vi.fn(async (_pluginId: string, _scope: string, onProgress: (event: { phase: string }) => void) => {
          onProgress({ phase: "registering" });
          return { pluginId: "agent-hub", installed: true };
        }),
        uninstall: vi.fn(async (pluginId: string) => ({ pluginId, uninstalled: true })),
        installLocal: vi.fn(async () => ({ pluginId: "local-plugin", installed: true })),
      },
      pluginRuntime: {
        addPlugin: vi.fn(async () => undefined),
        removePlugin: vi.fn(async () => undefined),
        mergeConfigOverride: vi.fn(),
      },
      settingsService: {
        get: vi.fn(() => ({ backend: "real-cloud", realCloudBaseUrl: "https://marketplace.example" })),
      },
      auditLogger: {
        log: vi.fn(),
      },
      refreshPluginNotifications: vi.fn(),
      getMainWindow: vi.fn(() => liveWindow),
      getAppWindows: vi.fn(() => [liveWindow, destroyedWindow]),
    };
    const { registerPluginsHandlers } = await import("../plugins.js");
    registerPluginsHandlers(deps as never);

    await invoke("lvis:plugins:install", "agent-hub");

    expect(liveWindow.webContents.send).toHaveBeenCalledWith(
      "lvis:plugins:install-result",
      { slug: "agent-hub", success: true },
    );
    expect(destroyedWindow.webContents.send).not.toHaveBeenCalled();
  });
});
