import { resolve } from "node:path";
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
import type { LoadedPlugin, ManifestLoadPlan, ManifestSnapshot, SinglePluginStartResult } from "./types.js";
import { PerfStatsTracker } from "./perf-stats.js";
import { ConfigOverrideStore } from "./config-overrides.js";
import { PreparationTracker } from "./preparation.js";
import { isModelVisible } from "./tool-visibility.js";
import { createLogger } from "../../lib/logger.js";
import { plog, PluginPhase } from "../lifecycle-log.js";
import type {
  PluginRuntimeOptions,
  PluginStartPreparationContext,
  PluginToolInvocationDelegate,
} from "./index.js";

const log = createLogger("plugin-runtime");
const START_FAILURE_STOP_TIMEOUT_MS = 2_000;

export type RestartPluginResult = "started" | "deferred" | "failed" | undefined;

export abstract class PluginRuntimeState {
  protected readonly hostRoot: string;
  protected readonly manifestPaths: string[];
  protected readonly registryPath?: string;
  protected readonly pluginsRoot?: string;
  protected readonly configStore: ConfigOverrideStore;
  protected readonly createHostApi?: (pluginId: string, manifest: PluginManifest, pluginDataDir: string) => PluginHostApi;
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
  /** Monotonic generation used to reject stale async add/restart commits. */
  protected readonly pluginLifecycleGenerations = new Map<string, number>();
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

  protected buildHostApi(pluginId: string, manifest: PluginManifest, pluginDataDir: string): PluginHostApi {
    const hostApi = this.createHostApi?.(pluginId, manifest, pluginDataDir) ?? createNoopHostApi(pluginId, pluginDataDir);
    // Defence-in-depth: PluginHostApi.storage is required but partial hostApi
    // objects from test harnesses may omit it.
    if (!hostApi.storage) {
      hostApi.storage = createPluginStorage(pluginId, pluginDataDir);
    }
    return hostApi;
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

  protected getPluginInstallAliases(pluginId: string): string[] | undefined {
    const aliases = this.knownInstallAliases.get(pluginId);
    if (!aliases || aliases.size === 0) return undefined;
    return [...aliases].sort();
  }

  protected beginPluginLifecycleOperation(pluginId: string): number {
    const generation = ++this.nextPluginLifecycleGeneration;
    this.pluginLifecycleGenerations.set(pluginId, generation);
    return generation;
  }

  protected isPluginLifecycleOperationCurrent(pluginId: string, generation: number): boolean {
    return this.pluginLifecycleGenerations.get(pluginId) === generation;
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  waitForPluginReady(pluginId: string): Promise<void> {
    if (this.plugins.has(pluginId)) return Promise.resolve();
    return this.preparation.waitForReady(pluginId);
  }

  /**
   * Verify installed bytes before parsing any manifest, then parse each accepted
   * manifest exactly once. Work overlaps with a conservative bound while the
   * returned array preserves registry/load-plan order for deterministic state
   * projection and failure reporting.
   */

  // ─── Private helpers ───────────────────────────────────────────────────────

  protected resetLoadedState(): void {
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
    this.pluginLifecycleGenerations.clear();
    this.loaded = false;
  }

  protected async stopAfterStartFailure(
    pluginId: string,
    instance: RuntimePlugin,
  ): Promise<void> {
    if (!instance.stop) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.resolve(instance.stop()),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`stop timeout (>${START_FAILURE_STOP_TIMEOUT_MS}ms)`)),
            START_FAILURE_STOP_TIMEOUT_MS,
          );
        }),
      ]);
      plog("debug", { pluginId, phase: PluginPhase.STOP_OK }, "stopped after start failure");
    } catch (err) {
      plog("error", { pluginId, phase: PluginPhase.STOP_FAIL, err }, "stop after start failure failed");
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  protected cleanupFailedStartRuntimeState(
    pluginId: string,
    methods: Map<string, PluginToolHandler>,
  ): void {
    for (const method of methods.keys()) {
      this.methodMap.delete(method);
    }
    this.plugins.delete(pluginId);
    this.runPluginDisposers(pluginId, "start failure cleanup");
    this.onDisable?.(pluginId);
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
