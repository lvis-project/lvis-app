import { afterEach, describe, expect, it, vi } from "vitest";
import {
  withPluginInstallLock,
  withAllPluginInstallLocks,
  installMarketplacePluginWithLifecycle,
  startInstalledPluginWithLifecycle,
} from "../install-lifecycle.js";
import {
  beginAppUpdateInstallRequest,
  clearAppUpdateInstallRequested,
} from "../../main/app-update-install-intent.js";

function makeRuntime(initialPluginIds: string[] = []) {
  let pluginIds = [...initialPluginIds];
  return {
    listPluginIds: vi.fn(() => [...pluginIds]),
    addPlugin: vi.fn(async (pluginId: string) => {
      if (!pluginIds.includes(pluginId)) pluginIds.push(pluginId);
      return "started" as const;
    }),
    waitForPluginReady: vi.fn(async () => {}),
    removePlugin: vi.fn(async (pluginId: string) => {
      pluginIds = pluginIds.filter((id) => id !== pluginId);
    }),
    dropPlugin(pluginId: string) {
      pluginIds = pluginIds.filter((id) => id !== pluginId);
    },
  };
}

function makeMarketplace() {
  return {
    list: vi.fn(async () => [
      { id: "p", slug: "lvis-plugin-p", version: "2.0.0" },
      { id: "meeting", slug: "lvis-plugin-meeting", version: "2.0.0" },
    ]),
    install: vi.fn(async (pluginId: string) => ({ pluginId, installed: true as const })),
    getLiveCatalogVersion: vi.fn(async () => "2.0.0"),
    getInstalledVersion: vi.fn(async () => "1.0.0"),
    quarantinePlugin: vi.fn(async (pluginId: string, reason: string) => ({ pluginId, reason, quarantined: true as const })),
    uninstall: vi.fn(async (pluginId: string) => ({ pluginId, uninstalled: true as const })),
    rollbackPlugin: vi.fn(async (pluginId: string) => ({ pluginId, rolledBackTo: "1.0.0" })),
    rollbackLocalInstall: vi.fn(async (pluginId: string) => ({ pluginId, rolledBack: true as const })),
    clearLocalInstallRollback: vi.fn(async () => {}),
  };
}

