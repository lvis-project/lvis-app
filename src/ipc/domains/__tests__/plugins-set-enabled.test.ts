/**
 * #1176 — `lvis:plugins:set-enabled` IPC handler tests.
 *
 * Verifies:
 *   - atomic persist via PluginRuntime.setPluginEnabled
 *   - `plugin.enabled-changed` host event + `lvis:plugins:enabled-changed`
 *     window broadcast on success
 *   - kebab-case English error for an unknown plugin id
 *   - validateSender rejection for a disallowed frame
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeAppIpcInvoker } from "./test-helpers.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const hostEventMock = vi.hoisted(() => ({ emit: vi.fn() }));

vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: vi.fn(() => "") },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
  webContents: { fromId: vi.fn() },
}));

// Spy on the host event bus so we can assert plugin.enabled-changed emits.
vi.mock("../../../boot/types.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../boot/types.js")>();
  return { ...actual, emitEvent: hostEventMock.emit };
});

// Shared app-IPC invoker (injects a trusted `lvis://app` frame so
// validateSender passes). The rejection test below calls the handler directly
// with a hostile frame instead.
const invoke = makeAppIpcInvoker(handlers);

function makeWindow() {
  return {
    isDestroyed: vi.fn(() => false),
    webContents: { isDestroyed: vi.fn(() => false), send: vi.fn() },
  };
}

async function setup() {
  handlers.clear();
  vi.clearAllMocks();
  const appWindows = [makeWindow(), makeWindow()];
  const setPluginEnabled = vi.fn(async (pluginId: string) => {
    if (pluginId === "ghost") throw new Error("Plugin not found: ghost");
  });
  const callFromUi = vi.fn(async () => ({ ok: true }));
  let pluginConfig: Record<string, unknown> = { removed: "old", kept: "old" };
  const setPluginConfig = vi.fn(async (_pluginId: string, config: Record<string, unknown>) => {
    pluginConfig = { ...config };
    return pluginConfig;
  });
  const restartPlugin = vi.fn(async () => "started" as const);
  const deps = {
    pluginMarketplace: { list: vi.fn(async () => []) },
    pluginRuntime: {
      listPluginIds: vi.fn((): string[] => ["com.example.meeting"]),
      setPluginEnabled,
      callFromUi,
      getPluginManifest: vi.fn(() => ({ id: "plugin-config" })),
      setConfigOverride: vi.fn(),
      restartPlugin,
    },
    settingsService: {
      get: vi.fn(() => ({})),
      getPluginConfig: vi.fn(() => ({ ...pluginConfig })),
      setPluginConfig,
    },
    auditLogger: { log: vi.fn() },
    refreshPluginNotifications: vi.fn(),
    getMainWindow: vi.fn(() => appWindows[0]),
    getAppWindows: vi.fn(() => appWindows),
  };
  const { registerPluginsHandlers } = await import("../plugins.js");
  registerPluginsHandlers(deps as never);
  return { deps, appWindows, setPluginEnabled, callFromUi, setPluginConfig, restartPlugin };
}

beforeEach(() => {
  handlers.clear();
});

describe("lvis:plugins:call", () => {
  it("rejects plugin UI shell frames from the host renderer call channel", async () => {
    const { deps, callFromUi } = await setup();
    const handler = handlers.get("lvis:plugins:call");
    expect(handler).toBeDefined();
    const pluginShellEvent = { senderFrame: { url: "file:///dist/src/plugin-ui-shell.html" } };

    const res = await handler!(pluginShellEvent, "sample_ui_action", undefined, {
      userAction: true,
    });

    expect(res).toEqual({ ok: false, error: "unauthorized-frame" });
    expect(callFromUi).not.toHaveBeenCalled();
    expect(deps.auditLogger.log).toHaveBeenCalled();
  });

  it("passes host renderer user action state to callFromUi", async () => {
    const { callFromUi } = await setup();

    const res = await invoke("lvis:plugins:call", "sample_ui_action", { id: 1 }, {
      userAction: true,
    });

    expect(res).toEqual({ ok: true });
    expect(callFromUi).toHaveBeenCalledWith("sample_ui_action", { id: 1 }, {
      userAction: true,
    });
  });
});

describe("lvis:plugins:set-enabled", () => {
  it("persists the toggle and emits both the host event and the window broadcast", async () => {
    const { setPluginEnabled, appWindows } = await setup();

    const res = await invoke("lvis:plugins:set-enabled", "com.example.meeting", false);

    expect(res).toEqual({ ok: true, pluginId: "com.example.meeting", enabled: false });
    expect(setPluginEnabled).toHaveBeenCalledWith("com.example.meeting", false);
    expect(hostEventMock.emit).toHaveBeenCalledWith("plugin.enabled-changed", {
      pluginId: "com.example.meeting",
      enabled: false,
    });
    for (const win of appWindows) {
      expect(win.webContents.send).toHaveBeenCalledWith("lvis:plugins:enabled-changed", {
        pluginId: "com.example.meeting",
        enabled: false,
      });
    }
  });

  it("re-enable round-trips through setPluginEnabled(true)", async () => {
    const { setPluginEnabled } = await setup();
    const res = await invoke("lvis:plugins:set-enabled", "com.example.meeting", true);
    expect(res).toMatchObject({ ok: true, enabled: true });
    expect(setPluginEnabled).toHaveBeenCalledWith("com.example.meeting", true);
  });

  it("returns a kebab-case error for an unknown plugin id", async () => {
    await setup();
    const res = await invoke("lvis:plugins:set-enabled", "ghost", false);
    expect(res).toMatchObject({ ok: false, error: "no-such-plugin" });
    expect(hostEventMock.emit).not.toHaveBeenCalled();
  });

  it("rejects a non-string pluginId with invalid-plugin-id", async () => {
    await setup();
    const res = await invoke("lvis:plugins:set-enabled", 42, false);
    expect(res).toMatchObject({ ok: false, error: "invalid-plugin-id" });
  });

  it("rejects a non-boolean enabled with invalid-enabled", async () => {
    await setup();
    const res = await invoke("lvis:plugins:set-enabled", "com.example.meeting", "nope");
    expect(res).toMatchObject({ ok: false, error: "invalid-enabled" });
  });

  it("rejects a disallowed sender frame (validateSender)", async () => {
    const { deps, setPluginEnabled } = await setup();
    // Call the handler directly with a hostile frame so validateSender denies it.
    const handler = handlers.get("lvis:plugins:set-enabled");
    expect(handler).toBeDefined();
    const hostileEvent = { senderFrame: { url: "https://evil.example/" } };
    const res = await handler!(hostileEvent, "com.example.meeting", false);
    expect(res).toEqual({ ok: false, error: "unauthorized-frame" });
    expect(setPluginEnabled).not.toHaveBeenCalled();
    expect(deps.auditLogger.log).toHaveBeenCalled();
  });

  it("rejects plugin UI shell file frames for this host-internal mutation", async () => {
    const { deps, setPluginEnabled } = await setup();
    const handler = handlers.get("lvis:plugins:set-enabled");
    expect(handler).toBeDefined();
    const pluginShellEvent = { senderFrame: { url: "file:///dist/src/plugin-ui-shell.html" } };
    const res = await handler!(pluginShellEvent, "com.example.meeting", false);
    expect(res).toEqual({ ok: false, error: "unauthorized-frame" });
    expect(setPluginEnabled).not.toHaveBeenCalled();
    expect(deps.auditLogger.log).toHaveBeenCalled();
  });

  it("maps runtime I/O failures to generic toggle-failed without broadcasting", async () => {
    const { setPluginEnabled, appWindows } = await setup();
    setPluginEnabled.mockRejectedValueOnce(new Error("EACCES: permission denied, open /Users/ken/.lvis/plugins/registry.json"));
    const res = await invoke("lvis:plugins:set-enabled", "com.example.meeting", false);
    expect(res).toEqual({
      ok: false,
      error: "toggle-failed",
      message: "plugin enabled state could not be changed",
    });
    expect(hostEventMock.emit).not.toHaveBeenCalled();
    for (const win of appWindows) {
      expect(win.webContents.send).not.toHaveBeenCalledWith("lvis:plugins:enabled-changed", expect.anything());
    }
  });
});

describe("lvis:plugins:config:set", () => {
  it("emits undefined for deleted keys captured before persistence", async () => {
    const { subscribePluginConfigChange } = await import("../../../plugins/config-change-bus.js");
    await setup();
    const observed: unknown[] = [];
    const unsubscribe = subscribePluginConfigChange(
      "plugin-config",
      "removed",
      (_key, value) => { observed.push(value); },
    );
    try {
      const result = await invoke("lvis:plugins:config:set", "plugin-config", { kept: "new" });
      expect(result).toEqual({ ok: true, config: { kept: "new" } });
      expect(observed).toEqual([undefined]);
    } finally {
      unsubscribe();
    }
  });

  it("waits for the shared plugin lifecycle lock before saving or restarting", async () => {
    const { withPluginInstallLock } = await import("../../../plugins/install-lifecycle.js");
    const { setPluginConfig, restartPlugin } = await setup();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const lockEntered = new Promise<void>((resolve) => { entered = resolve; });
    const held = withPluginInstallLock("plugin-config", async () => {
      entered();
      await gate;
    });
    await lockEntered;

    const configSet = invoke("lvis:plugins:config:set", "plugin-config", { kept: "new" });
    await Promise.resolve();
    expect(setPluginConfig).not.toHaveBeenCalled();
    expect(restartPlugin).not.toHaveBeenCalled();

    release();
    await held;
    await expect(configSet).resolves.toMatchObject({ ok: true });
    expect(setPluginConfig).toHaveBeenCalledOnce();
    expect(restartPlugin).toHaveBeenCalledOnce();
  });
});
