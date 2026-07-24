import { rm } from "node:fs/promises";
import path from "node:path";
import type { SettingsService } from "../data/settings-store.js";
import { listSecretKeys } from "./config-schema.js";
import type { PluginMarketplaceService } from "./marketplace.js";
import type { PluginPaths } from "./plugin-paths.js";
import type { PluginRuntime } from "./runtime.js";
import {
  drainPluginInstallLockOperations,
  withResolvedPluginInstallLocks,
} from "./install-lifecycle.js";

type WarnLogger = { warn: (message: string, ...args: unknown[]) => void };

export interface PluginUninstallLifecycleDeps {
  pluginMarketplace: Pick<PluginMarketplaceService, "uninstall">;
  pluginRuntime: Pick<
    PluginRuntime,
    | "removePlugin"
    | "removePluginWithCommit"
    | "getPluginManifest"
    | "resolvePluginId"
    | "resolvePluginInstallId"
    | "resolvePluginInstallIdIfKnown"
    | "clearConfigOverride"
    | "cancelPendingRestart"
  >;
  settingsService?: Partial<Pick<SettingsService, "deletePluginConfig" | "deletePluginSecrets">>;
  pluginPaths?: Pick<PluginPaths, "cacheRoot">;
  clearAuthPartitionService?: (partition: string) => Promise<void>;
  listPluginAuthPartitionsService?: (pluginId: string) => string[];
  forgetPluginAuthPartitionsService?: (pluginId: string) => void;
  refreshPluginNotifications?: () => void;
  emitHostEvent?: (type: "plugin.uninstalled", payload: { pluginId: string }) => void;
  log?: WarnLogger;
}

export interface PluginFailedInstallCleanupLifecycleDeps
  extends Omit<PluginUninstallLifecycleDeps, "pluginMarketplace"> {
  pluginMarketplace: Pick<
    PluginMarketplaceService,
    "clearInstallFailureDiagnostic" | "getInstalledVersion"
  >;
}

type PluginStateCleanupDeps = Omit<PluginUninstallLifecycleDeps, "pluginMarketplace">;

const RESERVED_CACHE_DIR_NAMES = new Set([
  ".tarballs",
  "marketplace-catalog",
  "verified-downloads",
]);

function isMissingPluginError(message: string): boolean {
  return message.startsWith("Plugin not found:") || message.startsWith("Plugin not installed:");
}

function safePluginPathSegment(pluginId: string): string | null {
  const normalized = pluginId.trim();
  if (!/^[A-Za-z0-9._-]+$/.test(normalized)) return null;
  if (normalized.includes("..")) return null;
  return normalized;
}

async function cleanupPluginCache(pluginId: string, cacheRoot: string): Promise<void> {
  const safeSegment = safePluginPathSegment(pluginId);
  if (!safeSegment) return;
  if (RESERVED_CACHE_DIR_NAMES.has(safeSegment)) return;
  const root = path.resolve(cacheRoot);
  const target = path.resolve(root, safeSegment);
  if (target === root || !target.startsWith(root + path.sep)) return;
  await rm(target, { recursive: true, force: true });
}

async function bestEffortCleanupPluginState(
  pluginId: string,
  deps: PluginStateCleanupDeps,
  options: { cleanupCache: boolean; secretKeys: Set<string> },
): Promise<void> {
  const failures: string[] = [];

  try {
    await deps.settingsService?.deletePluginConfig?.(pluginId);
  } catch (err) {
    failures.push(`config: ${(err as Error).message}`);
  }

  try {
    await deps.settingsService?.deletePluginSecrets?.(pluginId, options.secretKeys);
  } catch (err) {
    failures.push(`secrets: ${(err as Error).message}`);
  }

  try {
    const partitions = deps.listPluginAuthPartitionsService?.(pluginId) ?? [
      `persist:plugin-auth:${encodeURIComponent(pluginId)}`,
    ];
    for (const partition of partitions) {
      await deps.clearAuthPartitionService?.(partition);
    }
    deps.forgetPluginAuthPartitionsService?.(pluginId);
  } catch (err) {
    failures.push(`auth partition: ${(err as Error).message}`);
  }

  try {
    if (options.cleanupCache && deps.pluginPaths?.cacheRoot) {
      await cleanupPluginCache(pluginId, deps.pluginPaths.cacheRoot);
    }
  } catch (err) {
    failures.push(`cache: ${(err as Error).message}`);
  }

  if (failures.length > 0) {
    deps.log?.warn(
      `plugin uninstall residual cleanup incomplete for ${pluginId}: ${failures.join("; ")}`,
    );
  }
}

