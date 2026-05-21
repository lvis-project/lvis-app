const inflightInstallLocks = new Map<string, Promise<unknown>>();

type InstalledPluginStartState = "started" | "preparing";

type RuntimeInstallProgressPhase = "restarting" | "preparing";
type MarketplaceInstallProgressPhase = "installing" | "restarting" | "verifying" | "registering" | "preparing";
type MarketplaceInstallerProgressEvent =
  | { phase: "downloading"; bytesDownloaded: number; bytesTotal: number | null }
  | { phase: "verifying" | "registering" };
type MarketplaceInstallProgressPayload =
  | { slug: string; phase: MarketplaceInstallProgressPhase }
  | { slug: string; phase: "downloading"; bytesDownloaded: number; bytesTotal: number | null };
type MarketplaceLifecycleCatalogItem = { id: string; slug?: string; installed?: boolean };

interface PluginInstallRuntime {
  listPluginIds(): string[];
  addPlugin(pluginId: string): Promise<InstalledPluginStartState>;
  waitForPluginReady(pluginId: string): Promise<void>;
  removePlugin(pluginId: string): Promise<void>;
}

interface PluginLifecycleMarketplace {
  uninstall(pluginId: string): Promise<unknown>;
  rollbackPlugin(pluginId: string): Promise<unknown>;
  rollbackLocalInstall?(pluginId: string): Promise<unknown>;
  clearLocalInstallRollback?(pluginId: string): Promise<unknown>;
}

interface PluginInstallMarketplace extends PluginLifecycleMarketplace {
  list(): Promise<MarketplaceLifecycleCatalogItem[]>;
  install(
    pluginId: string,
    onProgress?: (event: MarketplaceInstallerProgressEvent) => void,
  ): Promise<{ pluginId: string; installed: true }>;
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

export async function installMarketplacePluginWithLifecycle(options: {
  requestedPluginId: string;
  eventSlug?: string;
  lifecyclePluginId?: string;
  pluginRuntime: PluginInstallRuntime;
  pluginMarketplace: PluginInstallMarketplace;
  broadcastInstallProgress?: (payload: MarketplaceInstallProgressPayload) => void;
  emitPluginInstalled?: (payload: { pluginId: string; source: "marketplace" }) => void;
  refreshPluginNotifications?: () => void;
  log?: InstallLifecycleLogger;
}): Promise<{ pluginId: string; installed: true }> {
  const {
    requestedPluginId,
    eventSlug,
    lifecyclePluginId,
    pluginRuntime,
    pluginMarketplace,
    broadcastInstallProgress,
    emitPluginInstalled,
    refreshPluginNotifications,
    log,
  } = options;
  const catalogState = await resolveMarketplaceLifecycleState(pluginMarketplace, requestedPluginId);
  const resolvedLifecyclePluginId = lifecyclePluginId ?? catalogState.pluginId;
  const progressSlug = eventSlug ?? resolvedLifecyclePluginId;

  return withPluginInstallLock(resolvedLifecyclePluginId, async () => {
    const hadExistingInstall =
      catalogState.installed === true ||
      pluginRuntime.listPluginIds().includes(resolvedLifecyclePluginId);
    let restorePluginId = resolvedLifecyclePluginId;
    let startLifecycleAttempted = false;
    try {
      if (hadExistingInstall) {
        broadcastInstallProgress?.({ slug: progressSlug, phase: "restarting" });
        await pluginRuntime.removePlugin(resolvedLifecyclePluginId);
      }

      broadcastInstallProgress?.({ slug: progressSlug, phase: "installing" });
      const result = await pluginMarketplace.install(requestedPluginId, (evt) => {
        if (evt.phase === "downloading") {
          broadcastInstallProgress?.({
            slug: progressSlug,
            phase: "downloading",
            bytesDownloaded: evt.bytesDownloaded,
            bytesTotal: evt.bytesTotal,
          });
        } else {
          broadcastInstallProgress?.({ slug: progressSlug, phase: evt.phase });
        }
      });
      const installedPluginId = result.pluginId === requestedPluginId ? resolvedLifecyclePluginId : result.pluginId;
      restorePluginId = installedPluginId;
      startLifecycleAttempted = true;
      await startInstalledPluginWithLifecycle({
        pluginId: installedPluginId,
        source: "marketplace",
        rollbackMode: "marketplace",
        wasLoadedBeforeStart: hadExistingInstall,
        pluginRuntime,
        pluginMarketplace,
        broadcastInstallProgress: (payload) =>
          broadcastInstallProgress?.({ ...payload, slug: progressSlug }),
        emitPluginInstalled: emitPluginInstalled
          ? (payload) => emitPluginInstalled({ pluginId: payload.pluginId, source: "marketplace" })
          : undefined,
        refreshPluginNotifications,
        log,
      });
      return { ...result, pluginId: installedPluginId };
    } catch (err) {
      if (
        hadExistingInstall &&
        !startLifecycleAttempted &&
        !pluginRuntime.listPluginIds().includes(restorePluginId)
      ) {
        await restoreRuntimePlugin({
          pluginRuntime,
          pluginId: restorePluginId,
          log,
          context: "install update runtime restore",
        });
      }
      throw err;
    }
  });
}

async function resolveMarketplaceLifecycleState(
  pluginMarketplace: Pick<PluginInstallMarketplace, "list">,
  requestedPluginId: string,
): Promise<{ pluginId: string; installed: boolean | undefined }> {
  const catalogItems = await pluginMarketplace.list();
  const item = catalogItems.find((candidate) => candidate.id === requestedPluginId || candidate.slug === requestedPluginId);
  return {
    pluginId: item?.id ?? requestedPluginId,
    installed: item?.installed,
  };
}

export async function startInstalledPluginWithLifecycle(options: {
  pluginId: string;
  source: "marketplace" | "local-dev";
  rollbackMode: "marketplace" | "local-dev";
  wasLoadedBeforeStart?: boolean;
  pluginRuntime: PluginInstallRuntime;
  pluginMarketplace: PluginLifecycleMarketplace;
  broadcastInstallProgress?: (payload: { slug: string; phase: RuntimeInstallProgressPhase }) => void;
  emitPluginInstalled?: (payload: { pluginId: string; source: "marketplace" | "local-dev" }) => void;
  refreshPluginNotifications?: () => void;
  log?: InstallLifecycleLogger;
}): Promise<void> {
  const {
    pluginId,
    source,
    rollbackMode,
    wasLoadedBeforeStart: wasLoadedBeforeStartOverride,
    pluginRuntime,
    pluginMarketplace,
    broadcastInstallProgress,
    emitPluginInstalled,
    refreshPluginNotifications,
    log,
  } = options;
  const wasLoadedBeforeStart =
    wasLoadedBeforeStartOverride ?? pluginRuntime.listPluginIds().includes(pluginId);
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
  pluginMarketplace: PluginLifecycleMarketplace;
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
      await restoreRuntimePlugin({
        pluginRuntime,
        pluginId,
        log,
        context: "install update rollback runtime restore",
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

async function restoreRuntimePlugin(options: {
  pluginRuntime: PluginInstallRuntime;
  pluginId: string;
  log?: InstallLifecycleLogger;
  context: string;
}): Promise<void> {
  const { pluginRuntime, pluginId, log, context } = options;
  try {
    const startState = await pluginRuntime.addPlugin(pluginId);
    if (startState === "preparing") {
      await pluginRuntime.waitForPluginReady(pluginId);
    }
  } catch (restoreErr) {
    log?.warn(`${context} failed for ${pluginId}: ${errorMessage(restoreErr)}`);
  }
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
