import { isAppUpdateInstallRequested } from "../main/app-update-install-intent.js";
import type { NetworkAccessAcknowledgement, NetworkAccessGrant } from "../shared/network-access.js";
import type { PluginAccessSpec, PluginManifest, PluginRegistryEntry } from "./types.js";
import { AsyncLocalStorage } from "node:async_hooks";

const inflightInstallLocks = new Map<string, Promise<unknown>>();
interface HeldPluginInstallLock {
  active: boolean;
  pendingReentrantOperations: Set<TrackedReentrantOperation>;
}

interface TrackedReentrantOperation {
  parent?: TrackedReentrantOperation;
  branches: Set<TrackedPromiseBranch>;
  closed: boolean;
}

interface TrackedPromiseBranch {
  promise: Promise<unknown>;
  handled: boolean;
  settled: boolean;
  rejected: boolean;
  failure?: unknown;
}

class ObservedReentrantPromise<T> extends Promise<T> {
  static get [Symbol.species](): PromiseConstructor {
    return Promise;
  }

  constructor(
    private readonly source: Promise<T>,
    private readonly branch: TrackedPromiseBranch,
    private readonly trackBranch: <U>(promise: Promise<U>) => Promise<U>,
  ) {
    super((resolve, reject) => {
      void source.then(resolve, reject);
    });
    // Branch failures are reported to the owning lifecycle mutation, not to
    // the process unhandled-rejection channel.
    void Promise.prototype.then.call(this, undefined, () => undefined);
  }

  override then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    this.branch.handled = true;
    return this.trackBranch(
      this.source.then(onfulfilled, onrejected),
    );
  }

  override catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): Promise<T | TResult> {
    return this.then(undefined, onrejected);
  }

  override finally(onfinally?: (() => void) | null): Promise<T> {
    this.branch.handled = true;
    return this.trackBranch(this.source.finally(onfinally));
  }
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
  resolvePluginId(pluginId: string): string;
  resolvePluginInstallId(pluginId: string): string | null;
  resolvePluginInstallIdIfKnown(pluginId: string): string | null | undefined;
  addPlugin(pluginId: string): Promise<InstalledPluginStartState>;
  waitForPluginReady(pluginId: string): Promise<void>;
  removePlugin(
    pluginId: string,
    options?: { preserveConfigOverride?: boolean },
  ): Promise<void>;
  cancelPendingRestart(pluginId: string): void;
  activatePreparedArtifact<T>(input: {
    installId: string;
    pluginRoot: string;
    manifest: PluginManifest;
    receiptRaw: string;
    registryEntry: Readonly<
      Pick<PluginRegistryEntry, "installSource" | "manifestSha256">
    >;
    approvedPluginAccess?: PluginAccessSpec;
    durableCommit(): Promise<T>;
  }): Promise<{ result: T; retirement: Promise<void> }>;
}

interface PreparedActivationOptions {
  activatePreparedArtifact: (prepared: {
    installId: string;
    pluginRoot: string;
    manifest: PluginManifest;
    receiptRaw: string;
    registryEntry: Readonly<
      Pick<PluginRegistryEntry, "installSource" | "manifestSha256">
    >;
    approvedPluginAccess?: PluginAccessSpec;
    durableCommit(): Promise<string>;
  }) => Promise<{ result: string; retirement: Promise<void> }>;
}

interface PluginLifecycleMarketplace {
  uninstall(pluginId: string): Promise<unknown>;
  rollbackPlugin(
    pluginId: string,
    options: PreparedActivationOptions,
  ): Promise<{ pluginId: string; rolledBackTo: string }>;
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
    options?: PreparedActivationOptions & {
      networkAccessAcknowledgement?: NetworkAccessAcknowledgement;
    },
  ): Promise<{ pluginId: string; installed: true }>;
}

