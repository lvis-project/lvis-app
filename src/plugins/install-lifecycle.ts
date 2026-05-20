const inflightInstallLocks = new Map<string, Promise<unknown>>();

type InstalledPluginStartState = "started" | "preparing";

type InstallProgressPhase = "restarting" | "preparing";

interface PluginInstallRuntime {
  listPluginIds(): string[];
  addPlugin(pluginId: string): Promise<InstalledPluginStartState>;
  waitForPluginReady(pluginId: string): Promise<void>;
  removePlugin(pluginId: string): Promise<void>;
}

interface PluginInstallMarketplace {
  uninstall(pluginId: string): Promise<unknown>;
  rollbackPlugin(pluginId: string): Promise<unknown>;
  rollbackLocalInstall?(pluginId: string): Promise<unknown>;
  clearLocalInstallRollback?(pluginId: string): Promise<unknown>;
}

interface InstallLifecycleLogger {
  warn(message: string): void;
}

/**
 * Per-pluginId in-flight install mutex. Serializes the full install ->
 * addPlugin -> rollback-if-needed sequence for a plugin across IPC and
 * protocol install paths.
 */
export async function withPluginInstallLock<T>(
  pluginId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = inflightInstallLocks.get(pluginId) ?? Promise.resolve();
  let release: () => void = () => {};
  const next = new Promise<void>((resolveNext) => {
    release = resolveNext;
  });
  const tail = prev.then(() => next);
  inflightInstallLocks.set(pluginId, tail);
  try {
    await prev;
    return await fn();
  } finally {
    release();
    if (inflightInstallLocks.get(pluginId) === tail) {
      inflightInstallLocks.delete(pluginId);
    }
  }
}

export async function startInstalledPluginWithLifecycle(options: {
  pluginId: string;
  source: "marketplace" | "local-dev";
  rollbackMode: "marketplace" | "local-dev";
  pluginRuntime: PluginInstallRuntime;
  pluginMarketplace: PluginInstallMarketplace;
  broadcastInstallProgress?: (payload: { slug: string; phase: InstallProgressPhase }) => void;
  emitPluginInstalled?: (payload: { pluginId: string; source: "marketplace" | "local-dev" }) => void;
  refreshPluginNotifications?: () => void;
  log?: InstallLifecycleLogger;
}): Promise<void> {
  const {
    pluginId,
    source,
    rollbackMode,
    pluginRuntime,
    pluginMarketplace,
    broadcastInstallProgress,
    emitPluginInstalled,
    refreshPluginNotifications,
    log,
  } = options;
  const wasLoadedBeforeStart = pluginRuntime.listPluginIds().includes(pluginId);
  try {
    broadcastInstallProgress?.({ slug: pluginId, phase: "restarting" });
    const startState = await pluginRuntime.addPlugin(pluginId);
    if (startState === "preparing") {
      broadcastInstallProgress?.({ slug: pluginId, phase: "preparing" });
      await pluginRuntime.waitForPluginReady(pluginId);
    }
  } catch (err) {
    await rollbackFailedPluginStart({
      pluginId,
      rollbackMode,
      wasLoadedBeforeStart,
      pluginRuntime,
      pluginMarketplace,
      log,
    });
    throw err;
  }
  emitPluginInstalled?.({ pluginId, source });
  refreshPluginNotifications?.();
  if (rollbackMode === "local-dev") {
    await pluginMarketplace.clearLocalInstallRollback?.(pluginId).catch((cleanupErr) => {
      log?.warn(`install-local rollback snapshot cleanup failed for ${pluginId}: ${errorMessage(cleanupErr)}`);
    });
  }
}

async function rollbackFailedPluginStart(options: {
  pluginId: string;
  rollbackMode: "marketplace" | "local-dev";
  wasLoadedBeforeStart: boolean;
  pluginRuntime: PluginInstallRuntime;
  pluginMarketplace: PluginInstallMarketplace;
  log?: InstallLifecycleLogger;
}): Promise<void> {
  const {
    pluginId,
    rollbackMode,
    wasLoadedBeforeStart,
    pluginRuntime,
    pluginMarketplace,
    log,
  } = options;
  if (wasLoadedBeforeStart) {
    if (rollbackMode === "local-dev") {
      await pluginMarketplace.rollbackLocalInstall?.(pluginId).catch((rollbackErr) => {
        log?.warn(`install-local update rollback failed for ${pluginId}: ${errorMessage(rollbackErr)}`);
      });
      return;
    }
    await pluginMarketplace.rollbackPlugin(pluginId).catch((rollbackErr) => {
      log?.warn(`install update rollbackPlugin failed for ${pluginId}: ${errorMessage(rollbackErr)}`);
    });
    if (!pluginRuntime.listPluginIds().includes(pluginId)) {
      await pluginRuntime.addPlugin(pluginId).catch((restoreErr) => {
        log?.warn(`install update rollback runtime restore failed for ${pluginId}: ${errorMessage(restoreErr)}`);
      });
    }
    return;
  }

  await pluginRuntime.removePlugin(pluginId).catch((rmPluginErr) => {
    log?.warn(`install rollback removePlugin failed for ${pluginId}: ${errorMessage(rmPluginErr)}`);
  });
  await pluginMarketplace.uninstall(pluginId).catch((uninstallErr) => {
    log?.warn(`install rollback uninstall failed for ${pluginId}: ${errorMessage(uninstallErr)}`);
  });
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
