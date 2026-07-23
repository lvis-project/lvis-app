import { isAppUpdateInstallRequested } from "../main/app-update-install-intent.js";
import type { NetworkAccessAcknowledgement, NetworkAccessGrant } from "../shared/network-access.js";
import { AsyncLocalStorage } from "node:async_hooks";

const inflightInstallLocks = new Map<string, Promise<unknown>>();
interface HeldPluginInstallLock {
  active: boolean;
  pendingReentrantOperations: Set<TrackedReentrantOperation>;
  reentrantFailures: unknown[];
}

interface TrackedReentrantOperation {
  promise: Promise<unknown>;
  parent?: TrackedReentrantOperation;
}

const heldPluginInstallLocks = new AsyncLocalStorage<ReadonlyMap<string, HeldPluginInstallLock>>();
const currentReentrantOperation = new AsyncLocalStorage<TrackedReentrantOperation>();
const ALL_PLUGIN_LOCK_KEY = "\0all-plugins";
const PLUGIN_LIFECYCLE_DRAIN_TIMEOUT_MS = 10_000;
const quarantinedPluginInstallLocks = new Set<string>();
const pluginLifecycleQuarantineListeners = new Set<(lockKey: string) => void>();
let exclusiveLifecycleTail: Promise<void> = Promise.resolve();
let queuedExclusiveLifecycleMutations = 0;
let activePluginLifecycleMutations = 0;
let resolvePluginLifecycleDrain: (() => void) | null = null;
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

class PluginLifecycleDrainTimeoutError extends Error {
  readonly code = "plugin-lifecycle-drain-timeout";

