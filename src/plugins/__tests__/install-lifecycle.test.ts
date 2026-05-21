import { describe, expect, it, vi } from "vitest";
import {
  installMarketplacePluginWithLifecycle,
  startInstalledPluginWithLifecycle,
} from "../install-lifecycle.js";

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
      { id: "p", slug: "lvis-plugin-p" },
      { id: "meeting", slug: "lvis-plugin-meeting" },
    ]),
    install: vi.fn(async (pluginId: string) => ({ pluginId, installed: true as const })),
    uninstall: vi.fn(async (pluginId: string) => ({ pluginId, uninstalled: true as const })),
    rollbackPlugin: vi.fn(async (pluginId: string) => ({ pluginId, rolledBackTo: "1.0.0" })),
    rollbackLocalInstall: vi.fn(async (pluginId: string) => ({ pluginId, rolledBack: true as const })),
    clearLocalInstallRollback: vi.fn(async () => {}),
  };
}

describe("installMarketplacePluginWithLifecycle", () => {
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

  it("pre-stops an installed plugin even when it is not currently loaded", async () => {
    const runtime = makeRuntime();
    const marketplace = makeMarketplace();
    marketplace.list.mockResolvedValueOnce([{ id: "p", slug: "lvis-plugin-p", installed: true }]);

    await installMarketplacePluginWithLifecycle({
      requestedPluginId: "lvis-plugin-p",
      eventSlug: "lvis-plugin-p",
      pluginRuntime: runtime,
      pluginMarketplace: marketplace,
    });

    expect(runtime.removePlugin).toHaveBeenCalledWith("p");
    expect(runtime.addPlugin).toHaveBeenCalledWith("p");
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
