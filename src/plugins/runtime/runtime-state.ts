import { basename, dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFile } from "node:fs/promises";
import type { ValidateFunction } from "ajv";
import type {
  PluginAccessSpec,
  PluginHostApi,
  PluginManifest,
  PluginToolHandler,
  RuntimePlugin,
} from "../types.js";
import { createPluginStorage } from "../storage.js";
import type { PluginDeploymentGuard } from "../deployment-guard.js";
import { installReceiptPath } from "../plugin-install-receipt.js";
import type {
  PluginRuntimeGenerationAccess,
  PluginRuntimeGenerationLifecycle,
  PluginRuntimeGenerationProjection,
  PluginRuntimeRetirementStep,
  PreparedPluginRuntimeGenerationPublication,
} from "../plugin-host-generation.js";
import { HostApiGenerationScope } from "../plugin-host-effect-scope.js";
import {
  materializePluginGenerationRoot,
  removeRetainedPluginGeneration,
} from "../plugin-contributions.js";
import { appVersionSatisfiesMin } from "../../shared/semver-compare.js";
import { getLvisAppVersion } from "../../shared/app-version.js";
import type { PluginInstallFailureKind } from "../../shared/plugin-install-failure.js";

import {
  buildManifestValidator,
  getDeclaredEmittedEvents,
  parsePluginJson,
} from "./manifest-validation.js";
import {
  readEnabledManifestSnapshots,
  resolveManifestLoadPlan,
} from "./snapshots.js";
import {
  buildImportUrl,
  createNoopHostApi,
  ensurePluginDataDir,
  resolveEntryPath,
} from "./sandbox.js";
import type {
  LoadedPlugin,
  ManifestLoadPlan,
  ManifestSnapshot,
  PluginLifecycleHookScope,
  SinglePluginStartResult,
} from "./types.js";
import { PerfStatsTracker } from "./perf-stats.js";
import { ConfigOverrideStore } from "./config-overrides.js";
import { PreparationTracker } from "./preparation.js";
import { isModelVisible } from "./tool-visibility.js";
import { createLogger } from "../../lib/logger.js";
import { plog, PluginPhase } from "../lifecycle-log.js";
import type {
  PluginHostApiIncarnation,
  PluginRuntimeOptions,
  PluginStartPreparationContext,
  PluginToolInvocationDelegate,
} from "./index.js";

const log = createLogger("plugin-runtime");
const START_FAILURE_STOP_TIMEOUT_MS = 2_000;
const HOST_API_OPERATION_DRAIN_TIMEOUT_MS = 10_000;

export type RestartPluginResult = "started" | "deferred" | "failed" | undefined;

export abstract class PluginRuntimeState {
  protected readonly hostRoot: string;
  protected readonly manifestPaths: string[];
  protected readonly registryPath?: string;
  protected readonly pluginsRoot?: string;
  protected readonly configStore: ConfigOverrideStore;
  protected readonly createHostApi?: (
    pluginId: string,
    manifest: PluginManifest,
    pluginDataDir: string,
    incarnation: PluginHostApiIncarnation,
  ) => PluginHostApi;
  protected readonly deploymentGuard?: PluginDeploymentGuard;
  protected readonly installReceiptCacheRoot?: string;
  protected readonly auditLog?: (level: "info" | "warn" | "error", message: string, data?: unknown) => void;
  protected readonly onDisable?: (pluginId: string) => void;
  protected readonly onPluginUiRevisionChange?: (pluginId: string) => void;
  protected readonly onEnable?: (pluginId: string) => void;
  protected readonly onActiveStateChange?: (
    pluginId: string,
    enabled: boolean,
  ) => Promise<void> | void;
  protected readonly preparePluginStart?: (context: PluginStartPreparationContext) => Promise<void> | void | null | undefined;
  protected plugins = new Map<string, LoadedPlugin>();
  protected methodMap = new Map<string, { pluginId: string; handler: PluginToolHandler }>();
  protected readonly perf = new PerfStatsTracker();
  protected disposers = new Map<string, Array<() => void>>();
  protected readonly knownPluginManifests = new Map<string, PluginManifest>();
  protected readonly knownPluginAccessGrants = new Map<string, PluginAccessSpec | undefined>();
  protected readonly knownInstallAliases = new Map<string, Set<string>>();
  protected readonly knownToolOwners = new Map<string, string>();
  protected readonly knownEventOwners = new Map<string, string>();
  protected readonly failedPluginIds = new Set<string>();
  protected readonly failedPluginStubs = new Map<string, { name: string; description: string }>();
  /**
   * Structured load-failure classification for the Plugin Doctor, keyed by the
   * plugin id (or the registry-id hint when the manifest never parsed).
   * Populated by {@link markFailed}; only surfaced on cards whose `loadStatus`
   * is `"failed"`, and cleared when the plugin loads successfully. Lets the
   * Doctor tell reinstall-fixable failures (stale/pre-v6 schema manifest) apart
   * from not-locally-fixable ones (app-version incompatibility).
   */
  protected readonly loadFailureInfo = new Map<
    string,
    { installFailureKind?: PluginInstallFailureKind; installFailureMessage?: string }
  >();
  protected readonly disabledPluginIds = new Set<string>();
  /**
   * #1176 active/inactive — plugins toggled inactive at runtime via
   * {@link setPluginEnabled}. Orthogonal to {@link disabledPluginIds} (the
   * load/unload state): an inactive plugin stays *loaded* but its tools are
   * hidden from the model's per-turn scope. `enabled !== false` is the active
   * predicate, so absence from this set means active (migration-safe default).
   */
  protected readonly inactivePluginIds = new Set<string>();
  protected readonly preparation: PreparationTracker;
  protected readonly pendingRestarts = new Map<string, Promise<RestartPluginResult>>();
  protected readonly pendingRestartPreparations = new Map<string, Promise<void>>();
  /**
   * Hash-only authenticated session state. The principal hash includes a
   * per-login nonce so a later login to the same account cannot revive grants
   * admitted under an earlier session.
   */
  protected pluginAccountHashes = new Map<string, {
    identityHash: string;
    principalHash: string;
  }>();
  /** Latest auth invocation admitted for each immutable plugin generation. */
  protected pluginAuthInvocationEpochs = new Map<string, number>();
  protected nextPluginAuthInvocationEpoch = 0;
  /** Monotonic generation used to reject stale async add/restart commits. */
  protected readonly pluginLifecycleGenerations = new Map<string, number>();
  /**
   * Process-lifetime quarantine for lifecycle work whose execution state is
   * unknowable. In-process ESM evaluation and plugin hooks cannot be cancelled;
   * another same-id incarnation would permit concurrent stale bodies.
   */
  protected readonly quarantinedPluginLifecycles = new Map<string, string>();
  /** HostApi incarnations whose plugin factory has not committed an instance. */
  private readonly pendingHostApiIncarnations = new Map<string, Set<() => void>>();
  protected nextPluginLifecycleGeneration = 0;
  protected readonly pluginUiRevisions = new Map<string, number>();
  protected nextPluginUiRevision = 0;
  protected toolInvocationDelegate: PluginToolInvocationDelegate | null = null;
  protected generationAccess: PluginRuntimeGenerationAccess | undefined;
  protected generationLifecycle: PluginRuntimeGenerationLifecycle | undefined;
  protected readonly pinnedGenerations =
    new AsyncLocalStorage<ReadonlyMap<string, string>>();
  protected loaded = false;
  /** §B-1 — lazily-compiled AJV validator for plugin.schema.json. */
  protected manifestValidator: ValidateFunction | null = null;
  protected manifestValidatorPromise: Promise<ValidateFunction> | null = null;

