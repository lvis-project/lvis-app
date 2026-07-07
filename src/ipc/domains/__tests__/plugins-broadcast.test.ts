import { describe, it, expect, vi, beforeEach } from "vitest";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const electronMocks = vi.hoisted(() => ({
  showOpenDialog: vi.fn(),
}));
type InstallProgressHandler = (event: { phase: string }) => void;

function emitRegisteringProgress(args: unknown[]): void {
  const onProgress = args.find((arg): arg is InstallProgressHandler => typeof arg === "function");
  if (!onProgress) {
    throw new TypeError("install mock expected progress handler");
  }
  onProgress({ phase: "registering" });
}

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
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
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
      list: vi.fn(async () => [
        { id: "agent-hub", slug: "lvis-plugin-agent-hub" },
        { id: "meeting", slug: "lvis-plugin-meeting" },
      ]),
      getLiveCatalogVersion: vi.fn(async () => "1.0.0"),
      getInstalledVersion: vi.fn(async () => "1.0.0"),
      install: vi.fn(async (...args: unknown[]) => {
        emitRegisteringProgress(args);
        return { pluginId: "agent-hub", installed: true };
      }),
      uninstall: vi.fn(async (pluginId: string) => ({ pluginId, uninstalled: true })),
      getInstallFailureDiagnostics: vi.fn(() => []),
      clearInstallFailureDiagnostic: vi.fn(() => true),
      rollbackPlugin: vi.fn(async (pluginId: string) => ({ pluginId, rolledBackTo: "0.0.1" })),
      rollbackLocalInstall: vi.fn(async (pluginId: string) => ({ pluginId, rolledBack: true })),
      clearLocalInstallRollback: vi.fn(async () => undefined),
      resolveLocalInstallPluginId: vi.fn(async () => "local-plugin"),
      installLocal: vi.fn(async () => ({ pluginId: "local-plugin", installed: true })),
    },
    pluginRuntime: {
      addPlugin: vi.fn(async (): Promise<"started" | "preparing" | undefined> => undefined),
      waitForPluginReady: vi.fn(async () => undefined),
      removePlugin: vi.fn(async () => undefined),
      listPluginIds: vi.fn((): string[] => []),
      mergeConfigOverride: vi.fn(),
      setConfigOverride: vi.fn(),
      getPluginManifest: vi.fn(() => ({
        configSchema: {
          properties: {
            apiKey: { type: "string", format: "secret" },
            sttApiKey: { type: "string", format: "secret" },
          },
        },
      })),
    },
    settingsService: {
      get: vi.fn(() => ({ backend: "real-cloud", cloudBaseUrl: "https://marketplace.example" })),
      deletePluginConfig: vi.fn(async () => undefined),
      deletePluginSecrets: vi.fn(async () => 0),
      setSecret: vi.fn(async () => undefined),
      getSecret: vi.fn(() => null),
      getPluginConfig: vi.fn(() => ({})),
      setPluginConfig: vi.fn(async () => undefined),
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

  it("uses the requested marketplace slug for every install lifecycle event when it resolves to a different plugin id", async () => {
    const { deps, appWindows } = await setup();
    deps.pluginMarketplace.install.mockImplementationOnce(async (...args: unknown[]) => {
      emitRegisteringProgress(args);
      return { pluginId: "meeting", installed: true };
    });

    await invoke("lvis:plugins:install", "lvis-plugin-meeting");

    expect(deps.pluginRuntime.addPlugin).toHaveBeenCalledWith("meeting");
    for (const win of appWindows) {
      expect(win.webContents.send).toHaveBeenCalledWith(
        "lvis:plugins:install-progress",
        { slug: "lvis-plugin-meeting", phase: "installing" },
      );
      expect(win.webContents.send).toHaveBeenCalledWith(
        "lvis:plugins:install-progress",
        { slug: "lvis-plugin-meeting", phase: "registering" },
      );
      expect(win.webContents.send).toHaveBeenCalledWith(
        "lvis:plugins:install-progress",
        { slug: "lvis-plugin-meeting", phase: "restarting" },
      );
      expect(win.webContents.send).toHaveBeenCalledWith(
        "lvis:plugins:install-result",
        { slug: "lvis-plugin-meeting", success: true },
      );
      expect(win.webContents.send).not.toHaveBeenCalledWith(
        "lvis:plugins:install-progress",
        expect.objectContaining({ slug: "meeting" }),
      );
      expect(win.webContents.send).not.toHaveBeenCalledWith(
        "lvis:plugins:install-result",
        expect.objectContaining({ slug: "meeting" }),
      );
    }
  });

  it("uses the canonical plugin id for pre-stop and rollback when an alias update is already loaded", async () => {
    const { deps, appWindows } = await setup();
    deps.pluginRuntime.listPluginIds.mockReturnValue(["meeting"]);
    deps.pluginMarketplace.install.mockImplementationOnce(async (...args: unknown[]) => {
      emitRegisteringProgress(args);
      return { pluginId: "meeting", installed: true };
    });
    deps.pluginRuntime.addPlugin.mockRejectedValueOnce(new Error("restart failed"));

    await expect(invoke("lvis:plugins:install", "lvis-plugin-meeting")).rejects.toThrow("restart failed");

    expect(deps.pluginRuntime.removePlugin).toHaveBeenCalledWith("meeting");
    expect(deps.pluginMarketplace.rollbackPlugin).toHaveBeenCalledWith("meeting");
    expect(deps.pluginMarketplace.uninstall).not.toHaveBeenCalledWith("meeting");
    for (const win of appWindows) {
      expect(win.webContents.send).toHaveBeenCalledWith(
        "lvis:plugins:install-progress",
        { slug: "lvis-plugin-meeting", phase: "restarting" },
      );
      expect(win.webContents.send).toHaveBeenCalledWith(
        "lvis:plugins:install-result",
        { slug: "lvis-plugin-meeting", success: false, error: "restart failed" },
      );
    }
  });

  it("broadcasts marketplace install failure with the requested slug when install throws before a canonical plugin id exists", async () => {
    const { deps, appWindows } = await setup();
    deps.pluginMarketplace.install.mockRejectedValueOnce(new Error("download failed"));

    await expect(invoke("lvis:plugins:install", "lvis-plugin-meeting")).rejects.toThrow("download failed");

    expect(deps.pluginRuntime.addPlugin).not.toHaveBeenCalled();
    for (const win of appWindows) {
      expect(win.webContents.send).toHaveBeenCalledWith(
        "lvis:plugins:install-progress",
        { slug: "lvis-plugin-meeting", phase: "installing" },
      );
      expect(win.webContents.send).toHaveBeenCalledWith(
        "lvis:plugins:install-result",
        { slug: "lvis-plugin-meeting", success: false, error: "download failed" },
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

  it("delays marketplace install success until async dependency preparation finishes", async () => {
    const { deps, appWindows } = await setup();
    let resolveReady!: () => void;
    const readyPromise = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    deps.pluginRuntime.addPlugin.mockResolvedValueOnce("preparing");
    deps.pluginRuntime.waitForPluginReady.mockReturnValueOnce(readyPromise);

    const installPromise = invoke("lvis:plugins:install", "agent-hub");
    await new Promise((resolve) => setTimeout(resolve, 0));

    for (const win of appWindows) {
      expect(win.webContents.send).toHaveBeenCalledWith(
        "lvis:plugins:install-progress",
        { slug: "agent-hub", phase: "preparing" },
      );
      expect(win.webContents.send).not.toHaveBeenCalledWith(
        "lvis:plugins:install-result",
        { slug: "agent-hub", success: true },
      );
    }

    resolveReady();
    await expect(installPromise).resolves.toMatchObject({
      pluginId: "agent-hub",
      installed: true,
    });

    for (const win of appWindows) {
      expect(win.webContents.send).toHaveBeenCalledWith(
        "lvis:plugins:install-result",
        { slug: "agent-hub", success: true },
      );
    }
  });

  it("rolls back marketplace install when async dependency preparation fails", async () => {
    const { deps, appWindows } = await setup();
    deps.pluginRuntime.addPlugin.mockResolvedValueOnce("preparing");
    deps.pluginRuntime.waitForPluginReady.mockRejectedValueOnce(new Error("prepare failed"));

    await expect(invoke("lvis:plugins:install", "agent-hub")).rejects.toThrow("prepare failed");

    expect(deps.pluginMarketplace.uninstall).toHaveBeenCalledWith("agent-hub");
    for (const win of appWindows) {
      expect(win.webContents.send).toHaveBeenCalledWith(
        "lvis:plugins:install-result",
        { slug: "agent-hub", success: false, error: "prepare failed" },
      );
    }
  });

  it("stops the loaded plugin before marketplace update and rolls back when restart fails", async () => {
    const { deps, appWindows } = await setup();
    deps.pluginRuntime.listPluginIds.mockReturnValue(["agent-hub"]);
    deps.pluginRuntime.addPlugin.mockRejectedValueOnce(new Error("prepare failed"));

    await expect(invoke("lvis:plugins:install", "agent-hub")).rejects.toThrow("prepare failed");

    expect(deps.pluginMarketplace.rollbackPlugin).toHaveBeenCalledWith("agent-hub");
    expect(deps.pluginRuntime.removePlugin).toHaveBeenCalledWith("agent-hub");
    expect(deps.pluginRuntime.removePlugin.mock.invocationCallOrder[0]).toBeLessThan(
      deps.pluginMarketplace.install.mock.invocationCallOrder[0],
    );
    expect(deps.pluginMarketplace.uninstall).not.toHaveBeenCalledWith("agent-hub");
    for (const win of appWindows) {
      expect(win.webContents.send).toHaveBeenCalledWith(
        "lvis:plugins:install-result",
        { slug: "agent-hub", success: false, error: "prepare failed" },
      );
    }
  });

  it("rejects endpoint URLs saved into API-key secret fields", async () => {
    const { deps } = await setup();

    const result = await invoke(
      "lvis:plugins:config:secret:set",
      "meeting",
      "sttApiKey",
      "https://example.openai.azure.com/openai/deployments/gpt-4o-transcribe/audio/transcriptions",
    );

    expect(result).toMatchObject({
      ok: false,
      error: "plugin-config-secret-invalid-value",
    });
    expect(deps.settingsService.setSecret).not.toHaveBeenCalled();
  });

  it("does not report endpoint URLs saved in API-key-like secret fields as present", async () => {
    const { deps } = await setup();
    deps.settingsService.getSecret.mockImplementation((key: string) => {
      if (key.endsWith(".apiKey")) return "sk-valid";
      if (key.endsWith(".sttApiKey")) return "https://example.openai.azure.com/openai/deployments/stt/audio/transcriptions";
      return null;
    });

    const result = await invoke("lvis:plugins:config:secret:list-keys", "meeting");

    expect(result).toEqual({ ok: true, keys: ["apiKey"] });
  });
  it("broadcasts uninstall result to every app window", async () => {
    const { deps, appWindows } = await setup();

    await invoke("lvis:plugins:uninstall", "agent-hub");

    expect(deps.pluginMarketplace.uninstall).toHaveBeenCalledWith("agent-hub");
    expect(deps.pluginRuntime.removePlugin).toHaveBeenCalledWith("agent-hub");
    expect(deps.settingsService.deletePluginConfig).toHaveBeenCalledWith("agent-hub");
    expect(deps.settingsService.deletePluginSecrets).toHaveBeenCalledWith("agent-hub", new Set(["apiKey", "sttApiKey"]));
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

  it("cleans up catalog grant mismatch diagnostics without bypassing general admin uninstall policy", async () => {
    const { deps, appWindows } = await setup();
    deps.pluginMarketplace.getInstalledVersion.mockResolvedValueOnce(null);
    deps.pluginMarketplace.getInstallFailureDiagnostics.mockReturnValueOnce([
      {
        id: "meeting",
        name: "LVIS Meeting",
        description: "Meeting plugin",
        error:
          'plugin "meeting" artifact manifest external-auth-consumer capability does not match the catalog-approved grant',
        installFailureKind: "catalog-grant-mismatch",
        isManaged: true,
        installPolicy: "admin",
        installAliases: ["lvis-plugin-meeting"],
      },
    ]);
    deps.listPluginAuthPartitionsService.mockReturnValueOnce([
      "persist:plugin-auth:meeting",
      "persist:plugin-auth:meeting:tenant",
    ]);

    await expect(invoke("lvis:plugins:uninstall", "meeting", {
      doctorCleanup: { installFailureKind: "catalog-grant-mismatch" },
    })).resolves.toEqual({
      pluginId: "meeting",
      uninstalled: true,
    });

    expect(deps.pluginRuntime.removePlugin).toHaveBeenCalledWith("meeting");
    expect(deps.pluginMarketplace.uninstall).not.toHaveBeenCalledWith("meeting");
    expect(deps.pluginMarketplace.clearInstallFailureDiagnostic).toHaveBeenCalledWith("meeting");
    expect(deps.settingsService.deletePluginConfig).toHaveBeenCalledWith("meeting");
    expect(deps.settingsService.deletePluginSecrets).toHaveBeenCalledWith("meeting", new Set(["apiKey", "sttApiKey"]));
    expect(deps.clearAuthPartitionService).toHaveBeenCalledWith("persist:plugin-auth:meeting");
    expect(deps.clearAuthPartitionService).toHaveBeenCalledWith("persist:plugin-auth:meeting:tenant");
    expect(deps.forgetPluginAuthPartitionsService).toHaveBeenCalledWith("meeting");
    for (const win of appWindows) {
      expect(win.webContents.send).toHaveBeenCalledWith(
        "lvis:plugins:uninstall-result",
        { slug: "meeting", success: true },
      );
    }
  });

  it("cleans up manifest validation diagnostics without bypassing general admin uninstall policy", async () => {
    const { deps, appWindows } = await setup();
    deps.pluginMarketplace.getInstalledVersion.mockResolvedValueOnce(null);
    deps.pluginMarketplace.getInstallFailureDiagnostics.mockReturnValueOnce([
      {
        id: "meeting",
        name: "LVIS Meeting",
        description: "Meeting plugin",
        error: "[manifest:meeting] schema validation failed (/tmp/plugin.json): / unknown property: 'startupTools'",
        installFailureKind: "manifest-validation-error",
        isManaged: true,
        installPolicy: "admin",
        installAliases: ["lvis-plugin-meeting"],
      },
    ]);

    await expect(invoke("lvis:plugins:uninstall", "meeting", {
      doctorCleanup: { installFailureKind: "manifest-validation-error" },
    })).resolves.toEqual({
      pluginId: "meeting",
      uninstalled: true,
    });

    expect(deps.pluginRuntime.removePlugin).toHaveBeenCalledWith("meeting");
    expect(deps.pluginMarketplace.uninstall).not.toHaveBeenCalledWith("meeting");
    expect(deps.pluginMarketplace.clearInstallFailureDiagnostic).toHaveBeenCalledWith("meeting");
    for (const win of appWindows) {
      expect(win.webContents.send).toHaveBeenCalledWith(
        "lvis:plugins:uninstall-result",
        { slug: "meeting", success: true },
      );
    }
  });

  it("does not Doctor-cleanup an installed managed plugin update diagnostic", async () => {
    const { deps, appWindows } = await setup();
    deps.pluginMarketplace.getInstalledVersion.mockResolvedValueOnce("1.0.0");
    deps.pluginMarketplace.getInstallFailureDiagnostics.mockReturnValueOnce([
      {
        id: "meeting",
        name: "LVIS Meeting",
        description: "Meeting plugin",
        error: "[manifest:meeting] schema validation failed (/tmp/plugin.json): / unknown property: 'startupTools'",
        installFailureKind: "manifest-validation-error",
        isManaged: true,
        installPolicy: "admin",
        installAliases: ["lvis-plugin-meeting"],
      },
    ]);
    deps.pluginMarketplace.uninstall.mockRejectedValueOnce(
      new Error("Managed plugin cannot be uninstalled by user: meeting"),
    );

    await expect(invoke("lvis:plugins:uninstall", "meeting", {
      doctorCleanup: { installFailureKind: "manifest-validation-error" },
    })).rejects.toThrow("Managed plugin cannot be uninstalled by user: meeting");

    expect(deps.pluginMarketplace.uninstall).toHaveBeenCalledWith("meeting");
    expect(deps.pluginMarketplace.clearInstallFailureDiagnostic).not.toHaveBeenCalled();
    for (const win of appWindows) {
      expect(win.webContents.send).toHaveBeenCalledWith(
        "lvis:plugins:uninstall-result",
        { slug: "meeting", success: false, error: "Managed plugin cannot be uninstalled by user: meeting" },
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

  it("rolls back local reinstall on disk when loaded plugin activation fails", async () => {
    const { deps, appWindows } = await setup();
    electronMocks.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ["/tmp/local-plugin"],
    });
    deps.pluginRuntime.listPluginIds.mockReturnValueOnce(["local-plugin"]);
    deps.pluginRuntime.addPlugin.mockRejectedValueOnce(new Error("local runtime failed"));

    await expect(invoke("lvis:plugins:install-local")).rejects.toThrow("local runtime failed");

    expect(deps.pluginMarketplace.rollbackLocalInstall).toHaveBeenCalledWith("local-plugin");
    expect(deps.pluginMarketplace.uninstall).not.toHaveBeenCalledWith("local-plugin");
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
        list: vi.fn(async () => [
          { id: "agent-hub", slug: "lvis-plugin-agent-hub" },
        ]),
        getLiveCatalogVersion: vi.fn(async () => "1.0.0"),
        getInstalledVersion: vi.fn(async () => "1.0.0"),
        install: vi.fn(async (...args: unknown[]) => {
          emitRegisteringProgress(args);
          return { pluginId: "agent-hub", installed: true };
        }),
        uninstall: vi.fn(async (pluginId: string) => ({ pluginId, uninstalled: true })),
        rollbackPlugin: vi.fn(async (pluginId: string) => ({ pluginId, rolledBackTo: "0.0.1" })),
        rollbackLocalInstall: vi.fn(async (pluginId: string) => ({ pluginId, rolledBack: true })),
        clearLocalInstallRollback: vi.fn(async () => undefined),
        resolveLocalInstallPluginId: vi.fn(async () => "local-plugin"),
        installLocal: vi.fn(async () => ({ pluginId: "local-plugin", installed: true })),
      },
      pluginRuntime: {
        addPlugin: vi.fn(async (): Promise<"started" | "preparing" | undefined> => undefined),
        waitForPluginReady: vi.fn(async () => undefined),
        removePlugin: vi.fn(async () => undefined),
        listPluginIds: vi.fn((): string[] => []),
        mergeConfigOverride: vi.fn(),
      setConfigOverride: vi.fn(),
      },
      settingsService: {
        get: vi.fn(() => ({ backend: "real-cloud", cloudBaseUrl: "https://marketplace.example" })),
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

  it("forwards in-app notification detail clicks back to the renderer", async () => {
    const { appWindows } = await setup();
    const handler = handlers.get("lvis:notification:clicked");
    expect(handler).toBeDefined();

    await Promise.resolve(handler!(
      { senderFrame: { url: "file:///tmp/lvis/index.html" } },
      {
        kind: "ask-user",
        contextRef: {
          questionId: "q-1",
          ignored: "not-forwarded",
        },
      },
    ));

    expect(appWindows[0].show).toHaveBeenCalled();
    expect(appWindows[0].focus).toHaveBeenCalled();
    expect(appWindows[0].webContents.send).toHaveBeenCalledWith(
      "lvis:notification:clicked",
      { kind: "ask-user", contextRef: { questionId: "q-1" } },
    );
  });

  it("rejects notification detail clicks from plugin UI frames", async () => {
    const { appWindows } = await setup();
    const handler = handlers.get("lvis:notification:clicked");
    expect(handler).toBeDefined();

    const result = await Promise.resolve(handler!(
      { senderFrame: { url: "file:///tmp/lvis/plugin-ui-shell.html" } },
      { kind: "ask-user", contextRef: { questionId: "q-1" } },
    ));

    expect(result).toEqual({ ok: false, error: "unauthorized-frame" });
    expect(appWindows[0].show).not.toHaveBeenCalled();
    expect(appWindows[0].focus).not.toHaveBeenCalled();
    expect(appWindows[0].webContents.send).not.toHaveBeenCalledWith(
      "lvis:notification:clicked",
      expect.anything(),
    );
  });
});
