import { isAppUpdateInstallRequested } from "../main/app-update-install-intent.js";
import type { NetworkAccessAcknowledgement, NetworkAccessGrant } from "../shared/network-access.js";

const inflightInstallLocks = new Map<string, Promise<unknown>>();
let pendingPluginInstallOperations = 0;

const APP_UPDATE_INSTALL_IN_PROGRESS = "app-update-install-in-progress";
const APP_UPDATE_INSTALL_IN_PROGRESS_MESSAGE =
  "Plugin changes are paused while an app update is installing. Try again after LVIS restarts.";

class AppUpdateInstallInProgressError extends Error {
  readonly code = APP_UPDATE_INSTALL_IN_PROGRESS;

  constructor() {
    super(APP_UPDATE_INSTALL_IN_PROGRESS_MESSAGE);
  }
}

type InstalledPluginStartState = "started" | "preparing";

type RuntimeInstallProgressPhase = "restarting" | "preparing";
type MarketplaceInstallProgressPhase = "installing" | "restarting" | "verifying" | "registering" | "preparing";
type MarketplaceInstallerProgressEvent =
  | { phase: "downloading"; bytesDownloaded: number; bytesTotal: number | null }
  | { phase: "verifying" | "registering" };
type MarketplaceInstallProgressPayload =
  | { slug: string; phase: MarketplaceInstallProgressPhase }
  | { slug: string; phase: "downloading"; bytesDownloaded: number; bytesTotal: number | null };
type MarketplaceLifecycleCatalogItem = {
  id: string;
  slug?: string;
  installed?: boolean;
  version?: string;
  networkAccess?: NetworkAccessGrant;
};

class InstalledPluginVersionMismatchError extends Error {
  constructor(
    readonly pluginId: string,
    readonly expectedVersion: string,
    readonly installedVersion: string | null,
  ) {
    super(
      `installed plugin '${pluginId}' version mismatch: expected '${expectedVersion}', got '${installedVersion ?? "unknown"}'`,
    );
  }
}

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
  getLiveCatalogVersion(pluginId: string): Promise<string | null>;
  getInstalledVersion(pluginId: string): Promise<string | null>;
  quarantinePlugin(pluginId: string, reason: string): Promise<unknown>;
  install(
    pluginId: string,
    onProgress?: (event: MarketplaceInstallerProgressEvent) => void,
    options?: { networkAccessAcknowledgement?: NetworkAccessAcknowledgement },
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
  assertAppUpdateInstallNotRequested();
  pendingPluginInstallOperations += 1;
  const prev = inflightInstallLocks.get(pluginId) ?? Promise.resolve();
  let release: () => void = () => {};
  const next = new Promise<void>((resolveNext) => {
    release = resolveNext;
  });
  const tail = prev.then(() => next);
  inflightInstallLocks.set(pluginId, tail);
  try {
    await prev;
    assertAppUpdateInstallNotRequested();
    return await fn();
  } finally {
    release();
    pendingPluginInstallOperations = Math.max(0, pendingPluginInstallOperations - 1);
    if (inflightInstallLocks.get(pluginId) === tail) {
      inflightInstallLocks.delete(pluginId);
    }
  }
}

export function hasPluginInstallInFlight(): boolean {
  return pendingPluginInstallOperations > 0;
}

function assertAppUpdateInstallNotRequested(): void {
  if (!isAppUpdateInstallRequested()) return;
  throw new AppUpdateInstallInProgressError();
}

