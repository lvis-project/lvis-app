import { resolve } from "node:path";
import type { ValidateFunction } from "ajv";
import type {
  PluginAccessSpec,
  PluginHostApi,
  PluginManifest,
  PluginToolHandler,
  RuntimePlugin,
} from "../types.js";
import type { PluginDeploymentGuard } from "../deployment-guard.js";
import { appVersionSatisfiesMin } from "../../shared/semver-compare.js";
import { getLvisAppVersion } from "../../shared/app-version.js";
import type { PluginInstallFailureKind } from "../../shared/plugin-install-failure.js";

import {
  buildManifestValidator,
  getDeclaredEmittedEvents,
  parsePluginJson,
} from "./manifest-validation.js";
import {
  resolveManifestLoadPlan,
} from "./snapshots.js";
import {
  buildImportUrl,
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

export interface PendingRestartCancellation {
  generation: number;
  cancelled: boolean;
  readonly promise: Promise<void>;
  cancel(): void;
}

export abstract class PluginRuntimeState {
  protected readonly hostRoot: string;
  protected readonly manifestPaths: string[];
  protected readonly registryPath?: string;
  protected readonly pluginsRoot?: string;
  protected readonly configStore: ConfigOverrideStore;
  protected readonly createHostApi: (
    pluginId: string,
    manifest: PluginManifest,
    pluginDataDir: string,
    incarnation: PluginHostApiIncarnation,
  ) => PluginHostApi;
  protected readonly deploymentGuard?: PluginDeploymentGuard;
  protected readonly installReceiptCacheRoot?: string;
  protected readonly auditLog?: (level: "info" | "warn" | "error", message: string, data?: unknown) => void;
  protected readonly onDisable?: (pluginId: string) => void;
  protected readonly onEnable?: (pluginId: string) => void;
  protected readonly onActiveStateChange?: (pluginId: string, enabled: boolean) => void;
  protected readonly preparePluginStart?: (context: PluginStartPreparationContext) => Promise<void> | void | null | undefined;
  protected readonly plugins = new Map<string, LoadedPlugin>();
  protected readonly methodMap = new Map<string, { pluginId: string; handler: PluginToolHandler }>();
  protected readonly perf = new PerfStatsTracker();
  protected readonly disposers = new Map<string, Array<() => void>>();
  protected readonly knownPluginManifests = new Map<string, PluginManifest>();
  protected readonly knownPluginAccessGrants = new Map<string, PluginAccessSpec | undefined>();
  protected readonly knownInstallAliases = new Map<string, Set<string>>();
  protected readonly knownInstallClaims = new Map<string, string | null>();
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
  protected readonly pendingRestartCancellations = new Map<string, PendingRestartCancellation>();
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
  /** A RuntimePlugin instance's stop hook must execute at most once. */
  private readonly pluginStopOperations = new WeakMap<RuntimePlugin, Promise<boolean>>();
  protected nextPluginLifecycleGeneration = 0;
  protected readonly pluginUiRevisions = new Map<string, number>();
  protected nextPluginUiRevision = 0;
  protected toolInvocationDelegate: PluginToolInvocationDelegate | null = null;
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

  constructor(options: PluginRuntimeOptions) {
    if (typeof options.createHostApi !== "function") {
      throw new Error(
        "PluginRuntime requires an explicit createHostApi factory; test harnesses may inject createNoopHostApiForTests",
      );
    }
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

  /**
   * Live view of the raw config-override map, backed by {@link configStore}.
   * Retained for tests that assert against the internal override map.
   */
  protected get configOverrides(): Record<string, Record<string, unknown>> {
    return this.configStore.all();
  }

  setConfigOverride(pluginId: string, config: Record<string, unknown>): void {
    this.configStore.set(this.resolveKnownPluginId(pluginId), config);
  }

  getConfigOverride(pluginId: string): Record<string, unknown> | undefined {
    return this.configStore.get(this.resolveKnownPluginId(pluginId));
  }

  mergeConfigOverride(pluginId: string, config: Record<string, unknown>): void {
    this.configStore.merge(this.resolveKnownPluginId(pluginId), config);
  }

  /** Merge host-injected values into the wildcard (`"*"`) config slot. */
  setWildcardConfigOverride(config: Record<string, unknown>): void {
    this.configStore.setWildcard(config);
  }

  /** Shallow copy of the wildcard config slot. */
  getWildcardConfigOverride(): Record<string, unknown> {
    return this.configStore.getWildcard();
  }

  /** Clear only the named wildcard keys, preserving unrelated host values. */
  clearWildcardConfigOverride(keys: string[]): void {
    this.configStore.clearWildcard(keys);
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
      if (!active && !pending) return;
      active = false;
      lifecycleHookScope.active = false;
      lifecycleHookScope.depth = 0;
      if (pending) {
        forgetPending();
        // A factory may never settle after invalidation. Pending incarnations
        // have not transferred their disposer list into `this.disposers`, so
        // invalidation itself owns immediate cleanup. Splicing makes every late
        // factory/error continuation's cleanup idempotent.
        const pendingDisposers = disposers.splice(0);
        this.runDisposerList(pendingDisposers, "pending HostApi invalidation");
      }
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
    };
    try {
      const hostApi = this.createHostApi(
        pluginId,
        manifest,
        pluginDataDir,
        incarnation,
      );
      if (!hostApi.storage) {
        throw new Error(
          `createHostApi returned an incomplete HostApi without storage: ${pluginId}`,
        );
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
    return revision;
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
    const normalizedAlias = alias?.trim() || undefined;
    if (!normalizedPluginId) return;
    this.assertPluginIdentityNamespace([
      { pluginId: normalizedPluginId, alias: normalizedAlias },
    ]);
    this.knownInstallClaims.set(normalizedPluginId, normalizedAlias ?? null);
    if (!normalizedAlias || normalizedAlias === normalizedPluginId) return;
    let aliases = this.knownInstallAliases.get(normalizedPluginId);
    if (!aliases) {
      aliases = new Set<string>();
      this.knownInstallAliases.set(normalizedPluginId, aliases);
    }
    aliases.add(normalizedAlias);
  }

  /**
   * Manifest ids and deployment aliases share every public lifecycle entry
   * point, so they must form one unambiguous namespace. Validate a complete
   * batch before boot mutates runtime state, and validate again at each
   * incremental alias adoption.
   */
  protected assertPluginIdentityNamespace(
    mappings: Iterable<{ pluginId: string; alias?: string }>,
    reservedInstallIds: Iterable<string> = [],
  ): void {
    const normalizedMappings = [...mappings]
      .map(({ pluginId, alias }) => ({
        pluginId: pluginId.trim(),
        alias: alias?.trim(),
      }))
      .filter(({ pluginId }) => pluginId.length > 0);
    const normalizedReservedIds = [...reservedInstallIds]
      .map((pluginId) => pluginId.trim())
      .filter(Boolean);
    const existingCanonicalIds = new Set([
      ...this.knownPluginManifests.keys(),
      ...this.plugins.keys(),
      ...this.knownInstallAliases.keys(),
      ...this.knownInstallClaims.keys(),
    ]);
    const canonicalIds = new Set([
      ...existingCanonicalIds,
      ...normalizedMappings.map(({ pluginId }) => pluginId),
    ]);
    const aliasOwners = new Map<string, string>();

    const recordAliasOwner = (alias: string, canonicalId: string) => {
      const existingOwner = aliasOwners.get(alias);
      if (existingOwner && existingOwner !== canonicalId) {
        throw this.pluginIdentityCollision(
          alias,
          `install alias for both '${existingOwner}' and '${canonicalId}'`,
        );
      }
      aliasOwners.set(alias, canonicalId);
    };
    for (const [canonicalId, aliases] of this.knownInstallAliases) {
      for (const alias of aliases) recordAliasOwner(alias, canonicalId);
    }

    const canonicalClaimCounts = new Map<string, number>();
    for (const { pluginId, alias } of normalizedMappings) {
      const claimCount = (canonicalClaimCounts.get(pluginId) ?? 0) + 1;
      canonicalClaimCounts.set(pluginId, claimCount);
      if (claimCount > 1) {
        throw this.pluginIdentityCollision(
          pluginId,
          `multiple active artifacts claim canonical id '${pluginId}'`,
        );
      }
      const aliasOwner = aliasOwners.get(pluginId);
      if (aliasOwner && aliasOwner !== pluginId) {
        throw this.pluginIdentityCollision(
          pluginId,
          `canonical id for '${pluginId}' and install alias for '${aliasOwner}'`,
        );
      }
      if (existingCanonicalIds.has(pluginId)) {
        const incomingClaim = alias ?? null;
        const reusesKnownIdentity = this.knownInstallClaims.has(pluginId)
          ? this.knownInstallClaims.get(pluginId) === incomingClaim
          : !alias
            ? !(this.knownInstallAliases.get(pluginId)?.size)
            : alias === pluginId
            ? !(this.knownInstallAliases.get(pluginId)?.size)
            : this.knownInstallAliases.get(pluginId)?.has(alias) === true;
        if (!reusesKnownIdentity) {
          throw this.pluginIdentityCollision(
            alias ?? pluginId,
            `new artifact claim for existing canonical id '${pluginId}'`,
          );
        }
      }
    }
    for (const { pluginId, alias } of normalizedMappings) {
      if (!alias || alias === pluginId) continue;
      if (canonicalIds.has(alias)) {
        throw this.pluginIdentityCollision(
          alias,
          `canonical id for '${alias}' and install alias for '${pluginId}'`,
        );
      }
      recordAliasOwner(alias, pluginId);
    }

    // Failed manifest/integrity rows still own their raw registry ids for
    // diagnostics and cleanup. Consume the claims backed by successful
    // mappings, then reject any remaining raw id that overlaps a canonical or
    // alias identity.
    const successfulClaimCounts = new Map<string, number>();
    for (const { alias } of normalizedMappings) {
      if (!alias) continue;
      successfulClaimCounts.set(alias, (successfulClaimCounts.get(alias) ?? 0) + 1);
    }
    for (const reservedId of normalizedReservedIds) {
      const successfulClaims = successfulClaimCounts.get(reservedId) ?? 0;
      if (successfulClaims > 0) {
        successfulClaimCounts.set(reservedId, successfulClaims - 1);
        continue;
      }
      const aliasOwner = aliasOwners.get(reservedId);
      if (canonicalIds.has(reservedId) || aliasOwner) {
        throw this.pluginIdentityCollision(
          reservedId,
          aliasOwner
            ? `failed registry id and install alias for '${aliasOwner}'`
            : `failed registry id and canonical id for '${reservedId}'`,
        );
      }
    }
  }

  protected async assertCurrentPluginIdentityLoadPlan(
    loadPlan: ManifestLoadPlan[],
  ): Promise<Array<{ plan: ManifestLoadPlan; snapshot: ManifestSnapshot }>> {
    const currentIdentities: Array<{
      plan: ManifestLoadPlan;
      snapshot: ManifestSnapshot;
    }> = [];
    for (const plan of loadPlan) {
      try {
        currentIdentities.push({
          plan,
          snapshot: {
            manifest: await this.readManifest(plan.manifestPath, { report: false }),
            approvedPluginAccess: plan.approvedPluginAccess,
          },
        });
      } catch {
        // Raw registry ids are still reserved below when a manifest is invalid.
      }
    }
    this.assertPluginIdentityNamespace(
      currentIdentities.map(({ plan, snapshot }) => ({
        pluginId: snapshot.manifest.id,
        alias: plan.pluginIdHint,
      })),
      loadPlan.flatMap((plan) => plan.pluginIdHint ? [plan.pluginIdHint] : []),
    );
    return currentIdentities;
  }

  private pluginIdentityCollision(identifier: string, detail: string): Error {
    const error = new Error(
      `Plugin identity collision for '${identifier}': ${detail}`,
    ) as Error & { code?: string };
    error.code = "plugin-identity-collision";
    return error;
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

  protected getPluginInstallClaim(pluginId: string): string | null | undefined {
    return this.knownInstallClaims.get(pluginId);
  }

  protected assertPluginManifestIdentity(
    expectedPluginId: string,
    actualPluginId: string,
  ): void {
    if (expectedPluginId === actualPluginId) return;
    throw this.pluginIdentityCollision(
      actualPluginId,
      `manifest id changed from active canonical id '${expectedPluginId}'`,
    );
  }

  protected beginPluginLifecycleOperation(
    pluginId: string,
    preserveRestartCancellation?: PendingRestartCancellation,
  ): number {
    const generation = ++this.nextPluginLifecycleGeneration;
    const canonicalId = this.resolveKnownPluginId(pluginId);
    const lifecycleIds = new Set([
      pluginId,
      canonicalId,
      ...(this.knownInstallAliases.get(canonicalId) ?? []),
    ]);
    for (const lifecycleId of lifecycleIds) {
      const cancellation = this.pendingRestartCancellations.get(lifecycleId);
      if (cancellation !== preserveRestartCancellation) cancellation?.cancel();
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
    installAlias: string | undefined,
  ): boolean {
    const requestedGeneration = this.pluginLifecycleGenerations.get(requestedPluginId);
    const canonicalGeneration = this.pluginLifecycleGenerations.get(canonicalPluginId);
    if (requestedGeneration !== generation || (canonicalGeneration !== undefined && canonicalGeneration > generation)) {
      return false;
    }
    this.rememberPluginInstallAlias(canonicalPluginId, installAlias);
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
    this.knownInstallClaims.clear();
    this.knownToolOwners.clear();
    this.knownEventOwners.clear();
    this.plugins.clear();
    this.pluginUiRevisions.clear();
    this.methodMap.clear();
    this.failedPluginIds.clear();
    this.failedPluginStubs.clear();
    this.loadFailureInfo.clear();
    this.disabledPluginIds.clear();
    this.preparation.clear();
    this.pendingRestarts.clear();
    this.pendingRestartPreparations.clear();
    for (const cancellation of this.pendingRestartCancellations.values()) {
      cancellation.cancel();
    }
    this.pendingRestartCancellations.clear();
    this.pluginLifecycleGenerations.clear();
    this.loaded = false;
  }

  protected stopAfterStartFailure(
    pluginId: string,
    instance: RuntimePlugin,
    lifecycleHookScope?: PluginLifecycleHookScope,
  ): Promise<boolean> {
    const pending = this.pluginStopOperations.get(instance);
    if (pending) return pending;
    const stop = this.stopPluginInstance(pluginId, instance, lifecycleHookScope);
    this.pluginStopOperations.set(instance, stop);
    return stop;
  }

  private async stopPluginInstance(
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
}
