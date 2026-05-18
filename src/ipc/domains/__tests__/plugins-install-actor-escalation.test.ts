/**
 * lvis:plugins:install IPC — per-plugin actor escalation based on
 * catalog installPolicy (#955 follow-up).
 *
 * Catalog 의 installPolicy === "admin" 인 plugin (예: meeting v0.4.14+,
 * local-indexer v0.4.11+) 의 사용자 update click 시 actor 가 "it-admin" 으로
 * 자동 escalate 되어 deployment-guard 통과. 일괄 처리 아님 — *각 plugin* 의
 * catalog policy 따라 결정.
 *
 * Issue: lvis-project/lvis-app#955 — 사용자 보고 "Admin plugin cannot be
 * installed by user: meeting" 에러가 meeting 0.4.14+ 의 IPC install 경로에서
 * 발생. catalog 가 signed marketplace truth 이므로 catalog 기반 escalation
 * 은 boot-time `ensureManagedInstalled` 의 actor="it-admin" 와 동일 패턴.
 */
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

function makeWindow() {
  return {
    isDestroyed: vi.fn(() => false),
    webContents: {
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
    },
  };
}

type CatalogItem = {
  id: string;
  installPolicy?: "admin" | "user";
};

async function setup(catalogItem: CatalogItem | null) {
  handlers.clear();
  vi.clearAllMocks();
  process.env.LVIS_DEV = "1";
  const devFlags = await import("../../../boot/dev-flags.js");
  devFlags.setIsPackaged(false);
  const appWindows = [makeWindow()];
  const installFn = vi.fn(
    async (
      _pluginId: string,
      _actor: string,
      onProgress: (event: { phase: string }) => void,
    ) => {
      onProgress({ phase: "registering" });
      return { pluginId: catalogItem?.id ?? "plugin-x", installed: true };
    },
  );
  const getPluginDetailFn = vi.fn(async () => catalogItem);
  const deps = {
    pluginMarketplace: {
      install: installFn,
      uninstall: vi.fn(async (pluginId: string) => ({ pluginId, uninstalled: true })),
      installLocal: vi.fn(),
      getFetcher: vi.fn(() => ({
        getPluginDetail: getPluginDetailFn,
        listPlugins: vi.fn(),
        downloadVersion: vi.fn(),
      })),
    },
    pluginRuntime: {
      addPlugin: vi.fn(async () => undefined),
      removePlugin: vi.fn(async () => undefined),
      mergeConfigOverride: vi.fn(),
      getPluginManifest: vi.fn(() => undefined),
    },
    settingsService: {
      get: vi.fn(() => ({ backend: "real-cloud" })),
      deletePluginConfig: vi.fn(async () => undefined),
      deletePluginSecrets: vi.fn(async () => 0),
    },
    auditLogger: {
      log: vi.fn(),
    },
    refreshPluginNotifications: vi.fn(),
    clearAuthPartitionService: vi.fn(async () => undefined),
    listPluginAuthPartitionsService: vi.fn(() => []),
    forgetPluginAuthPartitionsService: vi.fn(),
    getMainWindow: vi.fn(() => appWindows[0]),
    getAppWindows: vi.fn(() => appWindows),
  };
  const { registerPluginsHandlers } = await import("../plugins.js");
  registerPluginsHandlers(deps as never);
  return { deps, installFn, getPluginDetailFn };
}

beforeEach(() => {
  handlers.clear();
  delete process.env.LVIS_DEV;
  electronMocks.showOpenDialog.mockReset();
});

describe("lvis:plugins:install — per-plugin admin actor escalation", () => {
  it("escalates actor to it-admin when catalog installPolicy is admin", async () => {
    const { installFn, getPluginDetailFn, deps } = await setup({
      id: "meeting",
      installPolicy: "admin",
    });

    await invoke("lvis:plugins:install", "meeting");

    expect(getPluginDetailFn).toHaveBeenCalledWith("meeting");
    expect(installFn).toHaveBeenCalledTimes(1);
    const [installedId, actor] = installFn.mock.calls[0]!;
    expect(installedId).toBe("meeting");
    expect(actor).toBe("it-admin");

    // Audit entry recorded with escalation metadata.
    const escalationCalls = deps.auditLogger.log.mock.calls.filter((c) => {
      const entry = c[0] as { input?: string };
      return typeof entry.input === "string" && entry.input.includes("plugin-install-escalation");
    });
    expect(escalationCalls.length).toBe(1);
    const audited = JSON.parse((escalationCalls[0]![0] as { input: string }).input) as Record<string, unknown>;
    expect(audited.event).toBe("plugin-install-escalation");
    expect(audited.pluginId).toBe("meeting");
    expect(audited.catalogPolicy).toBe("admin");
    expect(audited.actorOriginal).toBe("user");
    expect(audited.actorEscalated).toBe("it-admin");
  });

  it("keeps actor=user when catalog installPolicy is user", async () => {
    const { installFn, deps } = await setup({
      id: "work-proactive",
      installPolicy: "user",
    });

    await invoke("lvis:plugins:install", "work-proactive");

    expect(installFn).toHaveBeenCalledTimes(1);
    expect(installFn.mock.calls[0]![1]).toBe("user");

    // No escalation audit emitted for user-policy plugins.
    const escalationCalls = deps.auditLogger.log.mock.calls.filter((c) => {
      const entry = c[0] as { input?: string };
      return typeof entry.input === "string" && entry.input.includes("plugin-install-escalation");
    });
    expect(escalationCalls.length).toBe(0);
  });

  it("keeps actor=user when installPolicy is omitted (defaults to user)", async () => {
    const { installFn } = await setup({ id: "agent-hub" });

    await invoke("lvis:plugins:install", "agent-hub");

    expect(installFn.mock.calls[0]![1]).toBe("user");
  });

  it("keeps actor=user when catalog item is not found (null detail)", async () => {
    const { installFn } = await setup(null);

    await invoke("lvis:plugins:install", "unknown-id");

    expect(installFn.mock.calls[0]![1]).toBe("user");
  });

  it("falls back to actor=user when catalog fetch throws", async () => {
    const { installFn, deps } = await setup({ id: "meeting", installPolicy: "admin" });
    // Override fetcher to throw — install should still proceed with user actor.
    deps.pluginMarketplace.getFetcher = vi.fn(() => ({
      getPluginDetail: vi.fn(async () => {
        throw new Error("network down");
      }),
      listPlugins: vi.fn(),
      downloadVersion: vi.fn(),
    }));
    // Re-register IPC handlers with the broken fetcher.
    handlers.clear();
    const { registerPluginsHandlers } = await import("../plugins.js");
    registerPluginsHandlers(deps as never);

    await invoke("lvis:plugins:install", "meeting");

    expect(installFn.mock.calls[0]![1]).toBe("user");
  });
});