export async function uninstallPluginWithLifecycle(
  pluginId: string,
  deps: PluginUninstallLifecycleDeps,
): Promise<{ pluginId: string; uninstalled: true }> {
  const initialCanonicalPluginId = deps.pluginRuntime.resolvePluginId(pluginId);
  if (deps.pluginRuntime.resolvePluginInstallIdIfKnown(pluginId) === null) {
    throw new Error(
      `Statically configured plugin cannot be uninstalled: ${initialCanonicalPluginId}`,
    );
  }
  deps.pluginRuntime.cancelPendingRestart(initialCanonicalPluginId);
  return withResolvedPluginInstallLocks(
    () => {
      const canonicalPluginId = deps.pluginRuntime.resolvePluginId(pluginId);
      const installPluginId =
        deps.pluginRuntime.resolvePluginInstallIdIfKnown(pluginId);
      return [
        pluginId,
        canonicalPluginId,
        ...(typeof installPluginId === "string" ? [installPluginId] : []),
      ];
    },
    async () => {
    const canonicalPluginId = deps.pluginRuntime.resolvePluginId(pluginId);
    const installClaim =
      deps.pluginRuntime.resolvePluginInstallIdIfKnown(pluginId);
    if (installClaim === null) {
      throw new Error(
        `Statically configured plugin cannot be uninstalled: ${canonicalPluginId}`,
      );
    }
    const installPluginId = installClaim ?? pluginId;
    const secretKeys = listSecretKeys(
      deps.pluginRuntime.getPluginManifest(canonicalPluginId)?.configSchema,
    );
    let result: { pluginId: string; uninstalled: true } | null = null;
    let marketplaceRemoved = false;
    try {
      result = await deps.pluginRuntime.removePluginWithCommit(
        canonicalPluginId,
        () => deps.pluginMarketplace.uninstall(installPluginId),
      );
      await drainPluginInstallLockOperations(canonicalPluginId);
      marketplaceRemoved = true;
    } catch (err) {
      const message = (err as Error).message ?? "uninstall failed";
      if (!isMissingPluginError(message)) {
        throw err;
      }
    }

    deps.pluginRuntime.clearConfigOverride(canonicalPluginId);
    await bestEffortCleanupPluginState(canonicalPluginId, deps, {
      cleanupCache: marketplaceRemoved,
      secretKeys,
    });
    deps.emitHostEvent?.("plugin.uninstalled", { pluginId: canonicalPluginId });
    deps.refreshPluginNotifications?.();

    return result ?? { pluginId: canonicalPluginId, uninstalled: true as const };
    },
    (pluginIds) => {
      for (const discoveredPluginId of pluginIds) {
        deps.pluginRuntime.cancelPendingRestart(discoveredPluginId);
      }
    },
  );
}

export async function cleanupFailedPluginInstallWithLifecycle(
  pluginId: string,
  deps: PluginFailedInstallCleanupLifecycleDeps,
): Promise<{ pluginId: string; uninstalled: true }> {
  const initialCanonicalPluginId = deps.pluginRuntime.resolvePluginId(pluginId);
  deps.pluginRuntime.cancelPendingRestart(initialCanonicalPluginId);
  return withResolvedPluginInstallLocks(
    () => {
      const canonicalPluginId = deps.pluginRuntime.resolvePluginId(pluginId);
      const installPluginId =
        deps.pluginRuntime.resolvePluginInstallIdIfKnown(pluginId);
      return [
        pluginId,
        canonicalPluginId,
        ...(typeof installPluginId === "string" ? [installPluginId] : []),
      ];
    },
    async () => {
    const canonicalPluginId = deps.pluginRuntime.resolvePluginId(pluginId);
    const installPluginId =
      deps.pluginRuntime.resolvePluginInstallIdIfKnown(pluginId) ?? pluginId;
    const installedVersion =
      await deps.pluginMarketplace.getInstalledVersion(installPluginId);
    if (installedVersion !== null) {
      throw new Error(
        `Failed-install cleanup refused because plugin is installed: ${installPluginId}`,
      );
    }
    const secretKeys = listSecretKeys(
      deps.pluginRuntime.getPluginManifest(canonicalPluginId)?.configSchema,
    );
    await deps.pluginRuntime.removePlugin(canonicalPluginId);
    await drainPluginInstallLockOperations(canonicalPluginId);
    deps.pluginMarketplace.clearInstallFailureDiagnostic(pluginId);
    deps.pluginRuntime.clearConfigOverride(canonicalPluginId);
    await bestEffortCleanupPluginState(canonicalPluginId, deps, {
      cleanupCache: true,
      secretKeys,
    });
    deps.emitHostEvent?.("plugin.uninstalled", { pluginId: canonicalPluginId });
    deps.refreshPluginNotifications?.();
    return { pluginId, uninstalled: true as const };
    },
    (pluginIds) => {
      for (const discoveredPluginId of pluginIds) {
        deps.pluginRuntime.cancelPendingRestart(discoveredPluginId);
      }
    },
  );
}