export async function installMarketplacePluginWithLifecycle(options: {
  requestedPluginId: string;
  eventSlug?: string;
  lifecyclePluginId?: string;
  expectedVersion?: string;
  networkAccessAcknowledgement?: NetworkAccessAcknowledgement;
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
    expectedVersion,
    networkAccessAcknowledgement,
    pluginRuntime,
    pluginMarketplace,
    broadcastInstallProgress,
    emitPluginInstalled,
    refreshPluginNotifications,
    log,
  } = options;
  assertAppUpdateInstallNotRequested();
  const catalogState = await resolveMarketplaceLifecycleState(pluginMarketplace, requestedPluginId);
  const resolvedLifecyclePluginId = lifecyclePluginId ?? catalogState.pluginId;
  const progressSlug = eventSlug ?? resolvedLifecyclePluginId;

  return withPluginInstallLock(resolvedLifecyclePluginId, async () => {
    const currentCatalogState = await resolveMarketplaceLifecycleState(pluginMarketplace, requestedPluginId);
    const expectedVersionForGuard = expectedVersion?.trim();
    if (expectedVersionForGuard) {
      assertExpectedVersionMatchesTrustedCatalog({
        pluginId: currentCatalogState.pluginId,
        expectedVersion: expectedVersionForGuard,
        catalogVersion: await pluginMarketplace.getLiveCatalogVersion(requestedPluginId),
      });
    }
    const hadExistingInstall =
      currentCatalogState.installed === true ||
      pluginRuntime.listPluginIds().includes(currentCatalogState.pluginId);
    let restorePluginId = resolvedLifecyclePluginId;
    let startLifecycleAttempted = false;
    let versionVerificationFailed = false;
    let installedVersionBeforeInstall: string | null = null;
    try {
      if (hadExistingInstall) {
        broadcastInstallProgress?.({ slug: progressSlug, phase: "restarting" });
        installedVersionBeforeInstall = await pluginMarketplace.getInstalledVersion(currentCatalogState.pluginId);
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
      }, {
        networkAccessAcknowledgement,
      });
      const installedPluginId = result.pluginId === requestedPluginId ? resolvedLifecyclePluginId : result.pluginId;
      restorePluginId = installedPluginId;
      try {
        await assertInstalledMarketplacePluginVersion({
          pluginMarketplace,
          pluginId: installedPluginId,
          expectedVersion,
        });
      } catch (err) {
        versionVerificationFailed = true;
        try {
          await rollbackFailedVersionVerification({
            pluginId: installedPluginId,
            wasLoadedBeforeStart: hadExistingInstall,
            installedVersionBeforeInstall,
            installedVersionAfterFailure: err instanceof InstalledPluginVersionMismatchError
              ? err.installedVersion
              : null,
            pluginRuntime,
            pluginMarketplace,
            log,
          });
        } catch (rollbackErr) {
          throw new Error(`install version verification failed and rollback failed for ${installedPluginId}: ${errorMessage(rollbackErr)} (original: ${errorMessage(err)})`);
        }
        throw err;
      }
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
        !versionVerificationFailed &&
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

async function rollbackFailedVersionVerification(options: {
  pluginId: string;
  wasLoadedBeforeStart: boolean;
  installedVersionBeforeInstall: string | null;
  installedVersionAfterFailure: string | null;
  pluginRuntime: PluginInstallRuntime;
  pluginMarketplace: PluginInstallMarketplace;
  log?: InstallLifecycleLogger;
}): Promise<void> {
  const {
    pluginId,
    wasLoadedBeforeStart,
    installedVersionBeforeInstall,
    installedVersionAfterFailure,
    pluginRuntime,
    pluginMarketplace,
    log,
  } = options;

  if (wasLoadedBeforeStart) {
    if (
      installedVersionBeforeInstall !== null &&
      installedVersionAfterFailure === installedVersionBeforeInstall
    ) {
      if (!pluginRuntime.listPluginIds().includes(pluginId)) {
        await restoreRuntimePlugin({
          pluginRuntime,
          pluginId,
          log,
          context: "install version verification no-op runtime restore",
        });
      }
      return;
    }
    try {
      await pluginMarketplace.rollbackPlugin(pluginId);
    } catch (rollbackErr) {
      await quarantineVersionVerificationFailure({
        pluginId,
        reason: `expectedVersion rollback failed: ${errorMessage(rollbackErr)}`,
        pluginMarketplace,
      });
      throw rollbackErr;
    }
    if (!pluginRuntime.listPluginIds().includes(pluginId)) {
      await restoreRuntimePlugin({
        pluginRuntime,
        pluginId,
        log,
        context: "install version verification rollback runtime restore",
      });
    }
    return;
  }

  await pluginRuntime.removePlugin(pluginId).catch((rmPluginErr) => {
    log?.warn(`install version verification rollback removePlugin failed for ${pluginId}: ${errorMessage(rmPluginErr)}`);
  });
  try {
    await pluginMarketplace.uninstall(pluginId);
  } catch (uninstallErr) {
    await quarantineVersionVerificationFailure({
      pluginId,
      reason: `expectedVersion fresh-install cleanup failed: ${errorMessage(uninstallErr)}`,
      pluginMarketplace,
    });
    throw uninstallErr;
  }
}

async function quarantineVersionVerificationFailure(options: {
  pluginId: string;
  reason: string;
  pluginMarketplace: PluginInstallMarketplace;
}): Promise<void> {
  const { pluginId, reason, pluginMarketplace } = options;
  try {
    await pluginMarketplace.quarantinePlugin(pluginId, reason);
  } catch (quarantineErr) {
    throw new Error(`install version verification quarantine failed for ${pluginId}: ${errorMessage(quarantineErr)} (original: ${reason})`);
  }
}

async function assertInstalledMarketplacePluginVersion(options: {
  pluginMarketplace: Pick<PluginInstallMarketplace, "getInstalledVersion">;
  pluginId: string;
  expectedVersion?: string;
}): Promise<void> {
  const expectedVersion = options.expectedVersion?.trim();
  if (!expectedVersion) return;
  const installedVersion = await options.pluginMarketplace.getInstalledVersion(options.pluginId);
  if (installedVersion === expectedVersion) return;
  throw new InstalledPluginVersionMismatchError(options.pluginId, expectedVersion, installedVersion);
}

function assertExpectedVersionMatchesTrustedCatalog(options: {
  pluginId: string;
  expectedVersion?: string;
  catalogVersion: string | null;
}): void {
  const expectedVersion = options.expectedVersion?.trim();
  if (!expectedVersion) return;
  const catalogVersion = options.catalogVersion?.trim();
  if (!catalogVersion) {
    throw new Error(
      `cannot verify requested install version for '${options.pluginId}': marketplace catalog has no version`,
    );
  }
  if (catalogVersion === expectedVersion) return;
  throw new Error(
    `requested plugin '${options.pluginId}' version is stale: expected '${expectedVersion}', marketplace has '${catalogVersion}'`,
  );
}

async function resolveMarketplaceLifecycleState(
  pluginMarketplace: Pick<PluginInstallMarketplace, "list">,
  requestedPluginId: string,
): Promise<{ pluginId: string; installed: boolean | undefined; version: string | undefined }> {
  const catalogItems = await pluginMarketplace.list();
  const item = catalogItems.find((candidate) => candidate.id === requestedPluginId || candidate.slug === requestedPluginId);
  return {
    pluginId: item?.id ?? requestedPluginId,
    installed: item?.installed,
    version: item?.version,
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