describe("installMarketplacePluginWithLifecycle", () => {
  afterEach(() => {
    clearAppUpdateInstallRequested();
  });

  it("rejects before touching marketplace state when app update install has started", async () => {
    const runtime = makeRuntime(["p"]);
    const marketplace = makeMarketplace();
    beginAppUpdateInstallRequest();

    await expect(
      installMarketplacePluginWithLifecycle({
        requestedPluginId: "p",
        pluginRuntime: runtime,
        pluginMarketplace: marketplace,
      }),
    ).rejects.toThrow("Plugin changes are paused while an app update is installing");

    expect(marketplace.list).not.toHaveBeenCalled();
    expect(marketplace.install).not.toHaveBeenCalled();
    expect(runtime.removePlugin).not.toHaveBeenCalled();
  });

  it("does not enter a plugin install lock callback after app update install starts", async () => {
    const install = vi.fn(async () => undefined);
    beginAppUpdateInstallRequest();

    await expect(withPluginInstallLock("p", install)).rejects.toMatchObject({
      code: "app-update-install-in-progress",
      message: expect.stringContaining("Plugin changes are paused while an app update is installing"),
    });

    expect(install).not.toHaveBeenCalled();
  });

  it("allows a same-plugin lifecycle hook to re-enter its owned lock", async () => {
    const order: string[] = [];
    await expect(withPluginInstallLock("p", async () => {
      order.push("outer:start");
      await withPluginInstallLock("p", async () => {
        order.push("inner");
      });
      order.push("outer:end");
    })).resolves.toBeUndefined();
    expect(order).toEqual(["outer:start", "inner", "outer:end"]);
  });

  it("gives multi-plugin bootstrap exclusive access across per-plugin mutations", async () => {
    const order: string[] = [];
    let releasePlugin!: () => void;
    let pluginEntered!: () => void;
    const pluginGate = new Promise<void>((resolve) => { releasePlugin = resolve; });
    const pluginStarted = new Promise<void>((resolve) => { pluginEntered = resolve; });
    const pluginMutation = withPluginInstallLock("p", async () => {
      order.push("plugin:start");
      pluginEntered();
      await pluginGate;
      order.push("plugin:end");
    });
    await pluginStarted;

    let releaseAll!: () => void;
    let allEntered!: () => void;
    const allGate = new Promise<void>((resolve) => { releaseAll = resolve; });
    const allStarted = new Promise<void>((resolve) => { allEntered = resolve; });
    const allMutation = withAllPluginInstallLocks(async () => {
      order.push("all:start");
      allEntered();
      await allGate;
      order.push("all:end");
    });
    await Promise.resolve();
    expect(order).toEqual(["plugin:start"]);

    releasePlugin();
    await pluginMutation;
    await allStarted;
    const otherMutation = withPluginInstallLock("other", async () => {
      order.push("other");
    });
    await Promise.resolve();
    expect(order).toEqual(["plugin:start", "plugin:end", "all:start"]);

    releaseAll();
    await allMutation;
    await otherMutation;
    expect(order).toEqual(["plugin:start", "plugin:end", "all:start", "all:end", "other"]);
  });

  it("stops a loaded plugin before marketplace patching and starts the installed result", async () => {
    const order: string[] = [];
    const runtime = makeRuntime(["p"]);
    const marketplace = makeMarketplace();
    runtime.removePlugin.mockImplementationOnce(async (pluginId: string) => {
      order.push(`remove:${pluginId}`);
      runtime.dropPlugin(pluginId);
    });
    marketplace.install.mockImplementationOnce(async (pluginId: string, onProgress) => {
      order.push(`install:${pluginId}`);
      expect(runtime.listPluginIds()).not.toContain("p");
      onProgress?.({ phase: "verifying" });
      return { pluginId: "p", installed: true as const };
    });
    runtime.addPlugin.mockImplementationOnce(async (pluginId: string) => {
      order.push(`add:${pluginId}`);
      return "started" as const;
    });

    const result = await installMarketplacePluginWithLifecycle({
      requestedPluginId: "p",
      pluginRuntime: runtime,
      pluginMarketplace: marketplace,
      broadcastInstallProgress: ({ phase }) => order.push(`progress:${phase}`),
      emitPluginInstalled: ({ pluginId, source }) => order.push(`installed:${pluginId}:${source}`),
      refreshPluginNotifications: () => order.push("refresh"),
    });

    expect(result).toEqual({ pluginId: "p", installed: true });
    expect(order).toEqual([
      "progress:restarting",
      "remove:p",
      "progress:installing",
      "install:p",
      "progress:verifying",
      "progress:restarting",
      "add:p",
      "installed:p:marketplace",
      "refresh",
    ]);
  });

  it("uses the canonical catalog id for locking and pre-stop while preserving the requested event slug", async () => {
    const order: string[] = [];
    const runtime = makeRuntime(["meeting"]);
    const marketplace = makeMarketplace();
    marketplace.install.mockImplementationOnce(async (pluginId: string) => {
      order.push(`install:${pluginId}`);
      return { pluginId: "meeting", installed: true as const };
    });

    await installMarketplacePluginWithLifecycle({
      requestedPluginId: "lvis-plugin-meeting",
      eventSlug: "lvis-plugin-meeting",
      pluginRuntime: runtime,
      pluginMarketplace: marketplace,
      broadcastInstallProgress: ({ slug, phase }) => order.push(`progress:${slug}:${phase}`),
    });

    expect(runtime.removePlugin).toHaveBeenCalledWith("meeting");
    expect(runtime.addPlugin).toHaveBeenCalledWith("meeting");
    expect(order).toEqual([
      "progress:lvis-plugin-meeting:restarting",
      "progress:lvis-plugin-meeting:installing",
      "install:lvis-plugin-meeting",
      "progress:lvis-plugin-meeting:restarting",
    ]);
  });

  it("passes the renderer networkAccess acknowledgement into the marketplace install boundary", async () => {
    const runtime = makeRuntime();
    const marketplace = makeMarketplace();
    marketplace.list.mockResolvedValue([
      {
        id: "p",
        slug: "lvis-plugin-p",
        version: "2.0.0",
        networkAccess: {
          allowedDomains: ["api.example.com"],
          reasoning: "Syncs data.",
        },
      },
    ]);

    await installMarketplacePluginWithLifecycle({
      requestedPluginId: "p",
      networkAccessAcknowledgement: { allowedDomains: ["api.example.com"] },
      pluginRuntime: runtime,
      pluginMarketplace: marketplace,
    });

    expect(marketplace.install).toHaveBeenCalledWith(
      "p",
      expect.any(Function),
      { networkAccessAcknowledgement: { allowedDomains: ["api.example.com"] } },
    );
  });

  it("pre-stops an installed plugin even when it is not currently loaded", async () => {
    const runtime = makeRuntime();
    const marketplace = makeMarketplace();
    marketplace.list.mockResolvedValue([{ id: "p", slug: "lvis-plugin-p", installed: true, version: "2.0.0" }]);

    await installMarketplacePluginWithLifecycle({
      requestedPluginId: "lvis-plugin-p",
      eventSlug: "lvis-plugin-p",
      pluginRuntime: runtime,
      pluginMarketplace: marketplace,
    });

    expect(runtime.removePlugin).toHaveBeenCalledWith("p");
    expect(runtime.addPlugin).toHaveBeenCalledWith("p");
    expect(marketplace.getLiveCatalogVersion).not.toHaveBeenCalled();
  });

  it("rejects stale renderer expectedVersion before touching runtime or marketplace install", async () => {
    const runtime = makeRuntime(["p"]);
    const marketplace = makeMarketplace();
    marketplace.getLiveCatalogVersion.mockResolvedValue("1.0.0");

    await expect(
      installMarketplacePluginWithLifecycle({
        requestedPluginId: "p",
        expectedVersion: "2.0.0",
        pluginRuntime: runtime,
        pluginMarketplace: marketplace,
      }),
    ).rejects.toThrow("version is stale");

    expect(runtime.removePlugin).not.toHaveBeenCalled();
    expect(marketplace.install).not.toHaveBeenCalled();
    expect(marketplace.rollbackPlugin).not.toHaveBeenCalled();
    expect(marketplace.uninstall).not.toHaveBeenCalled();
    expect(marketplace.quarantinePlugin).not.toHaveBeenCalled();
  });

  it("checks expectedVersion against the live catalog instead of a stale cached lifecycle list", async () => {
    const runtime = makeRuntime(["p"]);
    const marketplace = makeMarketplace();
    marketplace.list.mockResolvedValue([
      { id: "p", slug: "lvis-plugin-p", installed: true, version: "1.0.0" },
    ]);
    marketplace.getLiveCatalogVersion.mockResolvedValue("2.0.0");
    marketplace.getInstalledVersion
      .mockResolvedValueOnce("1.0.0")
      .mockResolvedValueOnce("2.0.0");

    const result = await installMarketplacePluginWithLifecycle({
      requestedPluginId: "p",
      expectedVersion: "2.0.0",
      pluginRuntime: runtime,
      pluginMarketplace: marketplace,
    });

    expect(result).toEqual({ pluginId: "p", installed: true });
    expect(marketplace.getLiveCatalogVersion).toHaveBeenCalledWith("p");
    expect(marketplace.install).toHaveBeenCalledWith(
      "p",
      expect.any(Function),
      { networkAccessAcknowledgement: undefined },
    );
  });


  it("rolls back before starting when expectedVersion does not match installed manifest", async () => {
    const runtime = makeRuntime();
    const marketplace = makeMarketplace();
    const installed = vi.fn();
    marketplace.getInstalledVersion.mockResolvedValueOnce("1.0.0");

    await expect(
      installMarketplacePluginWithLifecycle({
        requestedPluginId: "p",
        expectedVersion: "2.0.0",
        pluginRuntime: runtime,
        pluginMarketplace: marketplace,
        emitPluginInstalled: installed,
      }),
    ).rejects.toThrow("version mismatch");

    expect(runtime.addPlugin).not.toHaveBeenCalled();
    expect(marketplace.uninstall).toHaveBeenCalledWith("p");
    expect(marketplace.rollbackPlugin).not.toHaveBeenCalled();
    expect(installed).not.toHaveBeenCalled();
  });

  it("rolls back an update and restores runtime when expectedVersion verification fails", async () => {
    const runtime = makeRuntime(["p"]);
    const marketplace = makeMarketplace();
    runtime.removePlugin.mockImplementationOnce(async (pluginId: string) => {
      runtime.dropPlugin(pluginId);
    });
    marketplace.getInstalledVersion
      .mockResolvedValueOnce("1.0.0")
      .mockResolvedValueOnce("1.5.0");

    await expect(
      installMarketplacePluginWithLifecycle({
        requestedPluginId: "p",
        expectedVersion: "2.0.0",
        pluginRuntime: runtime,
        pluginMarketplace: marketplace,
      }),
    ).rejects.toThrow("version mismatch");

    expect(marketplace.rollbackPlugin).toHaveBeenCalledWith("p");
    expect(marketplace.uninstall).not.toHaveBeenCalled();
    expect(runtime.addPlugin).toHaveBeenCalledWith("p");
  });

  it("restores runtime without rollback when expectedVersion mismatch follows a no-op install", async () => {
    const runtime = makeRuntime(["p"]);
    const marketplace = makeMarketplace();
    runtime.removePlugin.mockImplementationOnce(async (pluginId: string) => {
      runtime.dropPlugin(pluginId);
    });
    marketplace.getInstalledVersion
      .mockResolvedValueOnce("1.0.0")
      .mockResolvedValueOnce("1.0.0");

    await expect(
      installMarketplacePluginWithLifecycle({
        requestedPluginId: "p",
        expectedVersion: "2.0.0",
        pluginRuntime: runtime,
        pluginMarketplace: marketplace,
      }),
    ).rejects.toThrow("version mismatch");

    expect(marketplace.rollbackPlugin).not.toHaveBeenCalled();
    expect(marketplace.uninstall).not.toHaveBeenCalled();
    expect(marketplace.quarantinePlugin).not.toHaveBeenCalled();
    expect(runtime.addPlugin).toHaveBeenCalledWith("p");
  });

  it("quarantines a fresh install when expectedVersion cleanup fails", async () => {
    const runtime = makeRuntime();
    const marketplace = makeMarketplace();
    marketplace.getInstalledVersion.mockResolvedValueOnce("1.0.0");
    marketplace.uninstall.mockRejectedValueOnce(new Error("uninstall denied"));

    await expect(
      installMarketplacePluginWithLifecycle({
        requestedPluginId: "p",
        expectedVersion: "2.0.0",
        pluginRuntime: runtime,
        pluginMarketplace: marketplace,
      }),
    ).rejects.toThrow(/uninstall denied/);

    expect(runtime.addPlugin).not.toHaveBeenCalled();
    expect(marketplace.uninstall).toHaveBeenCalledWith("p");
    expect(marketplace.quarantinePlugin).toHaveBeenCalledWith(
      "p",
      "expectedVersion fresh-install cleanup failed: uninstall denied",
    );
  });

  it("does not restore runtime when expectedVersion rollback fails", async () => {
    const runtime = makeRuntime(["p"]);
    const marketplace = makeMarketplace();
    runtime.removePlugin.mockImplementationOnce(async (pluginId: string) => {
      runtime.dropPlugin(pluginId);
    });
    marketplace.getInstalledVersion
      .mockResolvedValueOnce("1.0.0")
      .mockResolvedValueOnce("1.5.0");
    marketplace.rollbackPlugin.mockRejectedValueOnce(new Error("rollback failed"));

    await expect(
      installMarketplacePluginWithLifecycle({
        requestedPluginId: "p",
        expectedVersion: "2.0.0",
        pluginRuntime: runtime,
        pluginMarketplace: marketplace,
      }),
    ).rejects.toThrow(/rollback failed/);

    expect(marketplace.rollbackPlugin).toHaveBeenCalledWith("p");
    expect(marketplace.quarantinePlugin).toHaveBeenCalledWith("p", "expectedVersion rollback failed: rollback failed");
    expect(marketplace.uninstall).not.toHaveBeenCalled();
    expect(runtime.addPlugin).not.toHaveBeenCalled();
  });

  it("restores the previously loaded plugin when marketplace install fails after pre-stop", async () => {
    const runtime = makeRuntime(["p"]);
    const marketplace = makeMarketplace();
    const log = { warn: vi.fn() };
    runtime.removePlugin.mockImplementationOnce(async (pluginId: string) => {
      runtime.dropPlugin(pluginId);
    });
    marketplace.install.mockRejectedValueOnce(new Error("download failed"));

    await expect(
      installMarketplacePluginWithLifecycle({
        requestedPluginId: "p",
        pluginRuntime: runtime,
        pluginMarketplace: marketplace,
        log,
      }),
    ).rejects.toThrow("download failed");

    expect(runtime.removePlugin).toHaveBeenCalledWith("p");
    expect(runtime.addPlugin).toHaveBeenCalledWith("p");
    expect(marketplace.rollbackPlugin).not.toHaveBeenCalled();
    expect(marketplace.uninstall).not.toHaveBeenCalled();
  });

  it("treats post-install start failure as an update after pre-stop", async () => {
    const runtime = makeRuntime(["p"]);
    const marketplace = makeMarketplace();
    runtime.removePlugin.mockImplementationOnce(async (pluginId: string) => {
      runtime.dropPlugin(pluginId);
    });
    runtime.addPlugin
      .mockRejectedValueOnce(new Error("start failed"))
      .mockResolvedValueOnce("started");

    await expect(
      installMarketplacePluginWithLifecycle({
        requestedPluginId: "p",
        pluginRuntime: runtime,
        pluginMarketplace: marketplace,
      }),
    ).rejects.toThrow("start failed");

    expect(marketplace.rollbackPlugin).toHaveBeenCalledWith("p");
    expect(runtime.addPlugin).toHaveBeenCalledTimes(2);
    expect(marketplace.uninstall).not.toHaveBeenCalled();
  });
});

