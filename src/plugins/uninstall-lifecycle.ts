import { rm } from "node:fs/promises";
import path from "node:path";
import type { SettingsService } from "../data/settings-store.js";
import { listSecretKeys } from "./config-schema.js";
import type { PluginMarketplaceService } from "./marketplace.js";
import type { PluginPaths } from "./plugin-paths.js";
import type { PluginRuntime } from "./runtime.js";
import {
  withResolvedPluginInstallLocks,
} from "./install-lifecycle.js";
import {
  PluginUninstallCleanupJournal,
  pluginUninstallCleanupJournalPath,
  type PluginUninstallCleanupPhase,
  type PluginUninstallCleanupRecord,
} from "./plugin-uninstall-cleanup-journal.js";

type WarnLogger = { warn: (message: string, ...args: unknown[]) => void };

export interface PluginUninstallLifecycleDeps {
  pluginMarketplace: Pick<
    PluginMarketplaceService,
    "uninstall" | "getInstalledVersion"
  > & Partial<
    Pick<PluginMarketplaceService, "clearInstallFailureDiagnostic">
  >;
  pluginRuntime: Pick<
    PluginRuntime,
    | "removePlugin"
    | "removePluginWithCommit"
    | "getPluginManifest"
    | "resolvePluginId"
    | "resolvePluginInstallIdIfKnown"
    | "clearConfigOverride"
    | "cancelPendingRestart"
  >;
  settingsService: Pick<
    SettingsService,
    "deletePluginConfig" | "deletePluginSecrets"
  >;
  pluginPaths: Pick<PluginPaths, "cacheRoot">;
  clearAuthPartitionService: (partition: string) => Promise<void>;
  listPluginAuthPartitionsService: (pluginId: string) => string[];
  forgetPluginAuthPartitionsService: (pluginId: string) => void | Promise<void>;
  drainPluginInstallLockOperationsService: (pluginId: string) => Promise<void>;
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
type RequiredPluginStateCleanupDeps = PluginStateCleanupDeps & {
  settingsService: Pick<
    SettingsService,
    "deletePluginConfig" | "deletePluginSecrets"
  >;
  pluginPaths: Pick<PluginPaths, "cacheRoot">;
  clearAuthPartitionService: (partition: string) => Promise<void>;
  listPluginAuthPartitionsService: (pluginId: string) => string[];
  forgetPluginAuthPartitionsService: (pluginId: string) => void | Promise<void>;
  drainPluginInstallLockOperationsService: (pluginId: string) => Promise<void>;
};
const cleanupJournals = new Map<string, PluginUninstallCleanupJournal>();

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

async function cleanupRecordedPluginCaches(
  record: PluginUninstallCleanupRecord,
  cacheRoot: string,
): Promise<void> {
  for (const pluginId of new Set([
    record.pluginId,
    record.installPluginId,
  ])) {
    await cleanupPluginCache(pluginId, cacheRoot);
  }
}

function requirePluginStateCleanupDeps(
  deps: PluginStateCleanupDeps,
): RequiredPluginStateCleanupDeps {
  if (
    !deps.settingsService?.deletePluginConfig
    || !deps.settingsService.deletePluginSecrets
    || !deps.pluginPaths?.cacheRoot
    || !deps.clearAuthPartitionService
    || !deps.listPluginAuthPartitionsService
    || !deps.forgetPluginAuthPartitionsService
    || !deps.drainPluginInstallLockOperationsService
  ) {
    throw new Error("plugin uninstall cleanup services are not fully wired");
  }
  return deps as RequiredPluginStateCleanupDeps;
}

function cleanupJournal(
  deps: RequiredPluginStateCleanupDeps,
): PluginUninstallCleanupJournal {
  const path = pluginUninstallCleanupJournalPath(deps.pluginPaths.cacheRoot);
  const existing = cleanupJournals.get(path);
  if (existing) return existing;
  const journal = new PluginUninstallCleanupJournal(path);
  cleanupJournals.set(path, journal);
  return journal;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function cleanupRecordedPluginState(
  record: PluginUninstallCleanupRecord,
  deps: RequiredPluginStateCleanupDeps,
  journal: PluginUninstallCleanupJournal,
): Promise<void> {
  const failures: Error[] = [];
  journal.beginAttempt(record.pluginId);

  const attemptPhase = async (
    phase: PluginUninstallCleanupPhase,
    operation: () => void | Promise<void>,
  ): Promise<void> => {
    const current = journal.find(record.pluginId);
    if (!current || current.completedPhases.includes(phase)) return;
    try {
      await operation();
      journal.completePhase(record.pluginId, phase);
    } catch (error) {
      failures.push(
        new Error(`${phase}: ${errorMessage(error)}`, { cause: error }),
      );
    }
  };

  await attemptPhase("config", () =>
    deps.settingsService.deletePluginConfig(record.pluginId));
  await attemptPhase("secrets", () => {
    const current = journal.find(record.pluginId) ?? record;
    return deps.settingsService.deletePluginSecrets(
      record.pluginId,
      new Set(current.secretKeys),
    ).then(() => undefined);
  });

  const authRecord = journal.find(record.pluginId) ?? record;
  for (const partition of authRecord.authPartitions) {
    const current = journal.find(record.pluginId);
    if (current?.completedAuthPartitions.includes(partition)) continue;
    try {
      await deps.clearAuthPartitionService(partition);
      journal.completeAuthPartition(record.pluginId, partition);
    } catch (error) {
      failures.push(
        new Error(
          `auth partition '${partition}': ${errorMessage(error)}`,
          { cause: error },
        ),
      );
    }
  }

  const afterPartitions = journal.find(record.pluginId);
  const allAuthPartitionsComplete = afterPartitions?.authPartitions.every(
    (partition) =>
      afterPartitions?.completedAuthPartitions.includes(partition) === true,
  ) === true;
  if (allAuthPartitionsComplete) {
    await attemptPhase("auth-tracker", () =>
      deps.forgetPluginAuthPartitionsService(record.pluginId));
  }

  if (record.cleanupCache) {
    await attemptPhase("cache", () =>
      cleanupRecordedPluginCaches(record, deps.pluginPaths.cacheRoot));
  } else {
    journal.completePhase(record.pluginId, "cache");
  }

  if (failures.length > 0) {
    deps.log?.warn(
      `plugin uninstall residual cleanup pending for ${record.pluginId}: ${failures
        .map((failure) => failure.message)
        .join("; ")}`,
    );
    throw new AggregateError(
      failures,
      `plugin uninstall cleanup pending: ${record.pluginId}`,
    );
  }
  journal.complete(record.pluginId);
}

async function finishCommittedPluginCleanup(
  record: PluginUninstallCleanupRecord,
  deps: RequiredPluginStateCleanupDeps,
  journal: PluginUninstallCleanupJournal,
  options: {
    drainRuntimeOperations: boolean;
    assumeRuntimeQuiescent: boolean;
    cleanupCache?: boolean;
  },
): Promise<void> {
  journal.markRegistryRemovalCommitted(record.pluginId, {
    cleanupCache: options.cleanupCache,
  });
  if (options.assumeRuntimeQuiescent) {
    journal.markRuntimeRetirementComplete(record.pluginId);
  }
  if (!journal.find(record.pluginId)?.runtimeRetirementComplete) {
    throw new Error(
      `plugin runtime retirement cleanup is pending: ${record.pluginId}`,
    );
  }
  if (options.drainRuntimeOperations) {
    await deps.drainPluginInstallLockOperationsService(record.pluginId);
  }
  const merged = journal.mergeAuthPartitions(
    record.pluginId,
    deps.listPluginAuthPartitionsService(record.pluginId),
  );
  deps.pluginRuntime.clearConfigOverride(record.pluginId);
  await cleanupRecordedPluginState(merged, deps, journal);
}

async function reconcilePendingPluginCleanup(
  record: PluginUninstallCleanupRecord,
  deps: RequiredPluginStateCleanupDeps & {
    pluginMarketplace: Pick<PluginMarketplaceService, "getInstalledVersion">;
  },
  journal: PluginUninstallCleanupJournal,
  options: {
    drainRuntimeOperations: boolean;
    assumeRuntimeQuiescent: boolean;
  },
): Promise<"cancelled" | "completed"> {
  const installedVersion =
    await deps.pluginMarketplace.getInstalledVersion(record.installPluginId);
  if (installedVersion !== null) {
    if (record.registryRemovalCommitted) {
      throw new Error(
        `Plugin install is blocked by committed uninstall cleanup: ${record.pluginId}`,
      );
    }
    journal.cancel(record.pluginId);
    return "cancelled";
  }
  await finishCommittedPluginCleanup(record, deps, journal, options);
  return "completed";
}

export async function recoverPendingPluginUninstallCleanups(
  deps: PluginUninstallLifecycleDeps,
): Promise<readonly string[]> {
  const cleanupDeps = requirePluginStateCleanupDeps(deps);
  const journal = cleanupJournal(cleanupDeps);
  const unresolved: string[] = [];

  for (const record of journal.list()) {
    try {
      const outcome = await reconcilePendingPluginCleanup(
        record,
        {
          ...cleanupDeps,
          pluginMarketplace: deps.pluginMarketplace,
        },
        journal,
        {
          drainRuntimeOperations: false,
          assumeRuntimeQuiescent: true,
        },
      );
      if (outcome === "cancelled") continue;
      deps.pluginMarketplace.clearInstallFailureDiagnostic?.(
        record.installPluginId,
      );
      deps.emitHostEvent?.("plugin.uninstalled", {
        pluginId: record.pluginId,
      });
      deps.refreshPluginNotifications?.();
    } catch (error) {
      unresolved.push(record.pluginId);
      deps.log?.warn(
        `plugin uninstall cleanup recovery remains unresolved for ${record.pluginId}: ${errorMessage(error)}`,
      );
    }
  }

  return Object.freeze(unresolved);
}

/**
 * Runs inside the marketplace install lock. A removed plugin may not be
 * reinstalled until every Host-owned residual-state checkpoint is complete.
 */
export async function ensurePluginStateReadyForInstall(
  pluginId: string,
  deps: PluginUninstallLifecycleDeps,
): Promise<void> {
  const cleanupDeps = requirePluginStateCleanupDeps(deps);
  const journal = cleanupJournal(cleanupDeps);
  const record = journal.find(pluginId);
  if (!record) return;
  const outcome = await reconcilePendingPluginCleanup(
    record,
    {
      ...cleanupDeps,
      pluginMarketplace: deps.pluginMarketplace,
    },
    journal,
    {
      drainRuntimeOperations: true,
      assumeRuntimeQuiescent: false,
    },
  );
  if (outcome === "completed") {
    deps.pluginMarketplace.clearInstallFailureDiagnostic?.(
      record.installPluginId,
    );
    deps.emitHostEvent?.("plugin.uninstalled", { pluginId: record.pluginId });
    deps.refreshPluginNotifications?.();
  }
}

export async function uninstallPluginWithLifecycle(
  pluginId: string,
  deps: PluginUninstallLifecycleDeps,
): Promise<{ pluginId: string; uninstalled: true }> {
  const cleanupDeps = requirePluginStateCleanupDeps(deps);
  const journal = cleanupJournal(cleanupDeps);
  const initialPendingCleanup = journal.find(pluginId);
  const initialCanonicalPluginId = deps.pluginRuntime.resolvePluginId(pluginId);
  if (
    !initialPendingCleanup
    && deps.pluginRuntime.resolvePluginInstallIdIfKnown(pluginId) === null
  ) {
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
      const pendingCleanup =
        journal.find(pluginId) ?? journal.find(canonicalPluginId);
      return [
        pluginId,
        canonicalPluginId,
        ...(typeof installPluginId === "string" ? [installPluginId] : []),
        ...(pendingCleanup
          ? [pendingCleanup.pluginId, pendingCleanup.installPluginId]
          : []),
      ];
    },
    async () => {
    const canonicalPluginId = deps.pluginRuntime.resolvePluginId(pluginId);
    const pendingCleanup =
      journal.find(pluginId) ?? journal.find(canonicalPluginId);
    if (pendingCleanup) {
      const outcome = await reconcilePendingPluginCleanup(
        pendingCleanup,
        {
          ...cleanupDeps,
          pluginMarketplace: deps.pluginMarketplace,
        },
        journal,
        {
          drainRuntimeOperations: true,
          assumeRuntimeQuiescent: false,
        },
      );
      if (outcome === "completed") {
        deps.emitHostEvent?.("plugin.uninstalled", {
          pluginId: pendingCleanup.pluginId,
        });
        deps.refreshPluginNotifications?.();
        return {
          pluginId: pendingCleanup.pluginId,
          uninstalled: true as const,
        };
      }
    }
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
    const authPartitions =
      cleanupDeps.listPluginAuthPartitionsService(canonicalPluginId);
    const installedVersion =
      await deps.pluginMarketplace.getInstalledVersion(installPluginId);
    const cleanupRecord = journal.prepare({
      pluginId: canonicalPluginId,
      installPluginId,
      secretKeys: [...secretKeys],
      authPartitions,
      cleanupCache: installedVersion !== null,
    });
    let marketplaceRemoved = false;
    let durableCommitCompleted = false;
    let result!: { pluginId: string; uninstalled: true };
    let removalError: unknown;
    try {
      result = await deps.pluginRuntime.removePluginWithCommit(
        canonicalPluginId,
        async () => {
          try {
            result = await deps.pluginMarketplace.uninstall(installPluginId);
            marketplaceRemoved = true;
          } catch (err) {
            const message = errorMessage(err) || "uninstall failed";
            if (!isMissingPluginError(message)) throw err;
            result = {
              pluginId: canonicalPluginId,
              uninstalled: true as const,
            };
          }
          durableCommitCompleted = true;
          journal.markRegistryRemovalCommitted(canonicalPluginId, {
            cleanupCache: marketplaceRemoved,
          });
          return result;
        },
      );
      journal.markRuntimeRetirementComplete(canonicalPluginId);
    } catch (error) {
      if (!durableCommitCompleted) {
        journal.cancel(canonicalPluginId);
        throw error;
      }
      removalError = error;
    }

    if (removalError !== undefined) {
      throw new AggregateError(
        [removalError],
        `plugin uninstall committed with pending runtime retirement: ${canonicalPluginId}`,
      );
    }

    const postCommitErrors: unknown[] = [];
    let cleanupCompleted = false;
    try {
      await finishCommittedPluginCleanup(
        cleanupRecord,
        cleanupDeps,
        journal,
        {
          drainRuntimeOperations: true,
          assumeRuntimeQuiescent: false,
          cleanupCache: marketplaceRemoved,
        },
      );
      cleanupCompleted = true;
    } catch (error) {
      postCommitErrors.push(error);
    }
    if (cleanupCompleted) {
      deps.emitHostEvent?.("plugin.uninstalled", { pluginId: canonicalPluginId });
      deps.refreshPluginNotifications?.();
    }

    if (postCommitErrors.length > 0) {
      throw new AggregateError(
        postCommitErrors,
        `plugin uninstall committed with incomplete post-commit cleanup: ${canonicalPluginId}`,
      );
    }

    return result;
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
  const cleanupDeps = requirePluginStateCleanupDeps(deps);
  const journal = cleanupJournal(cleanupDeps);
  const initialCanonicalPluginId = deps.pluginRuntime.resolvePluginId(pluginId);
  deps.pluginRuntime.cancelPendingRestart(initialCanonicalPluginId);
  return withResolvedPluginInstallLocks(
    () => {
      const canonicalPluginId = deps.pluginRuntime.resolvePluginId(pluginId);
      const installPluginId =
        deps.pluginRuntime.resolvePluginInstallIdIfKnown(pluginId);
      const pendingCleanup =
        journal.find(pluginId) ?? journal.find(canonicalPluginId);
      return [
        pluginId,
        canonicalPluginId,
        ...(typeof installPluginId === "string" ? [installPluginId] : []),
        ...(pendingCleanup
          ? [pendingCleanup.pluginId, pendingCleanup.installPluginId]
          : []),
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
    const pendingRecord =
      journal.find(pluginId) ?? journal.find(canonicalPluginId);
    if (pendingRecord) {
      const outcome = await reconcilePendingPluginCleanup(
        pendingRecord,
        {
          ...cleanupDeps,
          pluginMarketplace: deps.pluginMarketplace,
        },
        journal,
        {
          drainRuntimeOperations: true,
          assumeRuntimeQuiescent: false,
        },
      );
      if (outcome === "cancelled") {
        throw new Error(
          `Failed-install cleanup lost marketplace absence: ${installPluginId}`,
        );
      }
      deps.pluginMarketplace.clearInstallFailureDiagnostic(pluginId);
      deps.emitHostEvent?.("plugin.uninstalled", {
        pluginId: pendingRecord.pluginId,
      });
      deps.refreshPluginNotifications?.();
      return { pluginId, uninstalled: true as const };
    }
    const secretKeys = listSecretKeys(
      deps.pluginRuntime.getPluginManifest(canonicalPluginId)?.configSchema,
    );
    const record = journal.prepare({
      pluginId: canonicalPluginId,
      installPluginId,
      secretKeys: [...secretKeys],
      authPartitions:
        cleanupDeps.listPluginAuthPartitionsService(canonicalPluginId),
      cleanupCache: true,
    });
    journal.markRegistryRemovalCommitted(record.pluginId, {
      cleanupCache: true,
    });
    let removalError: unknown;
    try {
      await deps.pluginRuntime.removePlugin(canonicalPluginId);
      journal.markRuntimeRetirementComplete(canonicalPluginId);
    } catch (error) {
      removalError = error;
    }
    if (removalError !== undefined) {
      throw new AggregateError(
        [removalError],
        `failed-install removal committed with pending runtime retirement: ${canonicalPluginId}`,
      );
    }
    let cleanupError: unknown;
    try {
      await finishCommittedPluginCleanup(
        record,
        cleanupDeps,
        journal,
        {
          drainRuntimeOperations: true,
          assumeRuntimeQuiescent: false,
          cleanupCache: true,
        },
      );
    } catch (error) {
      cleanupError = error;
    }
    if (cleanupError !== undefined) {
      throw new AggregateError(
        [cleanupError],
        `failed-install removal committed with incomplete cleanup: ${canonicalPluginId}`,
      );
    }
    deps.pluginMarketplace.clearInstallFailureDiagnostic(pluginId);
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
