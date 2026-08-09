/**
 * HostApi window targeting — a host→renderer send must go to the CURRENT main
 * window, not the one captured at boot.
 *
 * `showOrCreateMainWindow` (tray "Open LVIS", dock `activate`, `lvis://` deep
 * link) calls `createWindow()` when the previous main window is gone, which
 * registers a NEW BrowserWindow. `initPluginRuntime` runs once at boot, so the
 * `mainWindow` it captured is by then a destroyed handle: an overlay proposal
 * sent to it is a silent no-op while `triggerConversation` still answers
 * `{ accepted: true }`.
 *
 * Driven through the REAL producer (`initPluginRuntime` → captured
 * `createHostApi` → `hostApi.triggerConversation`) rather than by calling
 * `createHostApiFactory` directly, so deleting `getMainWindow` from the
 * `createHostApiFactory({...})` call site is caught here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cleanupTmpDir } from "../../../testing/tmp-dir-teardown.js";

const tmpDirs = new Set<string>();

function trackTmpDir(dir: string): string {
  tmpDirs.add(dir);
  return dir;
}

const runtimeTestState = vi.hoisted(() => ({
  browserWindows: [] as unknown[],
  capturedRuntimeOptions: null as Record<string, unknown> | null,
  readPluginRegistry: vi.fn(async () => ({ version: 1, plugins: [] })),
  runtime: {
    startAll: vi.fn(async () => {}),
    listToolNames: vi.fn(() => [] as string[]),
    listPluginIds: vi.fn(() => [] as string[]),
    listPluginManifests: vi.fn(() => [] as Array<{ pluginId: string; manifest: unknown }>),
    getPluginRoot: vi.fn((pluginId: string) => `/tmp/lvis-test/plugins/${pluginId}`),
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
    once: vi.fn(),
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
  spawnWorker: vi.fn(),
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
import { OVERLAY_V1 } from "../../../shared/ipc-channels.js";

interface FakeWindow {
  destroyed: boolean;
  isDestroyed: () => boolean;
  webContents: { send: ReturnType<typeof vi.fn> };
}

function makeWindow(destroyed = false): FakeWindow {
  const win: FakeWindow = {
    destroyed,
    isDestroyed: () => win.destroyed,
    webContents: { send: vi.fn() },
  };
  return win;
}

type OverlayHostApi = {
  triggerConversation: (spec: {
    source: string;
    prompt: string;
    title?: string;
    dedupeKey?: string;
  }) => Promise<{ accepted: boolean }>;
};

type CreateHostApi = (
  pluginId: string,
  manifest: Record<string, unknown>,
  pluginDataDir: string,
  incarnation: Record<string, unknown>,
  installPluginId: string | null,
) => OverlayHostApi;

/**
 * Boot the plugin runtime exactly as `boot.ts` does and hand back the overlay
 * HostApi for one plugin. `bootWindow` is what boot captured; `getMainWindow`
 * is the live registry `showOrCreateMainWindow` re-registers into.
 */
async function overlayHostApi(input: {
  bootWindow: FakeWindow;
  getMainWindow?: () => FakeWindow | null;
}): Promise<OverlayHostApi> {
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
      setPluginConfig: vi.fn(async () => {}),
    } as never,
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
    mainWindow: input.bootWindow as never,
    ...(input.getMainWindow ? { getMainWindow: input.getMainWindow as never } : {}),
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
    runtimeTestState.capturedRuntimeOptions as { createHostApi?: CreateHostApi } | null
  )?.createHostApi;
  expect(createHostApi).toBeDefined();
  return createHostApi!(
    "plugin-a",
    { id: "plugin-a", capabilities: ["host:overlay"] },
    trackTmpDir(mkdtempSync(join(tmpdir(), "lvis-overlay-win-"))),
    {
      registerDisposer: vi.fn(),
      trackOperation: <T>(operation: Promise<T>) => operation,
      isActive: () => true,
      isLifecycleHookActive: () => false,
    },
    null,
  );
}

beforeEach(() => {
  runtimeTestState.readPluginRegistry.mockReset();
  runtimeTestState.readPluginRegistry.mockResolvedValue({ version: 1, plugins: [] });
  runtimeTestState.runtime.getPluginManifest.mockReturnValue(null);
});

afterEach(async () => {
  for (const dir of tmpDirs) {
    await cleanupTmpDir(dir);
  }
  tmpDirs.clear();
});

describe("hostApi.triggerConversation overlay send targets the live main window", () => {
  it("sends to the window created AFTER a close+reopen, not the boot capture", async () => {
    const bootWindow = makeWindow();
    let current: FakeWindow = bootWindow;
    const api = await overlayHostApi({
      bootWindow,
      getMainWindow: () => current,
    });

    // Close + reopen: the boot handle is destroyed and a new window registers.
    bootWindow.destroyed = true;
    const reopened = makeWindow();
    current = reopened;

    const outcome = await api.triggerConversation({
      source: "overlay:test",
      prompt: "검토가 필요합니다.",
      dedupeKey: "after-reopen",
    });

    expect(outcome.accepted).toBe(true);
    expect(bootWindow.webContents.send).not.toHaveBeenCalled();
    const sent = reopened.webContents.send.mock.calls.filter(
      ([channel]) => channel === OVERLAY_V1.show,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0][1]).toMatchObject({
      source: { kind: "plugin", pluginId: "plugin-a" },
      running: false,
    });
  });

  it("still sends to the boot capture while it is the live window", async () => {
    const bootWindow = makeWindow();
    const api = await overlayHostApi({
      bootWindow,
      getMainWindow: () => bootWindow,
    });

    await api.triggerConversation({
      source: "overlay:test",
      prompt: "검토가 필요합니다.",
      dedupeKey: "before-reopen",
    });

    expect(
      bootWindow.webContents.send.mock.calls.filter(
        ([channel]) => channel === OVERLAY_V1.show,
      ),
    ).toHaveLength(1);
  });

  it("falls back to the boot capture when no live getter is wired", async () => {
    const bootWindow = makeWindow();
    const api = await overlayHostApi({ bootWindow });

    await api.triggerConversation({
      source: "overlay:test",
      prompt: "검토가 필요합니다.",
      dedupeKey: "no-getter",
    });

    expect(
      bootWindow.webContents.send.mock.calls.filter(
        ([channel]) => channel === OVERLAY_V1.show,
      ),
    ).toHaveLength(1);
  });
});