describe("startInstalledPluginWithLifecycle", () => {
  it("waits for async dependency preparation before install success side effects", async () => {
    const order: string[] = [];
    const runtime = makeRuntime();
    runtime.addPlugin.mockImplementationOnce(async () => {
      order.push("add");
      return "preparing";
    });
    runtime.waitForPluginReady.mockImplementationOnce(async () => {
      order.push("ready");
    });
    const marketplace = makeMarketplace();

    await startInstalledPluginWithLifecycle({
      pluginId: "p",
      source: "marketplace",
      rollbackMode: "marketplace",
      pluginRuntime: runtime,
      pluginMarketplace: marketplace,
      broadcastInstallProgress: ({ phase }) => order.push(`progress:${phase}`),
      emitPluginInstalled: ({ pluginId, source }) => order.push(`installed:${pluginId}:${source}`),
      refreshPluginNotifications: () => order.push("refresh"),
    });

    expect(order).toEqual([
      "progress:restarting",
      "add",
      "progress:preparing",
      "ready",
      "installed:p:marketplace",
      "refresh",
    ]);
    expect(marketplace.uninstall).not.toHaveBeenCalled();
    expect(marketplace.rollbackPlugin).not.toHaveBeenCalled();
  });

  it("removes runtime state and uninstalls a fresh marketplace install when start fails", async () => {
    const runtime = makeRuntime();
    const marketplace = makeMarketplace();
    const log = { warn: vi.fn() };
    runtime.addPlugin.mockRejectedValueOnce(new Error("start failed"));

    await expect(
      startInstalledPluginWithLifecycle({
        pluginId: "p",
        source: "marketplace",
        rollbackMode: "marketplace",
        pluginRuntime: runtime,
        pluginMarketplace: marketplace,
        log,
      }),
    ).rejects.toThrow("start failed");

    expect(runtime.removePlugin).toHaveBeenCalledWith("p");
    expect(marketplace.uninstall).toHaveBeenCalledWith("p");
    expect(marketplace.rollbackPlugin).not.toHaveBeenCalled();
  });

  it("does not mask the original start failure when fresh uninstall cleanup fails", async () => {
    const runtime = makeRuntime();
    const marketplace = makeMarketplace();
    const log = { warn: vi.fn() };
    runtime.addPlugin.mockRejectedValueOnce(new Error("start failed"));
    marketplace.uninstall.mockRejectedValueOnce(new Error("cleanup failed"));

    await expect(
      startInstalledPluginWithLifecycle({
        pluginId: "p",
        source: "marketplace",
        rollbackMode: "marketplace",
        pluginRuntime: runtime,
        pluginMarketplace: marketplace,
        log,
      }),
    ).rejects.toThrow("start failed");

    expect(log.warn).toHaveBeenCalledWith("install rollback uninstall failed for p: cleanup failed");
  });

  it("rolls back a loaded marketplace update and restores runtime if rollback unloaded it", async () => {
    const runtime = makeRuntime(["p"]);
    const marketplace = makeMarketplace();
    runtime.addPlugin
      .mockRejectedValueOnce(new Error("restart failed"))
      .mockResolvedValueOnce("started");
    marketplace.rollbackPlugin.mockImplementationOnce(async (pluginId: string) => {
      runtime.dropPlugin(pluginId);
      return { pluginId, rolledBackTo: "1.0.0" };
    });

    await expect(
      startInstalledPluginWithLifecycle({
        pluginId: "p",
        source: "marketplace",
        rollbackMode: "marketplace",
        pluginRuntime: runtime,
        pluginMarketplace: marketplace,
      }),
    ).rejects.toThrow("restart failed");

    expect(marketplace.rollbackPlugin).toHaveBeenCalledWith("p");
    expect(runtime.addPlugin).toHaveBeenCalledTimes(2);
    expect(marketplace.uninstall).not.toHaveBeenCalled();
  });

  it("uses local install rollback for a loaded local-dev reinstall failure", async () => {
    const runtime = makeRuntime(["p"]);
    const marketplace = makeMarketplace();
    runtime.addPlugin.mockRejectedValueOnce(new Error("restart failed"));

    await expect(
      startInstalledPluginWithLifecycle({
        pluginId: "p",
        source: "local-dev",
        rollbackMode: "local-dev",
        pluginRuntime: runtime,
        pluginMarketplace: marketplace,
      }),
    ).rejects.toThrow("restart failed");

    expect(marketplace.rollbackLocalInstall).toHaveBeenCalledWith("p");
    expect(marketplace.rollbackPlugin).not.toHaveBeenCalled();
    expect(marketplace.uninstall).not.toHaveBeenCalled();
  });

  it("clears local rollback snapshots only after a local-dev start succeeds", async () => {
    const runtime = makeRuntime();
    const marketplace = makeMarketplace();
    const installed = vi.fn();

    await startInstalledPluginWithLifecycle({
      pluginId: "p",
      source: "local-dev",
      rollbackMode: "local-dev",
      pluginRuntime: runtime,
      pluginMarketplace: marketplace,
      emitPluginInstalled: installed,
    });

    expect(installed).toHaveBeenCalledWith({ pluginId: "p", source: "local-dev" });
    expect(marketplace.clearLocalInstallRollback).toHaveBeenCalledWith("p");
  });
});
