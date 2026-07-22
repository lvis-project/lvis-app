import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uninstallPluginWithLifecycle } from "../uninstall-lifecycle.js";

function makeDeps(pluginId: string, cacheRoot: string, uninstallError?: Error) {
  return {
    pluginMarketplace: {
      uninstall: vi.fn(async () => {
        if (uninstallError) throw uninstallError;
        return { pluginId, uninstalled: true as const };
      }),
    },
    pluginRuntime: {
      getPluginManifest: vi.fn(() => ({
        configSchema: {
          properties: {
            token: { type: "string", format: "secret" },
          },
        },
      })),
      addPlugin: vi.fn(async () => "started" as const),
      removePlugin: vi.fn(async () => undefined),
    },
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

  it("removes runtime before marketplace files to let plugins release handles", async () => {
    const root = mkdtempSync(join(tmpdir(), "lvis-uninstall-order-"));
    try {
      const deps = makeDeps("agent-hub", join(root, ".cache"));

      await uninstallPluginWithLifecycle("agent-hub", deps);

      const removeOrder = deps.pluginRuntime.removePlugin.mock.invocationCallOrder[0];
      const uninstallOrder = deps.pluginMarketplace.uninstall.mock.invocationCallOrder[0];
      expect(removeOrder).toBeLessThan(uninstallOrder);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("restores runtime before surfacing a durable uninstall failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "lvis-uninstall-restore-"));
    try {
      const failure = Object.assign(new Error("locked by Windows handle"), { code: "EACCES" });
      const deps = makeDeps("agent-hub", join(root, ".cache"), failure);

      await expect(uninstallPluginWithLifecycle("agent-hub", deps)).rejects.toBe(failure);

      expect(deps.pluginRuntime.addPlugin).toHaveBeenCalledWith("agent-hub");
      expect(deps.pluginRuntime.removePlugin.mock.invocationCallOrder[0])
        .toBeLessThan(deps.pluginMarketplace.uninstall.mock.invocationCallOrder[0]);
      expect(deps.pluginMarketplace.uninstall.mock.invocationCallOrder[0])
        .toBeLessThan(deps.pluginRuntime.addPlugin.mock.invocationCallOrder[0]);
      expect(deps.settingsService.deletePluginConfig).not.toHaveBeenCalled();
      expect(deps.emitHostEvent).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves uninstall and runtime restore failures", async () => {
    const root = mkdtempSync(join(tmpdir(), "lvis-uninstall-restore-fail-"));
    try {
      const uninstallFailure = new Error("uninstall failed");
      const restoreFailure = new Error("runtime restore failed");
      const deps = makeDeps("agent-hub", join(root, ".cache"), uninstallFailure);
      deps.pluginRuntime.addPlugin.mockRejectedValueOnce(restoreFailure);

      const error = await uninstallPluginWithLifecycle("agent-hub", deps).catch((caught) => caught);
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([uninstallFailure, restoreFailure]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