export async function rollbackMarketplacePluginWithLifecycle(options: {
  pluginId: string;
  pluginRuntime: PluginInstallRuntime;
  pluginMarketplace: Pick<PluginInstallMarketplace, "rollbackPlugin">;
  ensurePluginStateReadyForInstall: (pluginId: string) => Promise<void>;
}): Promise<{ pluginId: string; rolledBackTo: string }> {
  const {
    pluginId,
    pluginRuntime,
    pluginMarketplace,
    ensurePluginStateReadyForInstall,
  } = options;
  return withPluginInstallLock(pluginId, async () => {
    await ensurePluginStateReadyForInstall(pluginId);
    const result = await pluginMarketplace.rollbackPlugin(pluginId, {
      activatePreparedArtifact: (prepared) =>
        pluginRuntime.activatePreparedArtifact(prepared),
    });
    const canonicalPluginId = pluginRuntime.resolvePluginId(result.pluginId);
    if (!pluginRuntime.listPluginIds().includes(canonicalPluginId)) {
      throw new Error(
        `atomic rollback committed without active runtime: ${canonicalPluginId}`,
      );
    }
    return { ...result, pluginId: canonicalPluginId };
  });
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

/**
 * Hold every identity that can address one plugin for the full mutation.
 * Sorting provides a single acquisition order, so alias/canonical callers
 * cannot deadlock while an inner remove temporarily clears runtime aliases.
 */
function withPluginInstallLocks<T>(
  pluginIds: readonly string[],
  fn: () => Promise<T>,
): Promise<T> {
  const lockKeys = [...new Set(pluginIds)].sort();
  if (lockKeys.length === 0) {
    throw new Error("plugin lifecycle mutation requires at least one identity");
  }
  if (lockKeys.length === 1) return withPluginInstallLock(lockKeys[0]!, fn);
  const quarantineError = getPluginLifecycleQuarantineErrorFor(lockKeys);
  if (quarantineError) return Promise.reject(quarantineError);
  try {
    assertAppUpdateInstallNotRequested();
  } catch (err) {
    return Promise.reject(err);
  }
  const heldLocks = heldPluginInstallLocks.getStore();
  const heldTokens = lockKeys
    .map((lockKey) => selectActiveHeldLock(heldLocks, lockKey))
    .filter((token): token is HeldPluginInstallLock => token !== undefined);
  if (heldTokens.length === lockKeys.length && new Set(heldTokens).size === 1) {
    return trackReentrantOperation(heldTokens[0]!, fn);
  }
  if (heldTokens.length > 0) {
    return Promise.reject(
      new Error("Cannot extend a held plugin lifecycle lock to additional identities"),
    );
  }
  return acquireMultiplePluginInstallLocks(lockKeys, fn, heldLocks);
}

/**
 * Resolve alias/canonical lock identities again after admission. An operation
 * that waited while another mutation temporarily cleared and then restored an
 * alias must not continue under only its stale pre-wait identity.
 */
export async function withResolvedPluginInstallLocks<T>(
  resolvePluginIds: () => readonly string[],
  fn: () => Promise<T>,
  cancelPendingForDiscoveredIds?: (pluginIds: readonly string[]) => void,
): Promise<T> {
  let lockIds = [...new Set(resolvePluginIds())].sort();
  while (true) {
    const outcome = await withPluginInstallLocks<
      { retry: string[] } | { value: T }
    >(lockIds, async () => {
      const currentIds = [...new Set(resolvePluginIds())].sort();
      const discoveredIds = currentIds.filter(
        (pluginId) => !isPluginInstallLockHeld(pluginId),
      );
      if (discoveredIds.length > 0) {
        cancelPendingForDiscoveredIds?.(discoveredIds);
        return {
          retry: [...new Set([...lockIds, ...currentIds])].sort(),
        };
      }
      const value: T = await fn();
      return { value };
    });
    if ("value" in outcome) return outcome.value;
    lockIds = outcome.retry;
  }
}

async function acquireMultiplePluginInstallLocks<T>(
  pluginIds: readonly string[],
  fn: () => Promise<T>,
  heldLocks: ReadonlyMap<string, HeldPluginInstallLock> | undefined,
): Promise<T> {
  while (true) {
    if (queuedExclusiveLifecycleMutations === 0) {
      const quarantineError = getPluginLifecycleQuarantineErrorFor(pluginIds);
      if (quarantineError) throw quarantineError;
      // One mutation owns every identity reservation, so the global drain
      // counter advances once. All queue slots are published below before the
      // first await, preventing an exclusive mutation from interposing.
      activePluginLifecycleMutations += 1;
      break;
    }
    await waitForMultiplePluginLifecycleGate(exclusiveLifecycleTail, pluginIds);
    const quarantineError = getPluginLifecycleQuarantineErrorFor(pluginIds);
    if (quarantineError) throw quarantineError;
  }

  pendingPluginInstallOperations += 1;
  const reservations = pluginIds.map((pluginId) => {
    const previous = inflightInstallLocks.get(pluginId) ?? Promise.resolve();
    let release: () => void = () => {};
    const next = new Promise<void>((resolveNext) => {
      release = resolveNext;
    });
    const tail = previous.then(() => next);
    inflightInstallLocks.set(pluginId, tail);
    return { pluginId, previous, release, tail };
  });
  let releaseDeferred = false;
  let finalized = false;
  const finalize = () => {
    if (finalized) return;
    finalized = true;
    for (const reservation of reservations) {
      reservation.release();
      if (inflightInstallLocks.get(reservation.pluginId) === reservation.tail) {
        inflightInstallLocks.delete(reservation.pluginId);
      }
    }
    pendingPluginInstallOperations = Math.max(0, pendingPluginInstallOperations - 1);
    activePluginLifecycleMutations = Math.max(0, activePluginLifecycleMutations - 1);
    if (activePluginLifecycleMutations === 0) {
      resolvePluginLifecycleDrain?.();
      resolvePluginLifecycleDrain = null;
    }
  };

  try {
    await Promise.all(
      reservations.map(({ pluginId, previous }) =>
        waitForPluginLifecycleGate(previous, pluginId)
      ),
    );
    assertAppUpdateInstallNotRequested();
    const token: HeldPluginInstallLock = {
      active: true,
      pendingReentrantOperations: new Set(),
    };
    const nextHeldLocks = copyActiveHeldLocks(heldLocks);
    for (const pluginId of pluginIds) nextHeldLocks.set(pluginId, token);
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
        for (const pluginId of pluginIds) beginPluginInstallQuarantine(pluginId);
        releaseDeferred = true;
        void settleReentrantOperations(token).finally(() => {
          for (const pluginId of pluginIds) {
            quarantinedPluginInstallLocks.delete(pluginId);
          }
          token.active = false;
          finalize();
        });
      } else {
        token.active = false;
      }
    }
    if (ownerFailed) {
      if (drainError !== undefined) {
        throw combineLifecycleErrors(ownerError, drainError);
      }
      throw ownerError;
    }
    if (drainError !== undefined) throw drainError;
    return ownerValue;
  } finally {
    if (!releaseDeferred) finalize();
  }
}

