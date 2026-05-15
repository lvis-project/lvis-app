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
      getPluginManifest: vi.fn(() => ({
        configSchema: {
          properties: {
            apiKey: { type: "string", format: "secret" },
          },
        },
      })),
    },
    settingsService: {
      get: vi.fn(() => ({ backend: "real-cloud", realCloudBaseUrl: "https://marketplace.example" })),
      deletePluginConfig: vi.fn(async () => undefined),
      deletePluginSecrets: vi.fn(async () => 0),
    },
    auditLogger: {
      log: vi.fn(),
    },
    refreshPluginNotifications: vi.fn(),
    clearAuthPartitionService: vi.fn(async () => undefined),
    listPluginAuthPartitionsService: vi.fn(() => [
      "persist:plugin-auth:agent-hub",
      "persist:plugin-auth:agent-hub:tenant",
    ]),
    forgetPluginAuthPartitionsService: vi.fn(),
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
    expect(deps.settingsService.deletePluginConfig).toHaveBeenCalledWith("agent-hub");
    expect(deps.settingsService.deletePluginSecrets).toHaveBeenCalledWith("agent-hub", new Set(["apiKey"]));
    expect(deps.clearAuthPartitionService).toHaveBeenCalledWith("persist:plugin-auth:agent-hub");
    expect(deps.clearAuthPartitionService).toHaveBeenCalledWith("persist:plugin-auth:agent-hub:tenant");
    expect(deps.forgetPluginAuthPartitionsService).toHaveBeenCalledWith("agent-hub");
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
    // Production removePlugin (runtime/index.ts) currently swallows stop()
    // and disposer errors via try/catch + log.error and never re-throws.
    // This test guards a future tightening where removePlugin DOES throw
    // (e.g. invariant violation, runtime map corruption): the IPC handler
    // MUST surface that failure and NOT proceed to marketplace.uninstall —
    // otherwise registry mutation happens while runtime tracking still
    // references the plugin, leaving listPluginCards showing a ghost card.
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

  it("surfaces marketplace.uninstall non-idempotent failure (EACCES) after removePlugin succeeds", async () => {
    // After removePlugin already torn down runtime tracking, if marketplace
    // rm fails with a non-idempotent error (permission denied, IO error),
    // the user sees an explicit failure broadcast rather than silent ghost
    // state. removePlugin still ran — this is the expected partial-success
    // outcome, surfaced honestly.
    const { deps, appWindows } = await setup();
    deps.pluginMarketplace.uninstall.mockRejectedValueOnce(new Error("EACCES: permission denied"));

    await expect(invoke("lvis:plugins:uninstall", "agent-hub")).rejects.toThrow("EACCES");

    expect(deps.pluginRuntime.removePlugin).toHaveBeenCalledWith("agent-hub");
    for (const win of appWindows) {
      expect(win.webContents.send).toHaveBeenCalledWith(
        "lvis:plugins:uninstall-result",
        { slug: "agent-hub", success: false, error: "EACCES: permission denied" },
      );
    }
  });

  it("install rollback runs removePlugin BEFORE marketplace.uninstall", async () => {
    // Architect M1 regression guard: failed addPlugin may have partially
    // started the plugin (DB open, worker spawned). Rollback must follow
    // the same lifecycle order as user-driven uninstall — runtime cleanup
    // first, then marketplace rm — to avoid the same Windows EBUSY class.
    const { deps } = await setup();
    deps.pluginRuntime.addPlugin.mockRejectedValueOnce(new Error("start exception"));

    await expect(invoke("lvis:plugins:install", "agent-hub")).rejects.toThrow("start exception");

    const removePluginOrder = deps.pluginRuntime.removePlugin.mock.invocationCallOrder[0];
    const uninstallOrder = deps.pluginMarketplace.uninstall.mock.invocationCallOrder[0];
    expect(removePluginOrder).toBeDefined();
    expect(uninstallOrder).toBeDefined();
    expect(removePluginOrder).toBeLessThan(uninstallOrder);
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
