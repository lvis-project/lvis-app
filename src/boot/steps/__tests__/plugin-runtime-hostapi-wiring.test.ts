/**
 * C1 gap-lock — initPluginRuntime HostApi factory: config get/set + emitEvent
 * / onEvent capability wiring.
 *
 * The `plugin-runtime.test.ts` harness already exercises getSecret / callTool /
 * agentApproval on the captured `createHostApi`. This file locks the CURRENT
 * behavior of two other HostApi surfaces that were uncovered:
 *   • `config.get` merged-read precedence (manifest.config < wildcard < saved
 *     plugin config) and `config.set` round-trip (persist + override + reload;
 *     secret-format rejection).
 *   • `emitEvent` → `onEvent` round-trip on the shared host bus, with the
 *     caller's pluginId injected into the payload and unsubscribe honored.
 *
 * The captured-runtime-options pattern mirrors the sibling harness so the
 * initPluginRuntime call shape stays type-compatible.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";

const runtimeTestState = vi.hoisted(() => ({
  browserWindows: [] as Array<{ isDestroyed: () => boolean; webContents: { send: (channel: string, payload: unknown) => void } }>,
  capturedRuntimeOptions: null as Record<string, unknown> | null,
  readPluginRegistry: vi.fn(async () => ({ version: 1, plugins: [] })),
  runtime: {
    startAll: vi.fn(async () => {}),
    listToolNames: vi.fn(() => [] as string[]),
    listPluginIds: vi.fn(() => [] as string[]),
    listPluginManifests: vi.fn(() => [] as Array<{ pluginId: string; manifest: unknown }>),
    getPluginRoot: vi.fn((pluginId: string) => `/tmp/lvis-test/plugins/${pluginId}`),
    getPluginManifest: vi.fn(() => null),
    isPluginEnabled: vi.fn(() => true),
    getApprovedPluginAccess: vi.fn(() => undefined),
    registerDisposer: vi.fn(),
    assertPluginEventAccess: vi.fn(),
    assertPluginEventEmitAccess: vi.fn(),
    resolveToolOwner: vi.fn((toolName: string) => `${toolName}-owner`),
    setConfigOverride: vi.fn(),
    mergeConfigOverride: vi.fn(),
    setWildcardConfigOverride: vi.fn(),
    getWildcardConfigOverride: vi.fn(() => ({}) as Record<string, unknown>),
    restartPlugin: vi.fn(async () => "started"),
  },
}));

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => "/tmp/lvis-test"),
    isPackaged: false,
    prependOnceListener: vi.fn(),
  },
  BrowserWindow: Object.assign(vi.fn(), {
    getAllWindows: vi.fn(() => runtimeTestState.browserWindows),
    getFocusedWindow: vi.fn(() => null),
  }),
  shell: { openExternal: vi.fn() },
}));

vi.mock("../../../plugins/runtime.js", () => ({
  PluginRuntime: vi.fn().mockImplementation(function (this: unknown, options: Record<string, unknown>) {
    runtimeTestState.capturedRuntimeOptions = options;
    return runtimeTestState.runtime;
  }),
}));

vi.mock("../../../plugins/dev-watcher.js", () => ({
  startPluginDevWatcher: vi.fn(() => ({ stop: vi.fn() })),
}));

vi.mock("../../../main/html-preview-partition.js", () => ({
  installPluginPartitionPolicy: vi.fn(),
}));

vi.mock("../../../plugins/plugin-paths.js", () => ({
  resolvePluginPaths: vi.fn(() => ({
    pluginsRoot: "/tmp/lvis-test/plugins",
    registryPath: "/tmp/lvis-test/registry.json",
    cacheRoot: "/tmp/lvis-test/cache",
  })),
}));

vi.mock("../../../plugins/registry.js", () => ({
  readPluginRegistry: runtimeTestState.readPluginRegistry,
}));

import { initPluginRuntime } from "../plugin-runtime.js";
import { withPluginInstallLock } from "../../../plugins/install-lifecycle.js";

type ConfigHostApi = {
  config: {
    get: <T = unknown>(key: string) => T | undefined;
    set: <T = unknown>(key: string, value: T) => Promise<void>;
  };
  emitEvent: (type: string, data?: unknown) => void;
  onEvent: (type: string, handler: (data: unknown) => void) => () => void;
  getSecret: (key: string) => string | undefined | null;
};

type CreateHostApi = (
  pluginId: string,
  manifest: {
    id: string;
    config?: Record<string, unknown>;
    configSchema?: { properties?: Record<string, { type?: string; format?: string; default?: unknown }> };
    capabilities?: string[];
    emittedEvents?: string[];
  },
  pluginDataDir: string,
  incarnation?: {
    registerDisposer: (dispose: () => void) => void;
    isActive: () => boolean;
    isLifecycleHookActive: () => boolean;
  },
) => ConfigHostApi;

async function initAndGetFactory(settingsService: unknown): Promise<CreateHostApi> {
  runtimeTestState.capturedRuntimeOptions = null;
  await initPluginRuntime({
    projectRoot: "/tmp/lvis-test/project",
    settingsService: settingsService as never,
    memoryManager: {} as never,
    keywordEngine: { registerKeywords: vi.fn(), unregisterByPlugin: vi.fn() } as never,
    toolRegistry: {
      unregisterByPlugin: vi.fn(),
      register: vi.fn(),
      listAll: vi.fn(() => []),
      listPluginIds: vi.fn(() => []),
      replacePluginTools: vi.fn(),
    } as never,
    pythonPath: undefined,
    bootAuditLogger: { log: vi.fn() } as never,
    mainWindow: {} as never,
    networkFetch: vi.fn() as unknown as typeof fetch,
    openAuthWindowService: vi.fn(),
    openLinkWindowService: vi.fn(),
    openAuthPartitionViewerService: vi.fn(),
    clearAuthPartitionService: vi.fn(async () => {}),
    shellOpenExternal: vi.fn(),
    approvalGate: { requestAndWait: vi.fn() } as never,
    routinesStore: { list: () => [] } as never,
  });
  const createHostApi = (runtimeTestState.capturedRuntimeOptions as { createHostApi?: CreateHostApi } | null)?.createHostApi;
  expect(createHostApi).toBeDefined();
  return createHostApi!;
}

function makeSettingsService(store: Map<string, Record<string, unknown>>) {
  return {
    get: vi.fn((key: string) => {
      if (key === "llm") return { provider: "openai" };
      if (key === "pluginConfigs") return {};
      return undefined;
    }),
    getSecret: vi.fn(() => undefined),
    getPluginConfig: vi.fn((pluginId: string) => store.get(pluginId) ?? {}),
    setPluginConfig: vi.fn(async (pluginId: string, record: Record<string, unknown>) => {
      store.set(pluginId, record);
    }),
  };
}

function activeIncarnation() {
  return {
    registerDisposer: vi.fn(),
    isActive: () => true,
    isLifecycleHookActive: () => false,
  };
}

beforeEach(() => {
  runtimeTestState.readPluginRegistry.mockReset();
  runtimeTestState.readPluginRegistry.mockResolvedValue({ version: 1, plugins: [] });
  runtimeTestState.runtime.setConfigOverride.mockClear();
  runtimeTestState.runtime.restartPlugin.mockClear();
  runtimeTestState.runtime.getWildcardConfigOverride.mockReturnValue({});
  runtimeTestState.runtime.getPluginManifest.mockReturnValue(null);
});

describe("HostApi.config.get merged-read precedence", () => {
  it("layers manifest.config < wildcard override < saved plugin config", async () => {
    const store = new Map<string, Record<string, unknown>>([
      ["plugin-a", { p: "cfg", shared: "cfg" }],
    ]);
    runtimeTestState.runtime.getWildcardConfigOverride.mockReturnValue({ w: "wild", shared: "wild" });
    const createHostApi = await initAndGetFactory(makeSettingsService(store));
    const api = createHostApi(
      "plugin-a",
      { id: "plugin-a", config: { a: "m", shared: "m" } },
      mkdtempSync("/tmp/lvis-cfg-"),
      activeIncarnation(),
    );

    expect(api.config.get("a")).toBe("m");
    expect(api.config.get("w")).toBe("wild");
    expect(api.config.get("p")).toBe("cfg");
    // Saved plugin config wins over wildcard wins over manifest default.
    expect(api.config.get("shared")).toBe("cfg");
    expect(api.config.get("missing")).toBeUndefined();
  });

  it("applies configSchema defaults as the lowest layer (AB1); higher layers still win", async () => {
    const store = new Map<string, Record<string, unknown>>([
      ["plugin-a", { savedKey: "saved" }],
    ]);
    const createHostApi = await initAndGetFactory(makeSettingsService(store));
    const api = createHostApi(
      "plugin-a",
      {
        id: "plugin-a",
        config: {},
        configSchema: {
          properties: {
            schemaOnly: { type: "string", default: "def" },
            savedKey: { type: "string", default: "def" },
          },
        },
      },
      mkdtempSync("/tmp/lvis-cfg-def-"),
      activeIncarnation(),
    );

    // Unset schema-defaulted key now returns the author-declared default
    // (was `undefined` before AB1) — consistent with ctx.config.
    expect(api.config.get("schemaOnly")).toBe("def");
    // A saved value still wins over the schema default (precedence unchanged).
    expect(api.config.get("savedKey")).toBe("saved");
    // A key with neither a value nor a schema default is still undefined.
    expect(api.config.get("nothing")).toBeUndefined();
  });
});

describe("HostApi.config.set round-trip", () => {
  beforeEach(() => {
    runtimeTestState.runtime.getPluginManifest.mockImplementation((pluginId: string) => (
      pluginId === "plugin-a" ? activeManifest : null
    ));
  });

  let activeManifest: Parameters<CreateHostApi>[1];

  async function createActiveApi(settings: ReturnType<typeof makeSettingsService>) {
    const createHostApi = await initAndGetFactory(settings);
    activeManifest = { id: "plugin-a", config: {} };
    return createHostApi("plugin-a", activeManifest, mkdtempSync("/tmp/lvis-cfg-set-"));
  }

  it("persists via setPluginConfig, refreshes the override, restarts the plugin, and re-reads the value", async () => {
    const store = new Map<string, Record<string, unknown>>();
    const settings = makeSettingsService(store);
    const api = await createActiveApi(settings);

    await api.config.set("k", "v");

    expect(settings.setPluginConfig).toHaveBeenCalledWith("plugin-a", { k: "v" });
    expect(runtimeTestState.runtime.setConfigOverride).toHaveBeenCalledWith("plugin-a", { k: "v" });
    expect(runtimeTestState.runtime.restartPlugin).toHaveBeenCalledWith(
      "plugin-a",
      { skipPreparation: true },
    );
    expect(api.config.get("k")).toBe("v");
  });

  it("rejects config.set for a secret-format key and does not persist", async () => {
    const store = new Map<string, Record<string, unknown>>();
    const settings = makeSettingsService(store);
    const createHostApi = await initAndGetFactory(settings);
    activeManifest = {
      id: "plugin-a",
      config: {},
      configSchema: { properties: { secretKey: { type: "string", format: "secret" } } },
    };
    const api = createHostApi(
      "plugin-a",
      activeManifest,
      mkdtempSync("/tmp/lvis-cfg-secret-"),
    );

    await expect(api.config.set("secretKey", "leak")).rejects.toThrow(/secret fields must be saved via hostApi\.setSecret/);
    expect(settings.setPluginConfig).not.toHaveBeenCalled();
  });

  it("rejects a queued write when uninstall invalidates the HostApi instance", async () => {
    const store = new Map<string, Record<string, unknown>>();
    const settings = makeSettingsService(store);
    const api = await createActiveApi(settings);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const lockEntered = new Promise<void>((resolve) => { entered = resolve; });
    const uninstall = withPluginInstallLock("plugin-a", async () => {
      entered();
      await gate;
    });
    await lockEntered;

    const write = api.config.set("k", "stale");
    await Promise.resolve();
    expect(settings.setPluginConfig).not.toHaveBeenCalled();

    runtimeTestState.runtime.getPluginManifest.mockReturnValue(null);
    expect(() => api.config.get("k")).toThrow(/plugin instance is no longer active/);
    release();
    await uninstall;
    await expect(write).rejects.toThrow(/plugin instance is no longer active/);
    expect(settings.setPluginConfig).not.toHaveBeenCalled();
    expect(runtimeTestState.runtime.restartPlugin).not.toHaveBeenCalled();
  });

  it("persists config from a lifecycle hook without recursively restarting itself", async () => {
    const store = new Map<string, Record<string, unknown>>();
    const settings = makeSettingsService(store);
    const createHostApi = await initAndGetFactory(settings);
    activeManifest = { id: "plugin-a", config: {} };
    const api = createHostApi(
      "plugin-a",
      activeManifest,
      mkdtempSync("/tmp/lvis-cfg-lifecycle-"),
      {
        registerDisposer: vi.fn(),
        isActive: () => true,
        isLifecycleHookActive: () => true,
      },
    );

    await expect(api.config.set("duringStart", true)).resolves.toBeUndefined();
    expect(settings.setPluginConfig).toHaveBeenCalledWith("plugin-a", { duringStart: true });
    expect(runtimeTestState.runtime.restartPlugin).not.toHaveBeenCalled();
  });

  it("does not deadlock when stop-time config.set re-enters the uninstall lock", async () => {
    const settings = makeSettingsService(new Map());
    const api = await createActiveApi(settings);

    await expect(withPluginInstallLock("plugin-a", async () => {
      await api.config.set("duringStop", true);
    })).resolves.toBeUndefined();

    expect(settings.setPluginConfig).toHaveBeenCalledWith(
      "plugin-a",
      { duringStop: true },
    );
    expect(runtimeTestState.runtime.restartPlugin).not.toHaveBeenCalled();
  });

  it("surfaces a non-started runtime reload result after config persistence", async () => {
    const settings = makeSettingsService(new Map());
    const api = await createActiveApi(settings);
    runtimeTestState.runtime.restartPlugin.mockResolvedValueOnce("failed");

    await expect(api.config.set("k", "v")).rejects.toThrow(/runtime reload returned failed/);
    expect(settings.setPluginConfig).toHaveBeenCalledWith("plugin-a", { k: "v" });
  });
});

describe("HostApi emitEvent/onEvent round-trip", () => {
  it("delivers an emitted event to a same-plugin subscriber with the pluginId injected, and unsubscribe stops delivery", async () => {
    const createHostApi = await initAndGetFactory(makeSettingsService(new Map()));
    const api = createHostApi(
      "plugin-a",
      { id: "plugin-a", config: {}, capabilities: [] },
      mkdtempSync("/tmp/lvis-evt-"),
      activeIncarnation(),
    );

    const handler = vi.fn();
    const unsubscribe = api.onEvent("plugin-a.updated", handler);

    api.emitEvent("plugin-a.updated", { value: 7 });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ value: 7, pluginId: "plugin-a" });

    unsubscribe();
    api.emitEvent("plugin-a.updated", { value: 8 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("revokes every callable HostApi surface when its incarnation is deactivated", async () => {
    const createHostApi = await initAndGetFactory(makeSettingsService(new Map()));
    let active = true;
    const api = createHostApi(
      "plugin-a",
      { id: "plugin-a", config: {}, emittedEvents: ["plugin-a.updated"] },
      mkdtempSync("/tmp/lvis-revoked-hostapi-"),
      {
        registerDisposer: vi.fn(),
        isActive: () => active,
        isLifecycleHookActive: () => false,
      },
    );
    expect(api.config.get("before")).toBeUndefined();

    active = false;
    expect(() => api.config.get("after")).toThrow(/plugin instance is no longer active/);
    expect(() => api.getSecret("token")).toThrow(/plugin instance is no longer active/);
    expect(() => api.emitEvent("plugin-a.updated", {})).toThrow(/plugin instance is no longer active/);
    expect(() => api.onEvent("plugin-a.updated", vi.fn())).toThrow(/plugin instance is no longer active/);
  });
});