  protected abstract instantiateAndStartSinglePlugin(
    plan: ManifestLoadPlan,
    manifest: PluginManifest,
    approvedPluginAccess: PluginAccessSpec | undefined,
    opts?: { skipPreparation?: boolean; cacheBust?: boolean; shouldCommit?: () => boolean },
  ): Promise<SinglePluginStartResult>;

  protected hasTrackedPluginState(pluginId: string): boolean {
    return this.plugins.has(pluginId)
      || this.knownPluginManifests.has(pluginId)
      || this.failedPluginIds.has(pluginId)
      || this.failedPluginStubs.has(pluginId)
      || this.disabledPluginIds.has(pluginId)
      || this.inactivePluginIds.has(pluginId);
  }

  constructor(options: PluginRuntimeOptions) {
    this.hostRoot = resolve(options.hostRoot);
    this.manifestPaths = (options.manifestPaths ?? []).map((path) => resolve(path));
    this.registryPath = options.registryPath ? resolve(options.registryPath) : undefined;
    this.pluginsRoot = options.pluginsRoot ? resolve(options.pluginsRoot) : undefined;
    this.configStore = new ConfigOverrideStore(options.configOverrides ?? {});
    this.createHostApi = options.createHostApi;
    this.deploymentGuard = options.deploymentGuard;
    this.installReceiptCacheRoot = options.installReceiptCacheRoot
      ? resolve(options.installReceiptCacheRoot)
      : undefined;
    this.auditLog = options.auditLog;
    this.onDisable = options.onDisable;
    this.onPluginUiRevisionChange = options.onPluginUiRevisionChange;
    this.onEnable = options.onEnable;
    this.onActiveStateChange = options.onActiveStateChange;
    this.preparePluginStart = options.preparePluginStart;
    this.preparation = new PreparationTracker({
      preparePluginStart: options.preparePluginStart,
      instantiateAndStartSinglePlugin: (plan, manifest, approvedPluginAccess, opts) =>
        this.instantiateAndStartSinglePlugin(plan, manifest, approvedPluginAccess, opts),
      markFailed: (pluginId, stub) => this.markFailed(pluginId, stub),
      onDisable: options.onDisable,
    });
  }

  // ─── Manifest Validator (lazy) ─────────────────────────────────────────────

  protected async getManifestValidator(): Promise<ValidateFunction> {
    if (this.manifestValidator) return this.manifestValidator;
    if (!this.manifestValidatorPromise) {
      this.manifestValidatorPromise = buildManifestValidator()
        .then((validator) => {
          this.manifestValidator = validator;
          return validator;
        })
        .finally(() => {
          this.manifestValidatorPromise = null;
        });
    }
    return this.manifestValidatorPromise;
  }

  protected async readManifest(
    path: string,
    options: { report?: boolean } = {},
  ): Promise<PluginManifest> {
    const validator = await this.getManifestValidator();
    try {
      return await parsePluginJson(path, validator);
    } catch (err) {
      if (options.report !== false) this.reportPluginManifestRejected(path, err);
      throw err;
    }
  }

  protected reportPluginManifestRejected(path: string, error: unknown): void {
    try {
      this.auditLog?.("error", "plugin_manifest_rejected", {
        manifestPath: path,
        error: error instanceof Error ? error.message.slice(0, 500) : String(error),
      });
    } catch (auditError) {
      log.error({ manifestPath: path, err: auditError }, "plugin manifest rejection audit failed");
    }
  }

  // ─── Sandbox helpers (instance-context wrappers) ───────────────────────────

  protected resolveEntryPathForPlugin(pluginRoot: string, entry: string): string {
    return resolveEntryPath(pluginRoot, entry, this.hostRoot);
  }

  protected ensureDataDir(pluginId: string, pluginRoot: string): string {
    return ensurePluginDataDir(pluginId, pluginRoot, this.pluginsRoot);
  }