  constructor() {
    super(
      `Detached plugin lifecycle mutation did not settle within ${PLUGIN_LIFECYCLE_DRAIN_TIMEOUT_MS}ms`,
    );
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
export function withPluginInstallLock<T>(
  pluginId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const quarantineError = getPluginLifecycleQuarantineError(pluginId);
  if (quarantineError) return Promise.reject(quarantineError);
  try {
    assertAppUpdateInstallNotRequested();
  } catch (err) {
    return Promise.reject(err);
  }
  const heldLocks = heldPluginInstallLocks.getStore();
  const heldLock = selectActiveHeldLock(heldLocks, pluginId);
  if (heldLock) {
    return trackReentrantOperation(heldLock, fn);
  }
  return acquirePluginInstallLock(pluginId, fn, heldLocks);
}

async function acquirePluginInstallLock<T>(
  pluginId: string,
  fn: () => Promise<T>,
  heldLocks: ReadonlyMap<string, HeldPluginInstallLock> | undefined,
): Promise<T> {
  while (true) {
    const exclusiveGate = exclusiveLifecycleTail;
    await waitForPluginLifecycleGate(exclusiveGate, pluginId);
    if (exclusiveGate !== exclusiveLifecycleTail) continue;
    activePluginLifecycleMutations += 1;
    break;
  }
  pendingPluginInstallOperations += 1;
  const prev = inflightInstallLocks.get(pluginId) ?? Promise.resolve();
  let release: () => void = () => {};
  const next = new Promise<void>((resolveNext) => {
    release = resolveNext;
  });
  const tail = prev.then(() => next);
  inflightInstallLocks.set(pluginId, tail);
  let releaseDeferred = false;
  let finalized = false;
  const finalize = () => {
    if (finalized) return;
    finalized = true;
    release();
    pendingPluginInstallOperations = Math.max(0, pendingPluginInstallOperations - 1);
    activePluginLifecycleMutations = Math.max(0, activePluginLifecycleMutations - 1);
    if (activePluginLifecycleMutations === 0) {
      resolvePluginLifecycleDrain?.();
      resolvePluginLifecycleDrain = null;
    }
    if (inflightInstallLocks.get(pluginId) === tail) {
      inflightInstallLocks.delete(pluginId);
    }
  };
  try {
    await waitForPluginLifecycleGate(prev, pluginId);
    assertAppUpdateInstallNotRequested();
    const token: HeldPluginInstallLock = {
      active: true,
      pendingReentrantOperations: new Set(),
      reentrantFailures: [],
    };
    const nextHeldLocks = copyActiveHeldLocks(heldLocks);
    nextHeldLocks.set(pluginId, token);
    let ownerValue!: T;
    let ownerFailed = false;
    let ownerError: unknown;
    try {
      ownerValue = await heldPluginInstallLocks.run(nextHeldLocks, fn);
    } catch (err) {
      ownerFailed = true;
      ownerError = err;
    }
    let drainError: unknown;
    try {
      await drainReentrantOperations(token);
      token.active = false;
    } catch (err) {
      drainError = err;
      if (err instanceof PluginLifecycleDrainTimeoutError) {
        beginPluginInstallQuarantine(pluginId);
        // Fail the caller within a bounded time, but retain the lock token and
        // queue position until the already-started mutation really settles.
        // Releasing here would allow uninstall cleanup to race that stale
        // write. This is a fail-closed quarantine, not an event-loop wait.
        releaseDeferred = true;
        void settleReentrantOperations(token).finally(() => {
          quarantinedPluginInstallLocks.delete(pluginId);
          token.active = false;
          finalize();
        });
      } else {
        token.active = false;
      }
    }
    if (ownerFailed) {
      if (drainError !== undefined) throw combineLifecycleErrors(ownerError, drainError);
      throw ownerError;
    }
    if (drainError !== undefined) throw drainError;
    return ownerValue;
  } finally {
    if (!releaseDeferred) finalize();
  }
}

/** True only inside the async call-chain that currently owns this plugin lock. */
export function isPluginInstallLockHeld(pluginId: string): boolean {
  const held = heldPluginInstallLocks.getStore();
  return held?.get(ALL_PLUGIN_LOCK_KEY)?.active === true || held?.get(pluginId)?.active === true;
}

/**
 * Wait for fire-and-forget mutations that re-entered the currently held lock.
 * Uninstall calls this immediately after runtime stop so a detached HostApi
 * write cannot finish after durable plugin state has been deleted.
 */
export async function drainPluginInstallLockOperations(pluginId: string): Promise<void> {
  const held = heldPluginInstallLocks.getStore();
  const token = selectActiveHeldLock(held, pluginId);
  if (!token) return;
  await drainReentrantOperations(token);
}

/** Serialize a multi-plugin artifact mutation plus its full runtime rebuild. */
export function withAllPluginInstallLocks<T>(fn: () => Promise<T>): Promise<T> {
  const quarantineError = getAnyPluginLifecycleQuarantineError();
  if (quarantineError) return Promise.reject(quarantineError);
  const heldLocks = heldPluginInstallLocks.getStore();
  const heldAllLock = heldLocks?.get(ALL_PLUGIN_LOCK_KEY);
  if (heldAllLock?.active) return trackReentrantOperation(heldAllLock, fn);
  if ([...(heldLocks?.entries() ?? [])].some(([key, token]) =>
    key !== ALL_PLUGIN_LOCK_KEY && token.active
  )) {
    return Promise.reject(
      new Error("Cannot upgrade a held per-plugin lifecycle lock to the all-plugin lock"),
    );
  }
  try {
    assertAppUpdateInstallNotRequested();
  } catch (err) {
    return Promise.reject(err);
  }
  return acquireAllPluginInstallLocks(fn, heldLocks);
}

async function acquireAllPluginInstallLocks<T>(
  fn: () => Promise<T>,
  heldLocks: ReadonlyMap<string, HeldPluginInstallLock> | undefined,
): Promise<T> {
  const previousExclusive = exclusiveLifecycleTail;
  const canEnterSynchronously =
    queuedExclusiveLifecycleMutations === 0 && activePluginLifecycleMutations === 0;
  queuedExclusiveLifecycleMutations += 1;
  let releaseExclusive!: () => void;
  const exclusiveDone = new Promise<void>((resolve) => { releaseExclusive = resolve; });
  exclusiveLifecycleTail = previousExclusive.then(() => exclusiveDone);
  let releaseDeferred = false;
  let finalized = false;
  let operationCounted = false;
  const finalize = () => {
    if (finalized) return;
    finalized = true;
    if (operationCounted) {
      pendingPluginInstallOperations = Math.max(0, pendingPluginInstallOperations - 1);
    }
    queuedExclusiveLifecycleMutations = Math.max(
      0,
      queuedExclusiveLifecycleMutations - 1,
    );
    releaseExclusive();
  };
  try {
    if (!canEnterSynchronously) {
      await waitForAnyPluginLifecycleGate(previousExclusive);
      if (activePluginLifecycleMutations > 0) {
        await waitForAnyPluginLifecycleGate(
          new Promise<void>((resolve) => { resolvePluginLifecycleDrain = resolve; }),
        );
      }
    }
    pendingPluginInstallOperations += 1;
    operationCounted = true;
    const token: HeldPluginInstallLock = {
      active: true,
      pendingReentrantOperations: new Set(),
      reentrantFailures: [],
    };
    const nextHeldLocks = copyActiveHeldLocks(heldLocks);
    nextHeldLocks.set(ALL_PLUGIN_LOCK_KEY, token);
    assertAppUpdateInstallNotRequested();
    let ownerValue!: T;
    let ownerFailed = false;
    let ownerError: unknown;
    try {
      ownerValue = await heldPluginInstallLocks.run(nextHeldLocks, fn);
    } catch (err) {
      ownerFailed = true;
      ownerError = err;
    }
    let drainError: unknown;
    try {
      await drainReentrantOperations(token);
      token.active = false;
    } catch (err) {
      drainError = err;
      if (err instanceof PluginLifecycleDrainTimeoutError) {
        beginPluginInstallQuarantine(ALL_PLUGIN_LOCK_KEY);
        releaseDeferred = true;
        void settleReentrantOperations(token).finally(() => {
          quarantinedPluginInstallLocks.delete(ALL_PLUGIN_LOCK_KEY);
          token.active = false;
          finalize();
        });
      } else {
        token.active = false;
      }
    }
    if (ownerFailed) {
      if (drainError !== undefined) throw combineLifecycleErrors(ownerError, drainError);
      throw ownerError;
    }
    if (drainError !== undefined) throw drainError;
    return ownerValue;
  } finally {
    if (!releaseDeferred) finalize();
  }
}

function combineLifecycleErrors(primary: unknown, drain: unknown): AggregateError {
  const drainErrors = drain instanceof AggregateError ? drain.errors : [drain];
  return new AggregateError(
    [primary, ...drainErrors],
    "Plugin lifecycle owner and detached mutations failed",
  );
}

function trackReentrantOperation<T>(
  token: HeldPluginInstallLock,
  fn: () => Promise<T>,
): Promise<T> {
  const tracked = {} as TrackedReentrantOperation;
  const parent = currentReentrantOperation.getStore();
  if (parent) tracked.parent = parent;
  const operation = Promise.resolve().then(() =>
    currentReentrantOperation.run(tracked, fn),
  );
  tracked.promise = operation;
  token.pendingReentrantOperations.add(tracked);
  void operation.then(
    () => token.pendingReentrantOperations.delete(tracked),
    (err) => {
      token.pendingReentrantOperations.delete(tracked);
      token.reentrantFailures.push(err);
    },
  );
  return operation;
}

async function drainReentrantOperations(token: HeldPluginInstallLock): Promise<void> {
  const excluded = new Set<TrackedReentrantOperation>();
  let current = currentReentrantOperation.getStore();
  while (current) {
    excluded.add(current);
    current = current.parent;
  }
  const deadline = Date.now() + PLUGIN_LIFECYCLE_DRAIN_TIMEOUT_MS;
  while (true) {
    const pending = [...token.pendingReentrantOperations]
      .filter((operation) => !excluded.has(operation));
    if (pending.length === 0) break;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new PluginLifecycleDrainTimeoutError();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.allSettled(pending.map((operation) => operation.promise)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new PluginLifecycleDrainTimeoutError()), remainingMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  if (token.reentrantFailures.length > 0) {
    const failures = token.reentrantFailures.splice(0);
    throw new AggregateError(failures, "Detached plugin lifecycle mutation failed");
  }
}

async function settleReentrantOperations(token: HeldPluginInstallLock): Promise<void> {
  while (token.pendingReentrantOperations.size > 0) {
    await Promise.allSettled(
      [...token.pendingReentrantOperations].map((operation) => operation.promise),
    );
  }
}

function selectActiveHeldLock(
  heldLocks: ReadonlyMap<string, HeldPluginInstallLock> | undefined,
  pluginId: string,
): HeldPluginInstallLock | undefined {
  const all = heldLocks?.get(ALL_PLUGIN_LOCK_KEY);
  if (all?.active) return all;
  const plugin = heldLocks?.get(pluginId);
  return plugin?.active ? plugin : undefined;
}

function copyActiveHeldLocks(
  heldLocks: ReadonlyMap<string, HeldPluginInstallLock> | undefined,
): Map<string, HeldPluginInstallLock> {
  return new Map(
    [...(heldLocks?.entries() ?? [])].filter(([, token]) => token.active),
  );
}

class PluginLifecycleQuarantinedError extends Error {
  readonly code = "plugin-lifecycle-quarantined";

  constructor(pluginId: string) {
    super(`Plugin lifecycle is quarantined until a timed-out mutation settles: ${pluginId}`);
  }
}

function getPluginLifecycleQuarantineError(pluginId: string): Error | null {
  if (quarantinedPluginInstallLocks.has(ALL_PLUGIN_LOCK_KEY)) {
    return new PluginLifecycleQuarantinedError("all plugins");
  }
  if (quarantinedPluginInstallLocks.has(pluginId)) {
    return new PluginLifecycleQuarantinedError(pluginId);
  }
  return null;
}

function getAnyPluginLifecycleQuarantineError(): Error | null {
  if (quarantinedPluginInstallLocks.size === 0) return null;
  return new PluginLifecycleQuarantinedError(
    quarantinedPluginInstallLocks.has(ALL_PLUGIN_LOCK_KEY)
      ? "all plugins"
      : [...quarantinedPluginInstallLocks].sort().join(", "),
  );
}

function beginPluginInstallQuarantine(lockKey: string): void {
  quarantinedPluginInstallLocks.add(lockKey);
  for (const notify of [...pluginLifecycleQuarantineListeners]) notify(lockKey);
}

async function waitForPluginLifecycleGate(
  gate: Promise<unknown>,
  pluginId: string,
): Promise<void> {
  await waitForLifecycleGate(gate, (lockKey) =>
    lockKey === ALL_PLUGIN_LOCK_KEY || lockKey === pluginId,
  () => getPluginLifecycleQuarantineError(pluginId));
}

async function waitForAnyPluginLifecycleGate(gate: Promise<unknown>): Promise<void> {
  await waitForLifecycleGate(
    gate,
    () => true,
    getAnyPluginLifecycleQuarantineError,
  );
}

async function waitForLifecycleGate(
  gate: Promise<unknown>,
  matches: (lockKey: string) => boolean,
  currentError: () => Error | null,
): Promise<void> {
  const initialError = currentError();
  if (initialError) throw initialError;
  let listener: ((lockKey: string) => void) | undefined;
  const quarantine = new Promise<never>((_, reject) => {
    listener = (lockKey) => {
      if (!matches(lockKey)) return;
      reject(currentError() ?? new PluginLifecycleQuarantinedError(lockKey));
    };
    pluginLifecycleQuarantineListeners.add(listener);
    const racedError = currentError();
    if (racedError) reject(racedError);
  });
  try {
    await Promise.race([gate, quarantine]);
  } finally {
    if (listener) pluginLifecycleQuarantineListeners.delete(listener);
  }
  const finalError = currentError();
  if (finalError) throw finalError;
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
        await pluginRuntime.removePlugin(currentCatalogState.pluginId);
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
