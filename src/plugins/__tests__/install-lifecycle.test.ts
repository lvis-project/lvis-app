import { describe, expect, it, vi } from "vitest";
import { startInstalledPluginWithLifecycle } from "../install-lifecycle.js";

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
    uninstall: vi.fn(async (pluginId: string) => ({ pluginId, uninstalled: true as const })),
    rollbackPlugin: vi.fn(async (pluginId: string) => ({ pluginId, rolledBackTo: "1.0.0" })),
    rollbackLocalInstall: vi.fn(async (pluginId: string) => ({ pluginId, rolledBack: true as const })),
    clearLocalInstallRollback: vi.fn(async () => {}),
  };
}

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