async function acquirePluginInstallLock<T>(
  pluginId: string,
  fn: () => Promise<T>,
  heldLocks: ReadonlyMap<string, HeldPluginInstallLock> | undefined,
): Promise<T> {
  while (true) {
    // Reserve the per-plugin scheduling slot synchronously whenever no
    // exclusive mutation is queued. A resolved-Promise await here creates a
    // TOCTOU window where restartPlugin publishes pending state, then a global
    // mutation enters and waits on that restart while the restart waits on the
    // new exclusive tail.
    if (queuedExclusiveLifecycleMutations === 0) {
      const quarantineError = getPluginLifecycleQuarantineError(pluginId);
      if (quarantineError) throw quarantineError;
      activePluginLifecycleMutations += 1;
      break;
    }
    await waitForPluginLifecycleGate(exclusiveLifecycleTail, pluginId);
    // A timed-out exclusive owner releases its queue gate before its stale
    // detached work settles, so the queue count intentionally remains
    // non-zero. Reject quarantined callers here instead of spinning on the
    // already-resolved tail.
    const quarantineError = getPluginLifecycleQuarantineError(pluginId);
    if (quarantineError) throw quarantineError;
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

/** True while an all-plugin lifecycle mutation is queued or active. */
export function hasExclusivePluginLifecycleMutation(): boolean {
  return queuedExclusiveLifecycleMutations > 0;
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
  const tracked: TrackedReentrantOperation = {
    branches: new Set(),
    closed: false,
  };
  const parent = currentReentrantOperation.getStore();
  if (parent) tracked.parent = parent;
  const operation = Promise.resolve().then(() =>
    currentReentrantOperation.run(tracked, fn),
  );
  token.pendingReentrantOperations.add(tracked);
  const trackBranch = <U>(promise: Promise<U>): Promise<U> => {
    if (tracked.closed) return promise;
    const branch: TrackedPromiseBranch = {
      promise,
      handled: false,
      settled: false,
      rejected: false,
    };
    tracked.branches.add(branch);
    void promise.then(
      () => {
        branch.settled = true;
      },
      (err) => {
        branch.rejected = true;
        branch.failure = err;
        branch.settled = true;
      },
    );
    return new ObservedReentrantPromise(
      promise,
      branch,
      trackBranch,
    );
  };
  return trackBranch(operation);
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
      .filter((operation) => !excluded.has(operation))
      .flatMap((operation) =>
        [...operation.branches].filter((branch) => !branch.settled)
      );
    if (pending.length === 0) break;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new PluginLifecycleDrainTimeoutError();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.allSettled(pending.map((branch) => branch.promise)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new PluginLifecycleDrainTimeoutError()), remainingMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  const failures = [...token.pendingReentrantOperations]
    .filter((operation) => !excluded.has(operation))
    .flatMap((operation) =>
      [...operation.branches]
        .filter((branch) => !branch.handled && branch.rejected)
        .map((branch) => branch.failure)
    );
  for (const operation of [...token.pendingReentrantOperations]) {
    if (!excluded.has(operation)) {
      closeTrackedOperation(operation);
      token.pendingReentrantOperations.delete(operation);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Detached plugin lifecycle mutation failed");
  }
}

async function settleReentrantOperations(token: HeldPluginInstallLock): Promise<void> {
  while ([...token.pendingReentrantOperations].some((operation) =>
    [...operation.branches].some((branch) => !branch.settled)
  )) {
    await Promise.allSettled(
      [...token.pendingReentrantOperations]
        .flatMap((operation) =>
          [...operation.branches]
            .filter((branch) => !branch.settled)
            .map((branch) => branch.promise)
        ),
    );
  }
  for (const operation of token.pendingReentrantOperations) {
    closeTrackedOperation(operation);
  }
  token.pendingReentrantOperations.clear();
}

function closeTrackedOperation(operation: TrackedReentrantOperation): void {
  if (operation.closed) return;
  operation.closed = true;
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

function getPluginLifecycleQuarantineErrorFor(
  pluginIds: readonly string[],
): Error | null {
  if (quarantinedPluginInstallLocks.has(ALL_PLUGIN_LOCK_KEY)) {
    return new PluginLifecycleQuarantinedError("all plugins");
  }
  const quarantinedPluginId = pluginIds.find((pluginId) =>
    quarantinedPluginInstallLocks.has(pluginId)
  );
  return quarantinedPluginId
    ? new PluginLifecycleQuarantinedError(quarantinedPluginId)
    : null;
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

async function waitForMultiplePluginLifecycleGate(
  gate: Promise<unknown>,
  pluginIds: readonly string[],
): Promise<void> {
  const pluginIdSet = new Set(pluginIds);
  await waitForLifecycleGate(
    gate,
    (lockKey) =>
      lockKey === ALL_PLUGIN_LOCK_KEY || pluginIdSet.has(lockKey),
    () => getPluginLifecycleQuarantineErrorFor(pluginIds),
  );
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
  ensurePluginStateReadyForInstall: (pluginId: string) => Promise<void>;
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
    ensurePluginStateReadyForInstall,
    broadcastInstallProgress,
    emitPluginInstalled,
    refreshPluginNotifications,
  } = options;
  assertAppUpdateInstallNotRequested();
  const catalogState = await resolveMarketplaceLifecycleState(pluginMarketplace, requestedPluginId);
  const resolvedLifecyclePluginId = pluginRuntime.resolvePluginId(
    lifecyclePluginId ?? catalogState.pluginId,
  );
  if (
    pluginRuntime.resolvePluginInstallIdIfKnown(resolvedLifecyclePluginId)
    === null
  ) {
    throw new Error(
      `Statically configured plugin cannot be replaced from the marketplace: ${resolvedLifecyclePluginId}`,
    );
  }
  const progressSlug = eventSlug ?? resolvedLifecyclePluginId;

  // A pending restart can own this lifecycle lock while waiting on dependency
  // preparation. Cancel it before this outer lock queues; removePlugin cannot
  // reach its own cancellation boundary until after this callback starts.
  pluginRuntime.cancelPendingRestart(resolvedLifecyclePluginId);
  return withResolvedPluginInstallLocks(
    () => [
      catalogState.pluginId,
      pluginRuntime.resolvePluginId(
        lifecyclePluginId ?? catalogState.pluginId,
      ),
    ],
    async () => {
    const currentCatalogState = await resolveMarketplaceLifecycleState(pluginMarketplace, requestedPluginId);
    const currentRuntimePluginId = pluginRuntime.resolvePluginId(currentCatalogState.pluginId);
    if (
      pluginRuntime.resolvePluginInstallIdIfKnown(currentRuntimePluginId)
      === null
    ) {
      throw new Error(
        `Statically configured plugin cannot be replaced from the marketplace: ${currentRuntimePluginId}`,
      );
    }
    await ensurePluginStateReadyForInstall(currentCatalogState.pluginId);
    if (currentRuntimePluginId !== currentCatalogState.pluginId) {
      await ensurePluginStateReadyForInstall(currentRuntimePluginId);
    }
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
      pluginRuntime.listPluginIds().includes(currentRuntimePluginId);
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
        if (
          expectedVersionForGuard
          && prepared.manifest.version !== expectedVersionForGuard
        ) {
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
    const installedPluginId = pluginRuntime.resolvePluginId(result.pluginId);
    if (!pluginRuntime.listPluginIds().includes(installedPluginId)) {
      throw new Error(
        `atomic install committed without active runtime: ${installedPluginId}`,
      );
    }
    broadcastInstallProgress?.({ slug: progressSlug, phase: "registering" });
    emitPluginInstalled?.({ pluginId: installedPluginId, source: "marketplace" });
    refreshPluginNotifications?.();
    return { ...result, pluginId: installedPluginId };
    },
    (pluginIds) => {
      for (const pluginId of pluginIds) {
        pluginRuntime.cancelPendingRestart(pluginId);
      }
    },
  );
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
