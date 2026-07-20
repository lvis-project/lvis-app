/**
 * C1 gap-lock — initPluginRuntime HostApi: openAuthWindow / clearAuthPartition
 * capability + partition allow-list gates (observable effects).
 *
 * Both surfaces are capability-gated on `external-auth-consumer` and
 * clearAuthPartition additionally restricts the target to the calling
 * plugin's own `persist:plugin-auth:<id>[:<sub>]` partitions. This locks the
 * CURRENT observable behavior: capability-denied throws, invalid-partition
 * throws, and a valid clearAuthPartition delegates to the injected service.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";

const runtimeTestState = vi.hoisted(() => ({
  capturedRuntimeOptions: null as Record<string, unknown> | null,
  clearAuthPartitionService: vi.fn(async (_partition: string) => {}),
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
    setWildcardConfigOverride: vi.fn(),
    getWildcardConfigOverride: vi.fn(() => ({}) as Record<string, unknown>),
    restartPlugin: vi.fn(async () => "started"),
  },
}));

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "/tmp/lvis-test"), isPackaged: false, prependOnceListener: vi.fn() },
  BrowserWindow: Object.assign(vi.fn(), {
    getAllWindows: vi.fn(() => []),
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

vi.mock("../../../plugins/dev-watcher.js", () => ({ startPluginDevWatcher: vi.fn(() => ({ stop: vi.fn() })) }));
vi.mock("../../../main/html-preview-partition.js", () => ({ installPluginPartitionPolicy: vi.fn() }));
vi.mock("../../../plugins/plugin-paths.js", () => ({
  resolvePluginPaths: vi.fn(() => ({
    pluginsRoot: "/tmp/lvis-test/plugins",
    registryPath: "/tmp/lvis-test/registry.json",
    cacheRoot: "/tmp/lvis-test/cache",
  })),
}));
vi.mock("../../../plugins/registry.js", () => ({
  readPluginRegistry: vi.fn(async () => ({ version: 1, plugins: [] })),
}));

import { initPluginRuntime } from "../plugin-runtime.js";

type AuthHostApi = {
  openAuthWindow: (opts: { url: string; cookieHosts?: string[] }) => Promise<unknown>;
  clearAuthPartition: (partition: string) => Promise<void>;
};

type CreateHostApi = (
  pluginId: string,
  manifest: { id: string; config?: Record<string, unknown>; capabilities?: string[] },
  pluginDataDir: string,
) => AuthHostApi;

async function initAndGetFactory(): Promise<CreateHostApi> {
  runtimeTestState.capturedRuntimeOptions = null;
  await initPluginRuntime({
    projectRoot: "/tmp/lvis-test/project",
    settingsService: {
      get: vi.fn((key: string) => {
        if (key === "llm") return { provider: "openai" };
        if (key === "pluginConfigs") return {};
        return undefined;
      }),
      getSecret: vi.fn(() => undefined),
      getPluginConfig: vi.fn(() => ({})),
      setPluginConfig: vi.fn(),
    } as never,
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
    openAuthWindowService: vi.fn(async () => []),
    openLinkWindowService: vi.fn(),
    openAuthPartitionViewerService: vi.fn(),
    clearAuthPartitionService: runtimeTestState.clearAuthPartitionService,
    shellOpenExternal: vi.fn(),
    approvalGate: { requestAndWait: vi.fn() } as never,
    routinesStore: { list: () => [] } as never,
  });
  const createHostApi = (runtimeTestState.capturedRuntimeOptions as { createHostApi?: CreateHostApi } | null)?.createHostApi;
  expect(createHostApi).toBeDefined();
  return createHostApi!;
}

beforeEach(() => {
  runtimeTestState.clearAuthPartitionService.mockClear();
});

describe("HostApi openAuthWindow capability gate", () => {
  it("rejects when the manifest has not declared external-auth-consumer", async () => {
    const createHostApi = await initAndGetFactory();
    const api = createHostApi("plugin-a", { id: "plugin-a", config: {}, capabilities: [] }, mkdtempSync("/tmp/lvis-auth-"));
    await expect(api.openAuthWindow({ url: "https://idp.example.com/authorize" })).rejects.toThrow(
      /capability not declared: external-auth-consumer/,
    );
  });
});

describe("HostApi clearAuthPartition capability + partition gates", () => {
  it("rejects when the manifest has not declared external-auth-consumer", async () => {
    const createHostApi = await initAndGetFactory();
    const api = createHostApi("plugin-a", { id: "plugin-a", config: {}, capabilities: [] }, mkdtempSync("/tmp/lvis-auth-"));
    await expect(api.clearAuthPartition("persist:plugin-auth:plugin-a")).rejects.toThrow(
      /capability not declared: external-auth-consumer/,
    );
    expect(runtimeTestState.clearAuthPartitionService).not.toHaveBeenCalled();
  });

  it("rejects a partition outside the plugin's own auth namespace", async () => {
    const createHostApi = await initAndGetFactory();
    const api = createHostApi(
      "plugin-a",
      { id: "plugin-a", config: {}, capabilities: ["external-auth-consumer"] },
      mkdtempSync("/tmp/lvis-auth-"),
    );
    await expect(api.clearAuthPartition("persist:plugin-auth:other-plugin")).rejects.toThrow(
      /partition must be 'persist:plugin-auth:plugin-a'/,
    );
    expect(runtimeTestState.clearAuthPartitionService).not.toHaveBeenCalled();
  });

  it("delegates a valid own-namespace partition to the injected clearAuthPartitionService", async () => {
    const createHostApi = await initAndGetFactory();
    const api = createHostApi(
      "plugin-a",
      { id: "plugin-a", config: {}, capabilities: ["external-auth-consumer"] },
      mkdtempSync("/tmp/lvis-auth-"),
    );
    await api.clearAuthPartition("persist:plugin-auth:plugin-a:tenant-1");
    expect(runtimeTestState.clearAuthPartitionService).toHaveBeenCalledWith(
      "persist:plugin-auth:plugin-a:tenant-1",
    );
  });
});
