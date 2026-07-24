import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uninstallPluginWithLifecycle } from "../uninstall-lifecycle.js";
import { withPluginInstallLock } from "../install-lifecycle.js";

function makeDeps(pluginId: string, cacheRoot: string, uninstallError?: Error) {
  const pluginRuntime = {
    resolvePluginId: vi.fn((requestedPluginId: string) => requestedPluginId),
    resolvePluginInstallId: vi.fn((requestedPluginId: string) => requestedPluginId),
    resolvePluginInstallIdIfKnown: vi.fn(
      (requestedPluginId: string) => requestedPluginId,
    ),
    cancelPendingRestart: vi.fn(),
    clearConfigOverride: vi.fn(),
    getPluginManifest: vi.fn(() => ({
      configSchema: {
        properties: {
          token: { type: "string", format: "secret" },
        },
      },
    })),
    removePlugin: vi.fn(async () => undefined),
    removePluginWithCommit: vi.fn(async <T>(_pluginId: string, commit: () => Promise<T>) => {
      return commit();
    }),
  };
  return {
    pluginMarketplace: {
      uninstall: vi.fn(async () => {
        if (uninstallError) throw uninstallError;
        return { pluginId, uninstalled: true as const };
      }),
    },
    pluginRuntime,
    settingsService: {
      deletePluginConfig: vi.fn(async () => undefined),
      deletePluginSecrets: vi.fn(async () => 0),
    },
    pluginPaths: { cacheRoot },
    clearAuthPartitionService: vi.fn(async () => undefined),
    listPluginAuthPartitionsService: vi.fn(() => [
      `persist:plugin-auth:${encodeURIComponent(pluginId)}`,
      `persist:plugin-auth:${encodeURIComponent(pluginId)}:tenant`,
    ]),
    forgetPluginAuthPartitionsService: vi.fn(),
    emitHostEvent: vi.fn(),
    refreshPluginNotifications: vi.fn(),
    log: { warn: vi.fn() },
  };
}