  protected buildHostApiIncarnation(
    pluginId: string,
    manifest: PluginManifest,
    pluginDataDir: string,
    hostEffects?: HostApiGenerationScope,
  ): {
    hostApi: PluginHostApi;
    disposers: Array<() => void>;
    deactivate: () => void;
    drainOperations: () => Promise<void>;
    commit: () => void;
    lifecycleHookScope: PluginLifecycleHookScope;
  } {
    const disposers: Array<() => void> = [];
    const pendingOperations = new Set<Promise<unknown>>();
    let active = true;
    const lifecycleHookScope: PluginLifecycleHookScope = { active: true, depth: 0 };
    let pending = true;
    let deactivate!: () => void;
    const forgetPending = () => {
      const pendingForPlugin = this.pendingHostApiIncarnations.get(pluginId);
      pendingForPlugin?.delete(deactivate);
      if (pendingForPlugin?.size === 0) {
        this.pendingHostApiIncarnations.delete(pluginId);
      }
      pending = false;
    };
    deactivate = () => {
      active = false;
      lifecycleHookScope.active = false;
      lifecycleHookScope.depth = 0;
      if (pending) forgetPending();
    };
    let pendingForPlugin = this.pendingHostApiIncarnations.get(pluginId);
    if (!pendingForPlugin) {
      pendingForPlugin = new Set();
      this.pendingHostApiIncarnations.set(pluginId, pendingForPlugin);
    }
    pendingForPlugin.add(deactivate);
    const incarnation: PluginHostApiIncarnation = {
      registerDisposer: (dispose) => {
        if (active) {
          disposers.push(dispose);
          return;
        }
        try { dispose(); } catch { /* best-effort stale cleanup */ }
      },
      trackOperation: <T>(operation: Promise<T>): Promise<T> => {
        const tracked = Promise.resolve(operation);
        pendingOperations.add(tracked);
        void tracked.then(
          () => pendingOperations.delete(tracked),
          () => pendingOperations.delete(tracked),
        );
        return tracked;
      },
      isActive: () => active,
      isLifecycleHookActive: () =>
        lifecycleHookScope.active && lifecycleHookScope.depth > 0,
      ...(hostEffects ? { generationScope: hostEffects } : {}),
    };
    try {
      const rawHostApi = this.createHostApi?.(
        pluginId,
        manifest,
        pluginDataDir,
        incarnation,
      ) ?? createNoopHostApi(pluginId, pluginDataDir);
      const hostApi = hostEffects ? hostEffects.wrapHostApi(rawHostApi) : rawHostApi;
      // Defence-in-depth: PluginHostApi.storage is required but partial hostApi
      // objects from test harnesses may omit it.
      if (!hostApi.storage) {
        hostApi.storage = createPluginStorage(pluginId, pluginDataDir);
      }
      return {
        hostApi,
        disposers,
        deactivate,
        drainOperations: async () => {
          if (pendingOperations.size === 0) return;
          let timer: NodeJS.Timeout | undefined;
          try {
            await Promise.race([
              Promise.allSettled([...pendingOperations]),
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () => reject(new Error(
                    `HostApi operation drain timeout (>${HOST_API_OPERATION_DRAIN_TIMEOUT_MS}ms)`,
                  )),
                  HOST_API_OPERATION_DRAIN_TIMEOUT_MS,
                );
              }),
            ]);
          } finally {
            if (timer) clearTimeout(timer);
          }
        },
        lifecycleHookScope,
        commit: () => {
          if (!active) {
            throw new Error(`Cannot commit inactive HostApi incarnation: ${pluginId}`);
          }
          if (pending) forgetPending();
        },
      };
    } catch (err) {
      deactivate();
      throw err;
    }
  }

  protected async runPluginLifecycleHook<T>(
    scope: PluginLifecycleHookScope | undefined,
    hook: () => Promise<T> | T,
  ): Promise<T> {
    if (!scope) return await hook();
    scope.depth += 1;
    try {
      return await hook();
    } finally {
      scope.depth = Math.max(0, scope.depth - 1);
    }
  }

  protected markPluginUiRevision(pluginId: string): number {
    const revision = ++this.nextPluginUiRevision;
    this.pluginUiRevisions.set(pluginId, revision);
    this.onPluginUiRevisionChange?.(pluginId);
    return revision;
  }

  protected invalidatePluginUiRevision(pluginId: string): void {
    this.pluginUiRevisions.delete(pluginId);
    this.onPluginUiRevisionChange?.(pluginId);
  }

  protected getPluginUiRevision(pluginId: string): number {
    return this.pluginUiRevisions.get(pluginId) ?? this.markPluginUiRevision(pluginId);
  }

  protected buildPluginUiEntryUrl(pluginId: string, manifest: PluginManifest, entryPath: string): string {
    const url = new URL(buildImportUrl(entryPath));
    url.searchParams.set("lvisPluginVersion", manifest.version ?? "0");
    url.searchParams.set("lvisRuntimeRevision", String(this.getPluginUiRevision(pluginId)));
    return url.href;
  }

  // ─── Load Plan & Snapshots ─────────────────────────────────────────────────

  protected async resolveManifestLoadPlanInternal(): Promise<ManifestLoadPlan[]> {
    return resolveManifestLoadPlan({
      manifestPaths: this.manifestPaths,
      registryPath: this.registryPath,
      pluginsRoot: this.pluginsRoot,
    });
  }

  protected async readSnapshotsInternal(
    loadPlan: ManifestLoadPlan[],
  ): Promise<Map<string, ManifestSnapshot>> {
    const validator = await this.getManifestValidator();
    return readEnabledManifestSnapshots(loadPlan, validator);
  }

  /**
   * #885 v6 — MODEL-ONLY (ratified security decision §2.4a). The `knownToolOwners`
   * map is the pre-runtime `??` fallback in `resolveToolOwner`, feeding the
   * "plugin still installing" guard (`throwIfToolOwnerNotReady`). Today's `tools[]` was model-facing
   * only; a naive all-names `.map` would silently add the app-only auth trio to the
   * access-control map (a widening). `isModelVisible` reproduces today's EXACT set;
   * UI-only ownership still resolves at runtime via `methodMap` (all names), which stays
   * authoritative.
   *
   * HOLDS AFTER app-only tools became registry `Tool`s. Registry membership (what may
   * execute under the gate) and model exposure (what the LLM is shown) were split apart;
   * THIS map independently records names while a plugin is starting, and stays
   * exactly the model-visible set.
   *
   * ONE method, three callers (`rememberPluginManifest`, `load`, single-plugin add), so
   * the MODEL-ONLY `.filter(isModelVisible)` lives once. Pinned by
   * `__tests__/known-tool-owners-model-only.test.ts` (which exercises
   * `rememberPluginManifest`; the other two callers share this method, so the pin covers
   * them too). A future all-names `.map` here flips that pin closed.
   */
  protected rememberToolOwners(pluginId: string, manifest: PluginManifest): void {
    for (const t of (manifest.tools ?? []).filter(isModelVisible)) {
      this.knownToolOwners.set(t.name, pluginId);
    }
  }

  protected rememberPluginManifest(
    pluginId: string,
    manifest: PluginManifest,
    approvedPluginAccess: PluginAccessSpec | undefined,
  ): void {
    this.knownPluginManifests.set(pluginId, manifest);
    if (approvedPluginAccess) {
      this.knownPluginAccessGrants.set(pluginId, approvedPluginAccess);
    } else {
      this.knownPluginAccessGrants.delete(pluginId);
    }
    for (const [toolName, ownerId] of [...this.knownToolOwners.entries()]) {
      if (ownerId === pluginId) this.knownToolOwners.delete(toolName);
    }
    for (const [eventType, ownerId] of [...this.knownEventOwners.entries()]) {
      if (ownerId === pluginId) this.knownEventOwners.delete(eventType);
    }
    this.rememberToolOwners(pluginId, manifest); // #885 §2.4a MODEL-ONLY (see method)
    for (const eventType of getDeclaredEmittedEvents(manifest)) {
      this.knownEventOwners.set(eventType, pluginId);
    }
  }

  protected rememberPluginInstallAlias(pluginId: string, alias: string | undefined): void {
    const normalizedPluginId = pluginId.trim();
    const normalizedAlias = alias?.trim();
    if (!normalizedPluginId || !normalizedAlias || normalizedAlias === normalizedPluginId) return;
    let aliases = this.knownInstallAliases.get(normalizedPluginId);
    if (!aliases) {
      aliases = new Set<string>();
      this.knownInstallAliases.set(normalizedPluginId, aliases);
    }
    aliases.add(normalizedAlias);
  }

  protected resolveKnownPluginId(pluginId: string): string {
    if (this.knownInstallAliases.has(pluginId)) return pluginId;
    for (const [canonicalId, aliases] of this.knownInstallAliases) {
      if (aliases.has(pluginId)) return canonicalId;
    }
    return pluginId;
  }

  protected getPluginInstallAliases(pluginId: string): string[] | undefined {
    const aliases = this.knownInstallAliases.get(pluginId);
    if (!aliases || aliases.size === 0) return undefined;
    return [...aliases].sort();
  }

  protected beginPluginLifecycleOperation(pluginId: string): number {
    const generation = ++this.nextPluginLifecycleGeneration;
    const canonicalId = this.resolveKnownPluginId(pluginId);
    const lifecycleIds = new Set([
      pluginId,
      canonicalId,
      ...(this.knownInstallAliases.get(canonicalId) ?? []),
    ]);
    for (const lifecycleId of lifecycleIds) {
      for (const deactivate of this.pendingHostApiIncarnations.get(lifecycleId) ?? []) {
        deactivate();
      }
    }
    this.pluginLifecycleGenerations.set(canonicalId, generation);
    this.pluginLifecycleGenerations.set(pluginId, generation);
    for (const alias of this.knownInstallAliases.get(canonicalId) ?? []) {
      this.pluginLifecycleGenerations.set(alias, generation);
    }
    return generation;
  }

  protected assertPluginLifecycleAvailable(pluginId: string): void {
    const canonicalId = this.resolveKnownPluginId(pluginId);
    const reason = this.quarantinedPluginLifecycles.get(canonicalId)
      ?? this.quarantinedPluginLifecycles.get(pluginId);
    if (!reason) return;
    const error = new Error(
      `Plugin lifecycle is quarantined until host restart: ${canonicalId} (${reason})`,
    ) as Error & { code?: string };
    error.code = "plugin-lifecycle-quarantined";
    throw error;
  }

  protected quarantinePluginLifecycle(pluginId: string, reason: string): void {
    const canonicalId = this.resolveKnownPluginId(pluginId);
    this.quarantinedPluginLifecycles.set(canonicalId, reason);
    this.quarantinedPluginLifecycles.set(pluginId, reason);
    for (const alias of this.knownInstallAliases.get(canonicalId) ?? []) {
      this.quarantinedPluginLifecycles.set(alias, reason);
    }
    this.markFailed(canonicalId);
  }

  protected adoptPluginLifecycleIdentity(
    requestedPluginId: string,
    canonicalPluginId: string,
    generation: number,
  ): boolean {
    const requestedGeneration = this.pluginLifecycleGenerations.get(requestedPluginId);
    const canonicalGeneration = this.pluginLifecycleGenerations.get(canonicalPluginId);
    if (requestedGeneration !== generation || (canonicalGeneration !== undefined && canonicalGeneration > generation)) {
      return false;
    }
    this.rememberPluginInstallAlias(canonicalPluginId, requestedPluginId);
    this.pluginLifecycleGenerations.set(canonicalPluginId, generation);
    this.pluginLifecycleGenerations.set(requestedPluginId, generation);
    for (const alias of this.knownInstallAliases.get(canonicalPluginId) ?? []) {
      this.pluginLifecycleGenerations.set(alias, generation);
    }
    return true;
  }

  protected isPluginLifecycleOperationCurrent(pluginId: string, generation: number): boolean {
    const canonicalId = this.resolveKnownPluginId(pluginId);
    const keys = new Set([
      canonicalId,
      pluginId,
      ...(this.knownInstallAliases.get(canonicalId) ?? []),
    ]);
    return [...keys].every(
      (key) => this.pluginLifecycleGenerations.get(key) === generation,
    );
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  waitForPluginReady(pluginId: string): Promise<void> {
    const canonicalId = this.resolveKnownPluginId(pluginId);
    if (this.plugins.has(canonicalId)) return Promise.resolve();
    return this.preparation.waitForReady(canonicalId);
  }

  /**
   * Verify installed bytes before parsing any manifest, then parse each accepted
   * manifest exactly once. Work overlaps with a conservative bound while the
   * returned array preserves registry/load-plan order for deterministic state
   * projection and failure reporting.
   */

  // ─── Private helpers ───────────────────────────────────────────────────────

  protected resetLoadedState(): void {
    for (const plugin of this.plugins.values()) {
      plugin.deactivateHostApi?.();
    }
    for (const pending of this.pendingHostApiIncarnations.values()) {
      for (const deactivate of pending) {
        deactivate();
      }
    }
    this.pendingHostApiIncarnations.clear();
    for (const [, list] of this.disposers) {
      for (const d of list) {
        try { d(); } catch (err) {
          log.error(`disposer failed: %s`, (err as Error).message);
        }
      }
    }
    this.disposers.clear();
    this.knownPluginManifests.clear();
    this.knownPluginAccessGrants.clear();
    this.knownInstallAliases.clear();
    this.knownToolOwners.clear();
    this.knownEventOwners.clear();
    this.plugins.clear();
    for (const pluginId of this.pluginUiRevisions.keys()) {
      this.onPluginUiRevisionChange?.(pluginId);
    }
    this.pluginUiRevisions.clear();
    this.methodMap.clear();
    this.failedPluginIds.clear();
    this.failedPluginStubs.clear();
    this.loadFailureInfo.clear();
    this.disabledPluginIds.clear();
    this.preparation.clear();
    this.pendingRestarts.clear();
    this.pendingRestartPreparations.clear();
    this.pluginLifecycleGenerations.clear();
    this.loaded = false;
  }

  protected async stopAfterStartFailure(
    pluginId: string,
    instance: RuntimePlugin,
    lifecycleHookScope?: PluginLifecycleHookScope,
  ): Promise<boolean> {
    if (!instance.stop) return true;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.runPluginLifecycleHook(lifecycleHookScope, () => instance.stop!()),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`stop timeout (>${START_FAILURE_STOP_TIMEOUT_MS}ms)`)),
            START_FAILURE_STOP_TIMEOUT_MS,
          );
        }),
      ]);
      plog("debug", { pluginId, phase: PluginPhase.STOP_OK }, "stopped after start failure");
      return true;
    } catch (err) {
      this.quarantinePluginLifecycle(pluginId, (err as Error).message);
      plog("error", { pluginId, phase: PluginPhase.STOP_FAIL, err }, "stop after start failure failed");
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  protected async drainPluginHostApiOperations(
    pluginId: string,
    plugin: Pick<LoadedPlugin, "drainHostApiOperations">,
  ): Promise<boolean> {
    if (!plugin.drainHostApiOperations) return true;
    try {
      await plugin.drainHostApiOperations();
      return true;
    } catch (err) {
      this.quarantinePluginLifecycle(pluginId, (err as Error).message);
      plog(
        "error",
        { pluginId, phase: PluginPhase.STOP_FAIL, err },
        "HostApi operation drain failed",
      );
      return false;
    }
  }

  protected async settleCommittedRetirement(
    pluginId: string,
    retirement: Promise<void>,
    context: string,
  ): Promise<void> {
    try {
      await retirement;
    } catch (error) {
      log.error(
        `plugin generation retirement failed after ${context} for ${pluginId}: %s`,
        error instanceof Error ? error.message : String(error),
      );
      this.auditLog?.("error", "plugin_generation_retirement_failed", {
        pluginId,
        context,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  protected async captureCommittedRetirementFailure(
    pluginId: string,
    retirement: Promise<void>,
    context: string,
  ): Promise<unknown | undefined> {
    try {
      await this.settleCommittedRetirement(pluginId, retirement, context);
      return undefined;
    } catch (error) {
      return error;
    }
  }

  protected async failClosedLoadedPlugin(
    pluginId: string,
    plugin: LoadedPlugin,
    context: string,
  ): Promise<void> {
    this.markFailed(pluginId);
    plugin.deactivateHostApi?.();
    for (const method of plugin.methods.keys()) {
      this.methodMap.delete(method);
    }
    this.plugins.delete(pluginId);
    this.runPluginDisposers(pluginId, context);
    this.onDisable?.(pluginId);
    await this.stopAfterStartFailure(
      pluginId,
      plugin.instance,
      plugin.lifecycleHookScope,
    );
    await this.drainPluginHostApiOperations(pluginId, plugin);
  }

  protected runPluginDisposers(pluginId: string, context: string): void {
    const pluginDisposers = this.disposers.get(pluginId);
    if (!pluginDisposers) return;
    for (const dispose of pluginDisposers) {
      try {
        dispose();
      } catch (err) {
        log.error(`disposer failed during ${context}: %s`, (err as Error).message);
      }
    }
    this.disposers.delete(pluginId);
  }

  protected runDisposerList(disposers: Array<() => void>, context: string): void {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      } catch (err) {
        log.error(`disposer failed during ${context}: %s`, (err as Error).message);
      }
    }
  }

  protected throwIfPluginFailedAfterAdd(pluginId: string): void {
    if (!this.failedPluginIds.has(pluginId) && this.plugins.has(pluginId)) return;
    const stub = this.failedPluginStubs.get(pluginId);
    const reason = stub?.description ?? "plugin failed to load (see prior log)";
    throw new Error(`addPlugin failed for ${pluginId}: ${reason}`);
  }

  protected throwIfToolOwnerNotReady(toolName: string): void {
    const pluginId = this.knownToolOwners.get(toolName);
    if (!pluginId) return;
    if (this.preparation.isPreparing(pluginId)) {
      throw new Error(
        `Plugin '${pluginId}' is still installing its runtime dependencies. ` +
        `Try again after the plugin is ready.`,
      );
    }
    const failure = this.preparation.getFailure(pluginId);
    if (failure) {
      throw new Error(`Plugin '${pluginId}' runtime dependency install failed: ${failure}`);
    }
  }

  protected throwIfPluginNotStarted(pluginId: string): void {
    const plugin = this.plugins.get(pluginId);
    if (!plugin || plugin.started !== false) return;
    throw new Error(
      `Plugin '${pluginId}' is still starting. Try again after the plugin is ready.`,
    );
  }

  protected markFailed(
    pluginId: string,
    stub?: { name: string; description: string },
    failure?: { installFailureKind?: PluginInstallFailureKind; installFailureMessage?: string },
  ): void {
    this.failedPluginIds.add(pluginId);
    this.disabledPluginIds.delete(pluginId);
    if (stub) {
      this.failedPluginStubs.set(pluginId, stub);
    }
    if (failure && (failure.installFailureKind || failure.installFailureMessage)) {
      this.loadFailureInfo.set(pluginId, failure);
    }
  }

  /**
   * Plugin↔app minimum-version gate (LOAD boundary). Returns `true` and marks
   * the plugin failed when `manifest.requires.minAppVersion` is higher than the
   * running LVIS app version; the caller then skips `start()`. Returns `false`
   * (no field, or app satisfies the minimum) so the normal load path proceeds.
   *
   * Fail-closed: an unresolvable app version ("unknown" sentinel) blocks too.
   * The failed-stub `description` carries the English IPC error message; the
   * renderer maps the `incompatible-app-version` code to the Korean copy.
   */
  protected markIncompatibleAppVersion(manifest: PluginManifest): boolean {
    const minAppVersion = manifest.requires?.minAppVersion;
    if (!minAppVersion) return false;
    const currentAppVersion = getLvisAppVersion();
    if (appVersionSatisfiesMin(currentAppVersion, minAppVersion)) return false;

    const reason = `incompatible app version — plugin requires LVIS >= ${minAppVersion}, current ${currentAppVersion}`;
    log.error(`${manifest.id} rejected — ${reason}`);
    this.auditLog?.("error", "plugin_incompatible_app_version", {
      pluginId: manifest.id,
      required: minAppVersion,
      current: currentAppVersion,
    });
    this.markFailed(manifest.id, {
      name: manifest.name ?? manifest.id,
      description: `plugin requires LVIS >= ${minAppVersion}, current ${currentAppVersion}`,
    }, {
      // NOT locally reinstall-fixable — the marketplace ships the same too-new
      // package, so a reinstall re-throws. The Doctor must fall back to a
      // diagnosis directing the user to update the app.
      installFailureKind: "incompatible-app-version",
      installFailureMessage: `plugin requires LVIS >= ${minAppVersion}, current ${currentAppVersion}`,
    });
    return true;
  }

  protected inferEventOwner(eventType: string): string | undefined {
    const exactOwner = this.knownEventOwners.get(eventType);
    if (exactOwner) return exactOwner;
    const candidateIds = new Set<string>([
      ...this.plugins.keys(),
      ...this.knownPluginManifests.keys(),
    ]);
    let bestMatch: string | undefined;
    for (const pluginId of candidateIds) {
      if (!eventType.startsWith(`${pluginId}.`)) continue;
      if (!bestMatch || pluginId.length > bestMatch.length) {
        bestMatch = pluginId;
      }
    }
    return bestMatch;
  }

  protected async materializeImmutableRuntimeRoot(
    pluginId: string,
    pluginRoot: string,
    activationId: string,
  ): Promise<string> {
    this.requireGenerationLifecycle("materialize runtime root");
    if (!this.installReceiptCacheRoot) {
      throw new Error("plugin generation lifecycle requires installReceiptCacheRoot");
    }
    const manifestRaw = await readFile(resolve(pluginRoot, "plugin.json"), "utf8");
    const receiptRaw = await readFile(
      installReceiptPath(this.installReceiptCacheRoot, pluginId),
      "utf8",
    );
    const artifactGenerationId = createHash("sha256")
      .update(manifestRaw)
      .update("\0")
      .update(receiptRaw)
      .digest("hex");
    const generationId = createHash("sha256")
      .update(artifactGenerationId)
      .update("\0")
      .update(activationId)
      .digest("hex");
    return materializePluginGenerationRoot(
      pluginRoot,
      this.installReceiptCacheRoot,
      pluginId,
      generationId,
      receiptRaw,
    );
  }

  protected async removeUnpublishedRuntimeRoot(pluginId: string, runtimeRoot: string): Promise<void> {
    if (!this.installReceiptCacheRoot) {
      throw new Error("plugin generation lifecycle requires installReceiptCacheRoot");
    }
    const generationDir = dirname(runtimeRoot);
    const generationsRoot = resolve(this.installReceiptCacheRoot, pluginId, "generations");
    if (dirname(generationDir) !== generationsRoot || basename(runtimeRoot) !== "payload") return;
    const generationId = basename(generationDir);
    if (!/^[a-f0-9]{64}$/.test(generationId)) return;
    await removeRetainedPluginGeneration(this.installReceiptCacheRoot, pluginId, generationId);
  }

  setGenerationAccess(access: PluginRuntimeGenerationAccess): void {
    if (!("replaceRuntime" in access) || typeof access.replaceRuntime !== "function") {
      throw new Error("plugin runtime requires a complete generation lifecycle");
    }
    this.generationAccess = access;
    this.generationLifecycle = access as PluginRuntimeGenerationLifecycle;
  }

  protected requireGenerationLifecycle(operation: string): PluginRuntimeGenerationLifecycle {
    if (!this.generationLifecycle) {
      throw new Error(`[plugin-runtime] generation lifecycle is not bound before ${operation}`);
    }
    return this.generationLifecycle;
  }

  protected requireGenerationAccess(operation: string): PluginRuntimeGenerationAccess {
    if (!this.generationAccess) {
      throw new Error(`[plugin-runtime] generation access is not bound before ${operation}`);
    }
    return this.generationAccess;
  }

  getGenerationAccess(): PluginRuntimeGenerationAccess | undefined {
    return this.generationAccess;
  }

  getRuntimeGenerationProjection(pluginId: string): PluginRuntimeGenerationProjection | undefined {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return undefined;
    return Object.freeze({
      activationId: plugin.activationId,
      manifest: plugin.manifest,
      pluginRoot: plugin.pluginRoot,
      instance: plugin.instance,
      methods: new Map(plugin.methods),
      ...(plugin.approvedPluginAccess ? { approvedPluginAccess: plugin.approvedPluginAccess } : {}),
      disposers: Object.freeze([...(this.disposers.get(pluginId) ?? [])]),
      ...(plugin.hostEffects ? { hostEffects: plugin.hostEffects } : {}),
      ...(plugin.deactivateHostApi ? { deactivateHostApi: plugin.deactivateHostApi } : {}),
      ...(plugin.drainHostApiOperations
        ? { drainHostApiOperations: plugin.drainHostApiOperations }
        : {}),
      ...(plugin.lifecycleHookScope ? { lifecycleHookScope: plugin.lifecycleHookScope } : {}),
    });
  }

  prepareRuntimeGeneration(runtime: PluginRuntimeGenerationProjection): PreparedPluginRuntimeGenerationPublication {
    const pluginId = runtime.manifest.id;
    const nextMethods = new Map(this.methodMap);
    for (const [toolName, entry] of nextMethods) {
      if (entry.pluginId === pluginId) nextMethods.delete(toolName);
    }
    for (const toolName of runtime.methods.keys()) {
      const owner = nextMethods.get(toolName)?.pluginId;
      if (owner && owner !== pluginId) throw new Error(`Duplicate plugin method registered: ${toolName}`);
      nextMethods.set(toolName, { pluginId, handler: runtime.methods.get(toolName)! });
    }
    const nextPlugins = new Map(this.plugins);
    nextPlugins.set(pluginId, {
      activationId: runtime.activationId,
      manifest: runtime.manifest,
      pluginRoot: runtime.pluginRoot,
      instance: runtime.instance,
      methods: new Map(runtime.methods),
      approvedPluginAccess: runtime.approvedPluginAccess,
      hostEffects: runtime.hostEffects,
      started: true,
      deactivateHostApi: runtime.deactivateHostApi,
      drainHostApiOperations: runtime.drainHostApiOperations,
      lifecycleHookScope: runtime.lifecycleHookScope,
    });
    const nextDisposers = new Map(this.disposers);
    nextDisposers.set(pluginId, [...(runtime.disposers ?? [])]);
    const nextAccountHashes = new Map(
      [...this.pluginAccountHashes].filter(([key]) => !key.startsWith(`${pluginId}\0`)),
    );
    const nextAuthInvocationEpochs = new Map(
      [...this.pluginAuthInvocationEpochs].filter(([key]) => !key.startsWith(`${pluginId}\0`)),
    );
    const publishHostEffects = runtime.hostEffects?.preparePublish();
    let published = false;
    return Object.freeze({
      pluginId,
      publish: () => {
        if (published) return;
        this.plugins.get(pluginId)?.hostEffects?.supersede();
        publishHostEffects?.();
        this.methodMap = nextMethods;
        this.plugins = nextPlugins;
        this.disposers = nextDisposers;
        this.rememberPluginManifest(pluginId, runtime.manifest, runtime.approvedPluginAccess);
        this.markPluginUiRevision(pluginId);
        this.failedPluginIds.delete(pluginId);
        this.loadFailureInfo.delete(pluginId);
        this.disabledPluginIds.delete(pluginId);
        this.pluginAccountHashes = nextAccountHashes;
        this.pluginAuthInvocationEpochs = nextAuthInvocationEpochs;
        published = true;
      },
    });
  }

  prepareRuntimeRemoval(pluginId: string): PreparedPluginRuntimeGenerationPublication {
    const nextMethods = new Map(this.methodMap);
    for (const [toolName, entry] of nextMethods) {
      if (entry.pluginId === pluginId) nextMethods.delete(toolName);
    }
    const nextPlugins = new Map(this.plugins);
    nextPlugins.delete(pluginId);
    const nextDisposers = new Map(this.disposers);
    nextDisposers.delete(pluginId);
    const nextAccountHashes = new Map(
      [...this.pluginAccountHashes].filter(([key]) => !key.startsWith(`${pluginId}\0`)),
    );
    const nextAuthInvocationEpochs = new Map(
      [...this.pluginAuthInvocationEpochs].filter(([key]) => !key.startsWith(`${pluginId}\0`)),
    );
    let published = false;
    return Object.freeze({
      pluginId,
      publish: () => {
        if (published) return;
        this.plugins.get(pluginId)?.hostEffects?.supersede();
        this.methodMap = nextMethods;
        this.plugins = nextPlugins;
        this.disposers = nextDisposers;
        this.invalidatePluginUiRevision(pluginId);
        this.pluginAccountHashes = nextAccountHashes;
        this.pluginAuthInvocationEpochs = nextAuthInvocationEpochs;
        published = true;
      },
    });
  }

  async postPublishRuntimeGeneration(runtime: PluginRuntimeGenerationProjection): Promise<void> {
    const faults: Error[] = [];
    for (const error of runtime.hostEffects?.postPublish() ?? []) {
      log.error(`generation post-publish signal failed for ${runtime.manifest.id}: %s`, error.message);
      faults.push(error);
    }
    try {
      await runtime.instance.onPublished?.();
    } catch (error) {
      log.error(`generation post-publish startup degraded for ${runtime.manifest.id}: %s`, (error as Error).message);
      this.auditLog?.("warn", "plugin_post_publish_startup_degraded", {
        pluginId: runtime.manifest.id,
        version: runtime.manifest.version,
        error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
      });
      faults.push(error instanceof Error ? error : new Error(String(error)));
    }
    if (faults.length > 0) {
      throw new AggregateError(faults, `plugin '${runtime.manifest.id}' runtime post-publish failed`);
    }
  }

  /** Synchronous publish half of the host generation linearization point. */
  publishRuntimeGeneration(runtime: PluginRuntimeGenerationProjection): void {
    this.prepareRuntimeGeneration(runtime).publish();
  }

  /** Synchronous inactive-pointer publish. Resource teardown is lease-drained. */
  unpublishRuntimeGeneration(pluginId: string): void {
    this.prepareRuntimeRemoval(pluginId).publish();
  }

  prepareRuntimeRetirement(
    runtime: PluginRuntimeGenerationProjection,
  ): readonly PluginRuntimeRetirementStep[] {
    return Object.freeze([
      Object.freeze({
        phase: "runtime.authority" as const,
        run: () => {
          // Revoke general HostApi authority before user stop code runs. Any
          // exact operation admitted before publication can finish during
          // coordinator drain; retirement begins only after those leases have
          // been released.
          runtime.deactivateHostApi?.();
        },
      }),
      Object.freeze({
        phase: "runtime.stop" as const,
        run: async () => {
          const stopped = await this.stopAfterStartFailure(
            runtime.manifest.id,
            runtime.instance,
            runtime.lifecycleHookScope,
          );
          if (!stopped) {
            throw new Error(
              `generation stop failed or timed out for ${runtime.manifest.id}`,
            );
          }
        },
      }),
      Object.freeze({
        phase: "runtime.effects" as const,
        run: () => {
          const errors = [...(runtime.hostEffects?.retire() ?? [])];
          for (const dispose of runtime.disposers ?? []) {
            try {
              dispose();
            } catch (error) {
              log.error(
                `generation disposer failed for ${runtime.manifest.id}: %s`,
                (error as Error).message,
              );
              errors.push(error instanceof Error ? error : new Error(String(error)));
            }
          }
          if (errors.length > 0) {
            throw new AggregateError(
              errors,
              `plugin '${runtime.manifest.id}' generation effects retirement failed`,
            );
          }
        },
      }),
      Object.freeze({
        phase: "runtime.drain" as const,
        run: async () => {
          if (!runtime.drainHostApiOperations) return;
          try {
            await runtime.drainHostApiOperations();
          } catch (error) {
            log.error(
              `generation HostApi drain failed for ${runtime.manifest.id}: %s`,
              (error as Error).message,
            );
            throw error;
          }
        },
      }),
    ]);
  }

  protected async withPinnedGeneration<T>(
    pluginId: string,
    operation: (
      projection: PluginRuntimeGenerationProjection,
      generationId: string,
    ) => Promise<T>,
    expectedGenerationId?: string,
  ): Promise<T> {
    const access = this.requireGenerationAccess("plugin operation");
    const pinned = expectedGenerationId ?? this.pinnedGenerations.getStore()?.get(pluginId);
    const lease = pinned
      ? await access.acquireExact(pluginId, pinned)
      : await access.acquire(pluginId);
    const next = new Map(this.pinnedGenerations.getStore() ?? []);
    next.set(pluginId, lease.generation.generationId);
    try {
      return await access.runWithLease(
        lease,
        () => this.pinnedGenerations.run(
          Object.freeze(next) as ReadonlyMap<string, string>,
          () => operation(lease.generation.state.runtime, lease.generation.generationId),
        ),
      );
    } finally {
      lease.release();
    }
  }

  /**
   * Run a host-owned integration against the exact immutable plugin instance
   * admitted for the duration of the operation. Callers must not retain the
   * instance beyond the callback: disable, update, rollback, and uninstall all
   * wait for this lease before retiring the generation.
   */
  async withPluginInstanceLease<TPlugin, TResult>(
    pluginId: string,
    operation: (instance: TPlugin) => Promise<TResult>,
  ): Promise<TResult> {
    return this.withPinnedGeneration(
      pluginId,
      async (projection) => operation(projection.instance as TPlugin),
    );
  }
}
