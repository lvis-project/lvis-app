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
import { createHash } from "node:crypto";

const runtimeTestState = vi.hoisted(() => ({
  browserWindows: [] as Array<{ isDestroyed: () => boolean; webContents: { send: (channel: string, payload: unknown) => void };
  }>,
  capturedRuntimeOptions: null as Record<string, unknown> | null,
  readPluginRegistry: vi.fn(async () => ({ version: 1, plugins: [] })),
  spawnWorker: vi.fn(),
  runtime: {
    startAll: vi.fn(async () => {}),
    listToolNames: vi.fn(() => [] as string[]),
    listPluginIds: vi.fn(() => [] as string[]),
    listPluginManifests: vi.fn(() => [] as Array<{ pluginId: string; manifest: unknown }>,
    ),
    getPluginRoot: vi.fn((pluginId: string) => `/tmp/lvis-test/plugins/${pluginId}`,
    ),
    getPluginManifest: vi.fn(() => null),
    resolvePluginInstallId: vi.fn((pluginId: string) => pluginId),
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
  PluginRuntime: vi.fn().mockImplementation(function (
    this: unknown,
    options: Record<string, unknown>,
  ) {
    runtimeTestState.capturedRuntimeOptions = options;
    return runtimeTestState.runtime;
  }),
}));

vi.mock("../../../plugins/dev-watcher.js", () => ({
  startPluginDevWatcher: vi.fn(() => ({ stop: vi.fn() })),
}));

vi.mock("../../../permissions/worker-spawn.js", () => ({
  spawnWorker: runtimeTestState.spawnWorker,
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
import { canonicalJSON } from "../../../plugins/whitelist/canonical-json.js";

type ConfigHostApi = {
  config: {
    get: <T = unknown>(key: string) => T | undefined;
    set: <T = unknown>(key: string, value: T) => Promise<void>;
  };
  emitEvent: (type: string, data?: unknown) => void;
  onEvent: (type: string, handler: (data: unknown) => void) => () => void;
  getSecret: (key: string) => string | undefined | null;
  resolveApiKey: (opts: {
    purpose: "llm";
    vendor?: "openai";
  }) => Promise<
    | { ok: false; reason: string }
    | { ok: true; vendor: string; bearer: () => string; release: () => void }
  >;
  spawnWorker: (spec: { workerId: string; command: string }) => Promise<{
    socketPath: string | null;
    pid: number | undefined;
    stop: () => void;
    onStdout: (listener: (chunk: string) => void) => void;
    onStderr: (listener: (chunk: string) => void) => void;
    onExit: (
      listener: (info: {
        code: number | null;
        signal: NodeJS.Signals | null;
      }) => void,
    ) => void;
  }>;
};

type CreateHostApi = (
  pluginId: string,
  manifest: {
    id: string;
    config?: Record<string, unknown>;
    configSchema?: {
      properties?: Record<
        string,
        { type?: string; format?: string; default?: unknown }
      >;
    };
    capabilities?: string[];
    emittedEvents?: string[];
    hostSecrets?: { read?: string[] };
  },
  pluginDataDir: string,
  incarnation: {
    registerDisposer: (dispose: () => void) => void;
    trackOperation: <T>(operation: Promise<T>) => Promise<T>;
    isActive: () => boolean;
    isLifecycleHookActive: () => boolean;
  },
  installPluginId: string | null,
  candidateRegistryEntry?: {
    installSource?: "admin" | "user" | "local-dev";
    manifestSha256?: string;
  },
) => ConfigHostApi;

async function initAndGetFactory(
  settingsService: unknown,
): Promise<CreateHostApi> {
  runtimeTestState.capturedRuntimeOptions = null;
  await initPluginRuntime({
    projectRoot: "/tmp/lvis-test/project",
    settingsService: settingsService as never,
    memoryManager: {} as never,
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
  const createHostApi = (
    runtimeTestState.capturedRuntimeOptions as {
      createHostApi?: CreateHostApi;
    } | null
  )?.createHostApi;
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
    setPluginConfig: vi.fn(
      async (pluginId: string, record: Record<string, unknown>) => {
        store.set(pluginId, record);
      },
    ),
  };
}

function activeIncarnation() {
  return {
    registerDisposer: vi.fn(),
    trackOperation: <T>(operation: Promise<T>) => operation,
    isActive: () => true,
    isLifecycleHookActive: () => false,
  };
}

beforeEach(() => {
  runtimeTestState.readPluginRegistry.mockReset();
  runtimeTestState.readPluginRegistry.mockResolvedValue({
    version: 1,
    plugins: [],
  });
  runtimeTestState.runtime.setConfigOverride.mockClear();
  runtimeTestState.runtime.restartPlugin.mockClear();
  runtimeTestState.runtime.getWildcardConfigOverride.mockReturnValue({});
  runtimeTestState.runtime.getPluginManifest.mockReturnValue(null);
  runtimeTestState.runtime.resolvePluginInstallId.mockClear();
  runtimeTestState.runtime.resolvePluginInstallId.mockImplementation(
    (pluginId: string) => pluginId,
  );
  runtimeTestState.spawnWorker.mockReset();
});

describe("HostApi.config.get merged-read precedence", () => {
  it("fails clearly when immutable install provenance is omitted", async () => {
    const createHostApi = await initAndGetFactory(makeSettingsService(new Map()));
    const invokeWithoutInstallId = createHostApi as unknown as (
      pluginId: string,
      manifest: Parameters<CreateHostApi>[1],
      pluginDataDir: string,
      incarnation: ReturnType<typeof activeIncarnation>,
    ) => unknown;

    expect(() => invokeWithoutInstallId(
      "plugin-a",
      { id: "plugin-a", config: {} },
      mkdtempSync("/tmp/lvis-missing-provenance-"),
      activeIncarnation(),
    )).toThrow(/HostApi install provenance missing: plugin-a/);
    expect(runtimeTestState.runtime.resolvePluginInstallId).not.toHaveBeenCalled();
  });

  it("layers manifest.config < wildcard override < saved plugin config", async () => {
    const store = new Map<string, Record<string, unknown>>([
      ["plugin-a", { p: "cfg", shared: "cfg" }],
    ]);
    runtimeTestState.runtime.getWildcardConfigOverride.mockReturnValue({
      w: "wild",
      shared: "wild",
    });
    const createHostApi = await initAndGetFactory(makeSettingsService(store));
    const api = createHostApi(
      "plugin-a",
      { id: "plugin-a", config: { a: "m", shared: "m" } },
      mkdtempSync("/tmp/lvis-cfg-"),
      activeIncarnation(),
      "plugin-a",
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
      "plugin-a",
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
    runtimeTestState.runtime.getPluginManifest.mockImplementation(
      (pluginId: string) => (pluginId === "plugin-a" ? activeManifest : null),
    );
  });

  let activeManifest: Parameters<CreateHostApi>[1];

  async function createActiveApi(
    settings: ReturnType<typeof makeSettingsService>,
  ) {
    const createHostApi = await initAndGetFactory(settings);
    activeManifest = { id: "plugin-a", config: {} };
    return createHostApi(
      "plugin-a",
      activeManifest,
      mkdtempSync("/tmp/lvis-cfg-set-"),
      {
        registerDisposer: vi.fn(),
        trackOperation: <T>(operation: Promise<T>) => operation,
        isActive: () =>
          runtimeTestState.runtime.getPluginManifest("plugin-a") ===
          activeManifest,
        isLifecycleHookActive: () => false,
      },
      "plugin-a",
    );
  }

  it("persists via setPluginConfig, refreshes the override, restarts the plugin, and re-reads the value", async () => {
    const store = new Map<string, Record<string, unknown>>();
    const settings = makeSettingsService(store);
    const api = await createActiveApi(settings);

    await api.config.set("k", "v");

    expect(settings.setPluginConfig).toHaveBeenCalledWith("plugin-a", {
      k: "v",
    });
    expect(runtimeTestState.runtime.setConfigOverride).toHaveBeenCalledWith(
      "plugin-a",
      { k: "v" },
    );
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
      configSchema: {
        properties: { secretKey: { type: "string", format: "secret" } },
      },
    };
    const api = createHostApi(
      "plugin-a",
      activeManifest,
      mkdtempSync("/tmp/lvis-cfg-secret-"),
      activeIncarnation(),
      "plugin-a",
    );

    await expect(api.config.set("secretKey", "leak")).rejects.toThrow(
      /secret fields must be saved via hostApi\.setSecret/,
    );
    expect(settings.setPluginConfig).not.toHaveBeenCalled();
  });

  it("rejects a queued write when uninstall invalidates the HostApi instance", async () => {
    const store = new Map<string, Record<string, unknown>>();
    const settings = makeSettingsService(store);
    const api = await createActiveApi(settings);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lockEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const uninstall = withPluginInstallLock("plugin-a", async () => {
      entered();
      await gate;
    });
    await lockEntered;

    const write = api.config.set("k", "stale");
    await Promise.resolve();
    expect(settings.setPluginConfig).not.toHaveBeenCalled();

    runtimeTestState.runtime.getPluginManifest.mockReturnValue(null);
    expect(() => api.config.get("k")).toThrow(
      /plugin instance is no longer active/,
    );
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
    const trackOperation = vi.fn(<T>(operation: Promise<T>) => operation);
    const api = createHostApi(
      "plugin-a",
      activeManifest,
      mkdtempSync("/tmp/lvis-cfg-lifecycle-"),
      {
        registerDisposer: vi.fn(),
        trackOperation,
        isActive: () => true,
        isLifecycleHookActive: () => true,
      },
      "plugin-a",
    );

    await expect(api.config.set("duringStart", true)).resolves.toBeUndefined();
    expect(settings.setPluginConfig).toHaveBeenCalledWith("plugin-a", {
      duringStart: true,
    });
    expect(trackOperation).toHaveBeenCalledTimes(1);
    expect(runtimeTestState.runtime.restartPlugin).not.toHaveBeenCalled();
  });

  it("does not deadlock when stop-time config.set re-enters the uninstall lock", async () => {
    const settings = makeSettingsService(new Map());
    const api = await createActiveApi(settings);

    await expect(
      withPluginInstallLock("plugin-a", async () => {
        await api.config.set("duringStop", true);
      }),
    ).resolves.toBeUndefined();

    expect(settings.setPluginConfig).toHaveBeenCalledWith("plugin-a", {
      duringStop: true,
    });
    expect(runtimeTestState.runtime.restartPlugin).not.toHaveBeenCalled();
  });

  it("reports a detached lifecycle config write failure to the owning mutation", async () => {
    const settings = makeSettingsService(new Map());
    settings.setPluginConfig.mockRejectedValueOnce(
      new Error("config persistence failed"),
    );
    const api = await createActiveApi(settings);

    const error = await withPluginInstallLock("plugin-a", async () => {
      void api.config.set("duringStop", true);
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([
      expect.objectContaining({ message: "config persistence failed" }),
    ]);
    expect(runtimeTestState.runtime.restartPlugin).not.toHaveBeenCalled();
  });

  it("surfaces a non-started runtime reload result after config persistence", async () => {
    const settings = makeSettingsService(new Map());
    const api = await createActiveApi(settings);
    runtimeTestState.runtime.restartPlugin.mockResolvedValueOnce("failed");

    await expect(api.config.set("k", "v")).rejects.toThrow(
      /runtime reload returned failed/,
    );
    expect(settings.setPluginConfig).toHaveBeenCalledWith("plugin-a", {
      k: "v",
    });
  });
});

describe("HostApi emitEvent/onEvent round-trip", () => {
  it("uses the raw registry install identity for canonical alias HostApi provenance", async () => {
    const installAlias = "marketplace-install-alias";
    const pluginId = "plugin-canonical";
    const secretKey = "host.shared.secret";
    const manifest = {
      id: pluginId,
      config: {},
      hostSecrets: { read: [secretKey] },
    };
    const manifestSha256 = createHash("sha256")
      .update(canonicalJSON(manifest))
      .digest("hex");
    runtimeTestState.readPluginRegistry.mockResolvedValueOnce({
      version: 1,
      plugins: [{
        id: installAlias,
        manifestPath: `${installAlias}/plugin.json`,
        installSource: "admin",
        manifestSha256,
      }],
    });
    runtimeTestState.runtime.resolvePluginInstallId.mockImplementation(
      (requestedPluginId: string) =>
        requestedPluginId === pluginId ? installAlias : requestedPluginId,
    );
    const settings = makeSettingsService(new Map());
    settings.getSecret.mockImplementation((key: string) =>
      key === secretKey ? "host-secret-value" : undefined
    );

    const createHostApi = await initAndGetFactory(settings);
    const api = createHostApi(
      pluginId,
      manifest,
      mkdtempSync("/tmp/lvis-hostapi-alias-"),
      activeIncarnation(),
      installAlias,
    );

    expect(api.getSecret(secretKey)).toBe("host-secret-value");
    expect(runtimeTestState.runtime.resolvePluginInstallId)
      .not.toHaveBeenCalled();
  });

  it("uses immutable candidate trust before the durable registry cache refresh", async () => {
    const pluginId = "fresh-admin-plugin";
    const secretKey = "host.shared.secret";
    const manifest = {
      id: pluginId,
      config: {},
      hostSecrets: { read: [secretKey] },
    };
    const manifestSha256 = createHash("sha256")
      .update(canonicalJSON(manifest))
      .digest("hex");
    const settings = makeSettingsService(new Map());
    settings.getSecret.mockImplementation((key: string) =>
      key === secretKey ? "fresh-admin-secret" : undefined
    );
    const createHostApi = await initAndGetFactory(settings);
    const api = createHostApi(
      pluginId,
      manifest,
      mkdtempSync("/tmp/lvis-hostapi-fresh-admin-"),
      activeIncarnation(),
      "marketplace-fresh-admin",
      { installSource: "admin", manifestSha256 },
    );

    expect(api.getSecret(secretKey)).toBe("fresh-admin-secret");
    expect(runtimeTestState.readPluginRegistry).toHaveBeenCalledOnce();
  });

  it("delivers an emitted event to a same-plugin subscriber with the pluginId injected, and unsubscribe stops delivery", async () => {
    const createHostApi = await initAndGetFactory(
      makeSettingsService(new Map()),
    );
    const api = createHostApi(
      "plugin-a",
      { id: "plugin-a", config: {}, capabilities: [] },
      mkdtempSync("/tmp/lvis-evt-"),
      activeIncarnation(),
      "plugin-a",
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

  it("releases returned API-key and worker capabilities when the incarnation is disposed", async () => {
    const settings = makeSettingsService(new Map());
    settings.getSecret.mockImplementation((key: string) =>
      key === "plugin.plugin-a.llm.apiKey.openai"
        ? "sk-incarnation"
        : undefined,
    );
    const workerStop = vi.fn();
    const workerOnStdout = vi.fn();
    const workerOnStderr = vi.fn();
    const workerOnExit = vi.fn();
    runtimeTestState.spawnWorker.mockResolvedValue({
      socketPath: "/tmp/plugin-a.sock",
      pid: 42,
      stop: workerStop,
      onStdout: workerOnStdout,
      onStderr: workerOnStderr,
      onExit: workerOnExit,
    });
    const disposers: Array<() => void> = [];
    let active = true;
    const createHostApi = await initAndGetFactory(settings);
    const api = createHostApi(
      "plugin-a",
      { id: "plugin-a", config: {} },
      mkdtempSync("/tmp/lvis-issued-capabilities-"),
      {
        registerDisposer: (dispose) => disposers.push(dispose),
        trackOperation: <T>(operation: Promise<T>) => operation,
        isActive: () => active,
        isLifecycleHookActive: () => false,
      },
      "plugin-a",
    );

    const key = await api.resolveApiKey({ purpose: "llm", vendor: "openai" });
    expect(key.ok).toBe(true);
    if (!key.ok) throw new Error("expected API key capability");
    expect(key.bearer()).toBe("sk-incarnation");
    const worker = await api.spawnWorker({
      workerId: "worker-a",
      command: "node",
    });
    const stdoutListener = vi.fn();
    const stderrListener = vi.fn();
    const exitListener = vi.fn();
    worker.onStdout(stdoutListener);
    worker.onStderr(stderrListener);
    worker.onExit(exitListener);

    workerOnStdout.mock.calls[0]?.[0]("before");
    workerOnStderr.mock.calls[0]?.[0]("before-error");
    workerOnExit.mock.calls[0]?.[0]({ code: 0, signal: null });
    expect(stdoutListener).toHaveBeenCalledWith("before");
    expect(stderrListener).toHaveBeenCalledWith("before-error");
    expect(exitListener).toHaveBeenCalledWith({ code: 0, signal: null });
    stdoutListener.mockClear();
    stderrListener.mockClear();
    exitListener.mockClear();

    active = false;
    for (const dispose of disposers) dispose();

    expect(() => key.bearer()).toThrow(/plugin instance is no longer active/);
    expect(() => worker.onStdout(vi.fn())).toThrow(
      /plugin instance is no longer active/,
    );
    workerOnStdout.mock.calls[0]?.[0]("after");
    workerOnStderr.mock.calls[0]?.[0]("after-error");
    workerOnExit.mock.calls[0]?.[0]({ code: null, signal: "SIGTERM" });
    expect(stdoutListener).not.toHaveBeenCalled();
    expect(stderrListener).not.toHaveBeenCalled();
    expect(exitListener).not.toHaveBeenCalled();
    expect(workerStop).toHaveBeenCalledTimes(1);
    worker.stop();
    expect(workerStop).toHaveBeenCalledTimes(1);
  });

  it("revokes every callable HostApi surface when its incarnation is deactivated", async () => {
    const createHostApi = await initAndGetFactory(
      makeSettingsService(new Map()),
    );
    let active = true;
    const api = createHostApi(
      "plugin-a",
      { id: "plugin-a", config: {}, emittedEvents: ["plugin-a.updated"] },
      mkdtempSync("/tmp/lvis-revoked-hostapi-"),
      {
        registerDisposer: vi.fn(),
        trackOperation: <T>(operation: Promise<T>) => operation,
        isActive: () => active,
        isLifecycleHookActive: () => false,
      },
      "plugin-a",
    );
    expect(api.config.get("before")).toBeUndefined();

    active = false;
    expect(() => api.config.get("after")).toThrow(
      /plugin instance is no longer active/,
    );
    expect(() => api.getSecret("token")).toThrow(
      /plugin instance is no longer active/,
    );
    expect(() => api.emitEvent("plugin-a.updated", {})).toThrow(
      /plugin instance is no longer active/,
    );
    expect(() => api.onEvent("plugin-a.updated", vi.fn())).toThrow(
      /plugin instance is no longer active/,
    );
  });
});