describe("uninstallPluginWithLifecycle", () => {
  it("deletes normal plugin cache and preserves shared cache directories", async () => {
    const root = mkdtempSync(join(tmpdir(), "lvis-uninstall-cache-"));
    try {
      const cacheRoot = join(root, ".cache");
      await mkdir(join(cacheRoot, "agent-hub"), { recursive: true });
      await mkdir(join(cacheRoot, "verified-downloads"), { recursive: true });
      writeFileSync(join(cacheRoot, "agent-hub", "history.json"), "{}");
      writeFileSync(join(cacheRoot, "verified-downloads", "sentinel"), "keep");

      await uninstallPluginWithLifecycle("agent-hub", makeDeps("agent-hub", cacheRoot));
      await uninstallPluginWithLifecycle(
        "verified-downloads",
        makeDeps("verified-downloads", cacheRoot),
      );

      expect(existsSync(join(cacheRoot, "agent-hub"))).toBe(false);
      expect(existsSync(join(cacheRoot, "verified-downloads", "sentinel"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips cache deletion on idempotent missing-plugin cleanup", async () => {
    const root = mkdtempSync(join(tmpdir(), "lvis-uninstall-cache-missing-"));
    try {
      const cacheRoot = join(root, ".cache");
      await mkdir(join(cacheRoot, "agent-hub"), { recursive: true });
      writeFileSync(join(cacheRoot, "agent-hub", "history.json"), "{}");

      await uninstallPluginWithLifecycle(
        "agent-hub",
        makeDeps("agent-hub", cacheRoot, new Error("Plugin not installed: agent-hub")),
      );

      expect(existsSync(join(cacheRoot, "agent-hub", "history.json"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("passes exact manifest-declared secret keys and all tracked auth partitions", async () => {
    const root = mkdtempSync(join(tmpdir(), "lvis-uninstall-state-"));
    try {
      const deps = makeDeps("com.example", join(root, ".cache"));

      await uninstallPluginWithLifecycle("com.example", deps);

      expect(deps.settingsService.deletePluginSecrets).toHaveBeenCalledWith(
        "com.example",
        new Set(["token"]),
      );
      expect(deps.clearAuthPartitionService).toHaveBeenCalledWith("persist:plugin-auth:com.example");
      expect(deps.clearAuthPartitionService).toHaveBeenCalledWith("persist:plugin-auth:com.example:tenant");
      expect(deps.forgetPluginAuthPartitionsService).toHaveBeenCalledWith("com.example");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs durable marketplace removal inside the runtime generation barrier", async () => {
    const root = mkdtempSync(join(tmpdir(), "lvis-uninstall-order-"));
    try {
      const deps = makeDeps("agent-hub", join(root, ".cache"));

      await uninstallPluginWithLifecycle("agent-hub", deps);

      const uninstallOrder = deps.pluginMarketplace.uninstall.mock.invocationCallOrder[0];
      const barrierOrder = deps.pluginRuntime.removePluginWithCommit.mock.invocationCallOrder[0];
      expect(barrierOrder).toBeLessThan(uninstallOrder);
      expect(deps.pluginRuntime.removePluginWithCommit).toHaveBeenCalledWith(
        "agent-hub",
        expect.any(Function),
      );
      expect(deps.pluginRuntime.removePlugin).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("drains detached stop-hook mutations before deleting durable plugin state", async () => {
    const root = mkdtempSync(join(tmpdir(), "lvis-uninstall-detached-"));
    try {
      const order: string[] = [];
      const deps = makeDeps("agent-hub", join(root, ".cache"));
      let releaseWrite!: () => void;
      let writeEntered!: () => void;
      const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
      const writeStarted = new Promise<void>((resolve) => { writeEntered = resolve; });
      deps.pluginRuntime.removePluginWithCommit.mockImplementationOnce(async (
        _pluginId,
        commit,
      ) => {
        void withPluginInstallLock("agent-hub", async () => {
          order.push("write:start");
          writeEntered();
          await writeGate;
          order.push("write:end");
        });
        await writeStarted;
        order.push("remove:end");
        return commit();
      });
      deps.settingsService.deletePluginConfig.mockImplementationOnce(async () => {
        order.push("config:delete");
      });

      const uninstall = uninstallPluginWithLifecycle("agent-hub", deps);
      await writeStarted;
      await Promise.resolve();
      expect(deps.settingsService.deletePluginConfig).not.toHaveBeenCalled();

      releaseWrite();
      await uninstall;
      expect(order).toEqual(["write:start", "remove:end", "write:end", "config:delete"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serializes an install alias under the canonical id and clears late config state", async () => {
    const root = mkdtempSync(join(tmpdir(), "lvis-uninstall-alias-"));
    try {
      const order: string[] = [];
      const deps = makeDeps("canonical-plugin", join(root, ".cache"));
      deps.pluginRuntime.resolvePluginId.mockReturnValue("canonical-plugin");
      deps.pluginRuntime.removePluginWithCommit.mockImplementationOnce(async (
        _pluginId,
        commit,
      ) => {
        await withPluginInstallLock("canonical-plugin", async () => {
          order.push("stop-write");
        });
        order.push("remove");
        return commit();
      });
      deps.pluginRuntime.clearConfigOverride.mockImplementationOnce(() => {
        order.push("override:clear");
      });
      deps.settingsService.deletePluginConfig.mockImplementationOnce(async () => {
        order.push("settings:clear");
      });

      await uninstallPluginWithLifecycle("marketplace-alias", deps);

      expect(deps.pluginRuntime.removePluginWithCommit).toHaveBeenCalledWith(
        "canonical-plugin",
        expect.any(Function),
      );
      expect(deps.pluginMarketplace.uninstall).toHaveBeenCalledWith("marketplace-alias");
      expect(deps.pluginRuntime.clearConfigOverride).toHaveBeenCalledWith("canonical-plugin");
      expect(order).toEqual([
        "stop-write",
        "remove",
        "override:clear",
        "settings:clear",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves the active generation after EACCES and completes cleanup on retry", async () => {
    const root = mkdtempSync(join(tmpdir(), "lvis-uninstall-restore-"));
    try {
      const failure = Object.assign(new Error("locked by Windows handle"), { code: "EACCES" });
      const deps = makeDeps("agent-hub", join(root, ".cache"));
      deps.pluginMarketplace.uninstall
        .mockRejectedValueOnce(failure)
        .mockResolvedValueOnce({ pluginId: "agent-hub", uninstalled: true as const });

      await expect(uninstallPluginWithLifecycle("agent-hub", deps)).rejects.toBe(failure);

      expect(deps.pluginRuntime.removePluginWithCommit).toHaveBeenCalledTimes(1);
      expect(deps.pluginRuntime.removePlugin).not.toHaveBeenCalled();
      expect(deps.settingsService.deletePluginConfig).not.toHaveBeenCalled();
      expect(deps.emitHostEvent).not.toHaveBeenCalled();

      await expect(uninstallPluginWithLifecycle("agent-hub", deps)).resolves.toEqual({
        pluginId: "agent-hub",
        uninstalled: true,
      });
      expect(deps.pluginRuntime.removePluginWithCommit).toHaveBeenCalledTimes(2);
      expect(deps.settingsService.deletePluginConfig).toHaveBeenCalledWith("agent-hub");
      expect(deps.emitHostEvent).toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves the original durable uninstall failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "lvis-uninstall-fail-"));
    try {
      const uninstallFailure = new Error("uninstall failed");
      const deps = makeDeps("agent-hub", join(root, ".cache"), uninstallFailure);

      const error = await uninstallPluginWithLifecycle("agent-hub", deps).catch((caught) => caught);
      expect(error).toBe(uninstallFailure);
      expect(deps.pluginRuntime.removePlugin).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
