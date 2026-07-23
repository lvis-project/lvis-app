import { isAppUpdateInstallRequested } from "../main/app-update-install-intent.js";
import type { NetworkAccessAcknowledgement, NetworkAccessGrant } from "../shared/network-access.js";
import type { PluginAccessSpec, PluginManifest } from "./types.js";

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
  activatePreparedArtifact<T>(input: {
    pluginRoot: string;
    manifest: PluginManifest;
    receiptRaw: string;
    approvedPluginAccess?: PluginAccessSpec;
    durableCommit(): Promise<T>;
  }): Promise<{ result: T; retirement: Promise<void> }>;
}

interface PreparedActivationOptions {
  activatePreparedArtifact: (prepared: {
    pluginRoot: string;
    manifest: PluginManifest;
    receiptRaw: string;
    approvedPluginAccess?: PluginAccessSpec;
    durableCommit(): Promise<string>;
  }) => Promise<{ result: string; retirement: Promise<void> }>;
}

interface PluginInstallMarketplace {
  list(): Promise<MarketplaceLifecycleCatalogItem[]>;
  getLiveCatalogVersion(pluginId: string): Promise<string | null>;
  install(
    pluginId: string,
    onProgress: ((event: MarketplaceInstallerProgressEvent) => void) | undefined,
    options: PreparedActivationOptions & {
      networkAccessAcknowledgement?: NetworkAccessAcknowledgement;
    },
  ): Promise<{ pluginId: string; installed: true }>;
  rollbackPlugin(
    pluginId: string,
    options: PreparedActivationOptions,
  ): Promise<{ pluginId: string; rolledBackTo: string }>;
}

export async function rollbackMarketplacePluginWithLifecycle(options: {
  pluginId: string;
  pluginRuntime: PluginInstallRuntime;
  pluginMarketplace: Pick<PluginInstallMarketplace, "rollbackPlugin">;
}): Promise<{ pluginId: string; rolledBackTo: string }> {
  const { pluginId, pluginRuntime, pluginMarketplace } = options;
  return withPluginInstallLock(pluginId, async () => {
    const result = await pluginMarketplace.rollbackPlugin(pluginId, {
      activatePreparedArtifact: (prepared) => pluginRuntime.activatePreparedArtifact(prepared),
    });
    if (!pluginRuntime.listPluginIds().includes(result.pluginId)) {
      throw new Error(`atomic rollback committed without active runtime: ${result.pluginId}`);
    }
    return result;
  });
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
    if (hadExistingInstall) {
      broadcastInstallProgress?.({ slug: progressSlug, phase: "restarting" });
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
        activatePreparedArtifact: async (prepared) => {
          if (expectedVersionForGuard && prepared.manifest.version !== expectedVersionForGuard) {
            throw new InstalledPluginVersionMismatchError(
              prepared.manifest.id,
              expectedVersionForGuard,
              prepared.manifest.version ?? null,
            );
          }
          broadcastInstallProgress?.({ slug: progressSlug, phase: "preparing" });
          return pluginRuntime.activatePreparedArtifact(prepared);
        },
    });
    const installedPluginId = result.pluginId === requestedPluginId ? resolvedLifecyclePluginId : result.pluginId;
    if (!pluginRuntime.listPluginIds().includes(installedPluginId)) {
      throw new Error(`atomic install committed without active runtime: ${installedPluginId}`);
    }
    broadcastInstallProgress?.({ slug: progressSlug, phase: "registering" });
    emitPluginInstalled?.({ pluginId: installedPluginId, source: "marketplace" });
    refreshPluginNotifications?.();
    return { ...result, pluginId: installedPluginId };
  });
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
