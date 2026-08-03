import { basename, dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  PluginManifest,
  PluginToolHandler,
  RuntimePlugin,
  RuntimePluginFactory,
} from "../types.js";
import { resolveDependencies } from "../dependency-resolver.js";
import type {
  PluginRuntimeGenerationProjection,
} from "../plugin-host-generation.js";
import { HostApiGenerationScope } from "../plugin-host-effect-scope.js";
import {
  PluginFactoryTimeoutError,
  PluginImportTimeoutError,
  PluginStartupTimeoutError,
  runPluginFactoryWithTimeout,
  runPluginImportWithTimeout,
  runStartWithTimeout,
} from "./lifecycle-timeout.js";
import {
  getDeclaredEmittedEvents,
} from "./manifest-validation.js";
import {
  buildPluginContext,
  resolveRealEntryPath,
} from "./sandbox.js";
import type {
  LoadedPlugin,
  ManifestLoadPlan,
  ManifestSnapshot,
  PluginStartPreparationOutcome,
  PluginStartPreparationReturn,
} from "./types.js";
import {
  buildMethodMap,
  declaredRuntimeMethods,
  importPluginFactory,
} from "./plugin-loader.js";
import { createLogger } from "../../lib/logger.js";
import { plog, PluginPhase } from "../lifecycle-log.js";
import {
  hasExclusivePluginLifecycleMutation,
  isPluginInstallLockHeld,
  withAllPluginInstallLocks,
  withPluginInstallLock,
} from "../install-lifecycle.js";
import {
  type PendingRestartCancellation,
  type RestartPluginResult,
} from "./runtime-state.js";
import {
  preflightPluginLoadPlan,
  type BootPreflightOutcome,
  type PluginIntegrityCheckResult,
} from "./runtime-preflight.js";
import { PluginRuntimeCapabilityLifecycle } from "./runtime-lifecycle-capability-operations.js";
const log = createLogger("plugin-runtime");
const BOOT_START_CANCELLED = "plugin start cancelled";
export class PluginRuntimeLifecycle extends PluginRuntimeCapabilityLifecycle {
  protected async importPluginFactoryForLifecycle(
    pluginId: string,
    resolvedEntryPath: string,
    bustCache?: boolean,
  ): Promise<RuntimePluginFactory | undefined> {
    this.assertPluginLifecycleAvailable(pluginId);
    try {
      return await runPluginImportWithTimeout(
        () => importPluginFactory(resolvedEntryPath, bustCache),
      );
    } catch (err) {
      if (err instanceof PluginImportTimeoutError) {
        // ESM evaluation cannot be cancelled in-process. Never admit another
        // same-id incarnation while that abandoned module body may still run.
        this.quarantinePluginLifecycle(pluginId, err.message);
      }
      throw err;
    }
  }

  protected async preflightBootLoadPlan(
    loadPlan: ManifestLoadPlan[],
  ): Promise<BootPreflightOutcome[]> {
    return preflightPluginLoadPlan(
      loadPlan,
      {
        prepare: () => this.getManifestValidator(),
        verify: (pluginId, pluginRoot) => this.verifyReceiptAndDevGuard(
          pluginId,
          pluginRoot,
          { report: false },
        ),
        readManifest: (manifestPath) => this.readManifest(manifestPath, { report: false }),
      },
    );
  }

  async load(): Promise<void> {
    this.requireGenerationLifecycle("plugin load");
    if (this.loaded) return;
    const loadPlan = await this.resolveManifestLoadPlanInternal();
    for (const plan of loadPlan) {
      const pluginId = plan.pluginIdHint ?? `<unresolved:${basename(dirname(plan.manifestPath))}>`;
      plog("debug", { pluginId, phase: PluginPhase.LOAD_START }, "loading plugin");
    }
    const preflight = await this.preflightBootLoadPlan(loadPlan);
    this.assertPluginIdentityNamespace(
      preflight
        .filter((outcome) => outcome.ok)
        .map((outcome) => ({
          pluginId: outcome.manifest.id,
          alias: outcome.plan.pluginIdHint,
        })),
      loadPlan.flatMap((plan) => plan.pluginIdHint ? [plan.pluginIdHint] : []),
    );
    const enabledManifestSnapshots = new Map<string, ManifestSnapshot>();
    for (const outcome of preflight) {
      if (
        outcome.plan.pluginIdHint
        && "integrityResult" in outcome
        && outcome.integrityResult
      ) {
        this.reportPluginIntegrityResult(outcome.plan.pluginIdHint, outcome.integrityResult);
      }
      if (!outcome.ok && outcome.kind === "manifest") {
        this.reportPluginManifestRejected(outcome.plan.manifestPath, outcome.error);
      }
      if (!outcome.ok) continue;
      // Runtime identity is the literal manifest id. A registry id is only a
      // deployment alias and must not own tools, events, grants, or HostApi.
      const pluginId = outcome.manifest.id;
      // This is only a structural preflight: an inactive registry row cannot
      // satisfy a dependency even provisionally. Final admission is deferred
      // to startAll(), which requires a successfully published generation.
      if (outcome.plan.enabled) {
        enabledManifestSnapshots.set(pluginId, {
          manifest: outcome.manifest,
          approvedPluginAccess: outcome.approvedPluginAccess,
        });
      }
      this.rememberPluginInstallAlias(outcome.manifest.id, outcome.plan.pluginIdHint);
      this.knownPluginManifests.set(pluginId, outcome.manifest);
      this.knownPluginAccessGrants.set(pluginId, outcome.approvedPluginAccess);
      this.rememberToolOwners(pluginId, outcome.manifest); // #885 §2.4a MODEL-ONLY (see method)
      for (const eventType of getDeclaredEmittedEvents(outcome.manifest)) {
        this.knownEventOwners.set(eventType, pluginId);
      }
    }
    for (const outcome of preflight) {
      const { plan } = outcome;
      const manifestPath = plan.manifestPath;
      const pluginRoot = dirname(manifestPath);
      let pluginId = plan.pluginIdHint ?? `<unresolved:${basename(dirname(manifestPath))}>`;
      if (!outcome.ok) {
        if (outcome.kind === "integrity") {
          if (plan.pluginIdHint) {
            this.markFailed(plan.pluginIdHint);
          }
          continue;
        }
        const err = outcome.error;
        const reason =
          err instanceof SyntaxError ? "manifest_parse"
          : (err as Error).message?.includes("schema validation") ? "manifest_schema"
          : (err as NodeJS.ErrnoException).code === "ENOENT" ? "manifest_missing"
          : "manifest_read";
        plog("error", { pluginId, phase: PluginPhase.VALIDATION_FAIL, err, reason }, `manifest read failed: ${(err as Error).message}`);
        if (plan.pluginIdHint) {
          this.markFailed(plan.pluginIdHint, {
            name: plan.pluginIdHint,
            description: "Plugin manifest could not be loaded.",
          }, {
            ...(reason === "manifest_schema"
              ? { installFailureKind: "manifest-validation-error" as const }
              : {}),
            installFailureMessage: (err as Error).message,
          });
        }
        continue;
      }
      if (!plan.enabled) {
        pluginId = outcome.manifest.id;
        this.rememberPluginInstallAlias(pluginId, plan.pluginIdHint);
        this.rememberPluginManifest(
          pluginId,
          outcome.manifest,
          outcome.approvedPluginAccess,
        );
        this.inactivePluginIds.add(pluginId);
        this.disabledPluginIds.add(pluginId);
        this.failedPluginIds.delete(pluginId);
        this.failedPluginStubs.delete(pluginId);
        this.loadFailureInfo.delete(pluginId);
        plog(
          "debug",
          { pluginId, phase: PluginPhase.LOAD_OK, reason: "inactive_pointer" },
          "plugin retained as inactive metadata without runtime admission",
        );
        continue;
      }
      const { manifest, approvedPluginAccess } = outcome;
      // Reassign to manifest.id so all subsequent phases use the canonical id.
      pluginId = manifest.id;
      this.rememberPluginInstallAlias(manifest.id, plan.pluginIdHint);
      this.knownPluginManifests.set(manifest.id, manifest);
      this.failedPluginStubs.delete(manifest.id);
      this.loadFailureInfo.delete(manifest.id);
      this.inactivePluginIds.delete(manifest.id);
      this.disabledPluginIds.delete(manifest.id);
      this.failedPluginIds.delete(manifest.id);
      // Plugin↔app minimum-version gate — HARD BLOCK at LOAD. A plugin already
      // on disk (e.g. installed against a newer host, then the user downgraded
      // the app, or a sideload) must NOT silently run against a too-old app.
      // Skip activation, log an English reason, surface a "needs newer app"
      // stub. Other plugins continue to load (isolation).
      if (this.markIncompatibleAppVersion(manifest)) {
        continue;
      }
      const requiredCapabilities = manifest.requires?.capabilities ?? [];
      if (requiredCapabilities.length > 0) {
        const availableManifests = [...enabledManifestSnapshots.values()]
          .filter((candidate) => candidate.manifest.id !== manifest.id)
          .map((candidate) => candidate.manifest);
        const dependencyResult = resolveDependencies(requiredCapabilities, availableManifests);
        if (!dependencyResult.ok) {
          const reason = `missing required capabilities: ${dependencyResult.missing.join(", ")}`;
          log.error(`${manifest.id} rejected — ${reason}`);
          this.auditLog?.("error", "plugin_dependency_missing", {
            pluginId: manifest.id,
            missing: dependencyResult.missing,
          });
          this.markFailed(manifest.id, {
            name: manifest.name ?? manifest.id,
            description: `Missing capabilities: ${dependencyResult.missing.join(", ")}`,
          });
          continue;
        }
      }
      if (this.preparation.deferStart(plan, manifest, approvedPluginAccess)) {
        continue;
      }
      const activationId = randomUUID();
      const runtimeRoot = await this.materializeImmutableRuntimeRoot(
        manifest.id,
        pluginRoot,
        activationId,
        plan.pluginIdHint ?? manifest.id,
      );
      let entryPath: string;
      try {
        entryPath = this.resolveEntryPathForPlugin(runtimeRoot, manifest.entry);
      } catch (err) {
        const reason = (err as Error).message;
        plog("error", { pluginId: manifest.id, phase: PluginPhase.LOAD_FAIL, err, reason: "entry_path" }, "entry path rejected");
        this.auditLog?.("error", "plugin_entry_path_rejected", {
          pluginId: manifest.id,
          entry: manifest.entry,
          reason,
        });
        this.markFailed(manifest.id);
        await this.removeUnpublishedRuntimeRoot(manifest.id, runtimeRoot);
        continue;
      }
      const resolvedEntryPath = resolveRealEntryPath(entryPath);
      let createPlugin: RuntimePluginFactory | undefined;
      try {
        createPlugin = await this.importPluginFactoryForLifecycle(
          manifest.id,
          resolvedEntryPath,
        );
      } catch (err) {
        plog("error", { pluginId: manifest.id, phase: PluginPhase.LOAD_FAIL, err, reason: "import" }, "import failed");
        this.auditLog?.("error", "plugin_import_failed", {
          pluginId: manifest.id,
          reason: (err as Error).message,
        });
        this.markFailed(manifest.id);
        await this.removeUnpublishedRuntimeRoot(manifest.id, runtimeRoot);
        continue;
      }
      if (!createPlugin) {
        plog("error", { pluginId: manifest.id, phase: PluginPhase.LOAD_FAIL, reason: "no_default_export" }, "entry does not export default/createPlugin");
        this.markFailed(manifest.id);
        await this.removeUnpublishedRuntimeRoot(manifest.id, runtimeRoot);
        continue;
      }

      const pluginDataDir = this.ensureDataDir(manifest.id, pluginRoot);
      const hostEffects = new HostApiGenerationScope(manifest.id);
      const { hostApi, disposers, deactivate, drainOperations, commit, lifecycleHookScope } =
        this.buildHostApiIncarnation(manifest.id, manifest, pluginDataDir, hostEffects);

      let instance: RuntimePlugin;
      try {
        instance = await runPluginFactoryWithTimeout(
          () => this.runPluginLifecycleHook(
            lifecycleHookScope,
            () => createPlugin(
              buildPluginContext({
                pluginId: manifest.id,
                pluginRoot: runtimeRoot,
                hostRoot: this.hostRoot,
                pluginDataDir,
                manifest,
                configOverrides: this.configOverrides,
                hostApi,
              }),
            ),
          ),
          async (lateInstance) => {
            deactivate();
            await this.stopAfterStartFailure(manifest.id, lateInstance, lifecycleHookScope);
          },
        );
      } catch (err) {
        deactivate();
        hostEffects.discard();
        if (err instanceof PluginFactoryTimeoutError) {
          this.quarantinePluginLifecycle(manifest.id, err.message);
        }
        this.runDisposerList(disposers, "failed load factory");
        await this.drainPluginHostApiOperations(manifest.id, {
          drainHostApiOperations: drainOperations,
        });
        this.markFailed(manifest.id);
        await this.removeUnpublishedRuntimeRoot(manifest.id, runtimeRoot);
        plog("error", { pluginId: manifest.id, phase: PluginPhase.LOAD_FAIL, err, reason: "factory" }, "plugin factory failed");
        continue;
      }

      const methods = new Map<string, PluginToolHandler>();
      for (const toolName of declaredRuntimeMethods(manifest)) {
        const handler = instance.handlers[toolName];
        if (!handler) {
          plog("warn", { pluginId: manifest.id, phase: PluginPhase.REGISTER_TOOL_SKIP, toolName, reason: "missing_handler" }, "tool disabled — missing handler");
          continue;
        }
        methods.set(toolName, handler);
        if (this.methodMap.has(toolName)) {
          deactivate();
          hostEffects.discard();
          await this.stopAfterStartFailure(manifest.id, instance, lifecycleHookScope);
          this.runDisposerList(disposers, "duplicate load method");
          await this.drainPluginHostApiOperations(manifest.id, {
            drainHostApiOperations: drainOperations,
          });
          await this.removeUnpublishedRuntimeRoot(manifest.id, runtimeRoot);
          throw new Error(`Duplicate plugin method registered: ${toolName}`);
        }
      }
      for (const [toolName, handler] of methods) {
        this.methodMap.set(toolName, { pluginId: manifest.id, handler });
        plog("debug", { pluginId: manifest.id, phase: PluginPhase.REGISTER_TOOL_OK, toolName }, "tool registered");
      }

      commit();
      this.plugins.set(manifest.id, {
        activationId,
        manifest,
        pluginRoot: runtimeRoot,
        instance,
        methods,
        approvedPluginAccess,
        hostEffects,
        started: false,
        deactivateHostApi: deactivate,
        drainHostApiOperations: drainOperations,
        lifecycleHookScope,
      });
      this.disposers.set(manifest.id, disposers);
      this.markPluginUiRevision(manifest.id);
      this.failedPluginIds.delete(manifest.id);
      this.disabledPluginIds.delete(manifest.id);
      plog("debug", { pluginId: manifest.id, phase: PluginPhase.LOAD_OK }, "plugin loaded");
      // NOTE: inactive-plugin model visibility is not a runtime load concern.
      // Boot sync still registers loaded tools for host/UI/auth execution;
      // ConversationLoop scope suppresses model-visible tools for inactive
      // plugins.
    }
    this.loaded = true;
  }

  async startAll(): Promise<void> {
    this.requireGenerationLifecycle("plugin start");
    await this.load();
    // A provider is usable only after startup has completed and its generation
    // is published. Iterate until every currently-startable plugin has been
    // admitted; this permits registry order to be consumer-first without ever
    // starting that consumer before its providers are live.
    const pendingPluginIds = new Set(
      [...this.plugins.values()]
        .filter((plugin) => !plugin.started)
        .map((plugin) => plugin.manifest.id),
    );
    while (pendingPluginIds.size > 0) {
      const startable: Array<{ pluginId: string; plugin: LoadedPlugin }> = [];
      for (const pluginId of [...pendingPluginIds]) {
        const plugin = this.plugins.get(pluginId);
        if (!plugin || plugin.started) {
          pendingPluginIds.delete(pluginId);
          continue;
        }
        if (this.capabilityDependencies().missing(plugin.manifest).length > 0) {
          continue;
        }
        pendingPluginIds.delete(pluginId);
        startable.push({ pluginId, plugin });
      }
      if (startable.length === 0) break;
      // A layer only contains plugins whose dependencies were already active
      // before this pass. Start siblings concurrently; publication remains
      // serialized by the short capability commit boundary.
      const outcomes = await Promise.all(startable.map(async ({ pluginId, plugin }) => ({
        pluginId,
        plugin,
        reason: await this.startLoadedPluginAtBoot(pluginId, plugin),
      })));
      for (const { pluginId, plugin, reason } of outcomes) {
        if (reason === undefined || reason === BOOT_START_CANCELLED) continue;
        await this.failBootPlugin(pluginId, plugin, reason);
      }
    }

    // Any remaining plugin is blocked by either a failed provider, a missing
    // provider, or a dependency cycle. Do not admit its already-instantiated
    // candidate: its capabilities were never live at the startup boundary.
    for (const pluginId of pendingPluginIds) {
      const plugin = this.plugins.get(pluginId);
      if (!plugin) continue;
      const missing = this.capabilityDependencies().missing(plugin.manifest);
      const preparingProviderIds = this.preparingCapabilityProviderIds(
        plugin.manifest,
        missing,
      );
      if (preparingProviderIds) {
        this.deferBlockedLoadedPlugin(plugin, preparingProviderIds);
        continue;
      }
      const reason = `missing required capabilities: ${missing.join(", ")}`;
      this.auditLog?.("error", "plugin_dependency_missing", {
        pluginId,
        missing,
      });
      this.markFailed(pluginId, {
        name: plugin.manifest.name ?? pluginId,
        description: `Missing capabilities: ${missing.join(", ")}`,
      });
      await this.failBootPlugin(pluginId, plugin, reason);
    }
  }

  override waitForPluginReady(pluginId: string): Promise<void> {
    const canonicalPluginId = this.resolveKnownPluginId(pluginId);
    const readiness = this.capabilityBlockedReadiness.get(canonicalPluginId);
    if (readiness) return readiness.promise;
    return super.waitForPluginReady(canonicalPluginId);
  }

  protected async startLoadedPluginAtBoot(
    pluginId: string,
    expectedPlugin?: LoadedPlugin,
    shouldCommit?: () => boolean,
  ): Promise<string | undefined> {
    return withPluginInstallLock(pluginId, () =>
      this.startLoadedPluginAtBootLocked(pluginId, expectedPlugin, shouldCommit),
    );
  }

  private async startLoadedPluginAtBootLocked(
    pluginId: string,
    expectedPlugin?: LoadedPlugin,
    shouldCommit?: () => boolean,
  ): Promise<string | undefined> {
    const generationLifecycle = this.requireCapabilityCommitLifecycle("plugin start");
    const plugin = this.plugins.get(pluginId);
    const isCurrent = () =>
      this.plugins.get(pluginId) === plugin
      && (!expectedPlugin || plugin === expectedPlugin)
      && (shouldCommit?.() ?? true);
    if (!plugin || !isCurrent()) return BOOT_START_CANCELLED;
    const SLOW_THRESHOLD_MS = 5000;
    const startedAt = Date.now();
    const slowTimer = setTimeout(() => {
      log.warn(`slow plugin: ${pluginId} (>${SLOW_THRESHOLD_MS}ms)`);
    }, SLOW_THRESHOLD_MS);
    try {
      this.perf.ensure(pluginId);
      if (plugin.instance.start) {
        try {
          if (!isCurrent()) return BOOT_START_CANCELLED;
          await runStartWithTimeout(
            () => this.runPluginLifecycleHook(
              plugin.lifecycleHookScope,
              plugin.instance.start!.bind(plugin.instance),
            ),
            plugin.manifest.startupTimeoutMs,
          );
          if (!isCurrent()) return BOOT_START_CANCELLED;
        } catch (error) {
          if (error instanceof PluginStartupTimeoutError) {
            this.quarantinePluginLifecycle(pluginId, error.message);
          }
          // Fail closed before moving on to another dependency layer.
          plugin.deactivateHostApi?.();
          throw error;
        }
      }
      if (!isCurrent()) return BOOT_START_CANCELLED;
      const elapsed = Date.now() - startedAt;
      this.perf.setStartupMs(pluginId, elapsed);
      const projection = this.getRuntimeGenerationProjection(pluginId);
      if (!projection) throw new Error("runtime projection disappeared before publication");
      await generationLifecycle.replaceRuntime(
        projection,
        this.capabilityDependencyCommitScope(() => {
          if (!isCurrent()) {
            throw new Error(BOOT_START_CANCELLED);
          }
          this.assertActiveCapabilityDependencies(
            plugin.manifest,
            "plugin start",
          );
          plugin.started = true;
        }),
      );
      this.resolveCapabilityBlockedRetry(pluginId);
      if (elapsed > SLOW_THRESHOLD_MS) {
        plog("warn", { pluginId, phase: PluginPhase.START_SLOW, elapsedMs: elapsed }, "plugin start slow");
      } else {
        plog("debug", { pluginId, phase: PluginPhase.START_OK, elapsedMs: elapsed }, "plugin start ok");
      }
      return undefined;
    } catch (error) {
      plugin.started = false;
      plugin.deactivateHostApi?.();
      if (!isCurrent()) return BOOT_START_CANCELLED;
      return error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(slowTimer);
    }
  }

  protected async failBootPlugin(
    pluginId: string,
    plugin: LoadedPlugin,
    reason: string,
  ): Promise<void> {
    if (this.plugins.get(pluginId) !== plugin) return;
    this.rejectCapabilityBlockedRetry(pluginId, new Error(reason));
    plog("error", { pluginId, phase: PluginPhase.START_FAIL, reason }, "plugin start failed");
    await this.failClosedLoadedPlugin(pluginId, plugin, "start failure cleanup");
    if (plugin.hostEffects?.isPreparing()) plugin.hostEffects.discard();
    await this.removeUnpublishedRuntimeRoot(pluginId, plugin.pluginRoot);
  }

  private deferBlockedLoadedPlugin(
    plugin: LoadedPlugin,
    providerIds: readonly string[],
  ): void {
    const pluginId = plugin.manifest.id;
    const isCurrent = this.capabilityBlockedRetryGuard(
      pluginId,
      plugin.manifest,
      plugin,
    );
    this.deferCapabilityBlockedRetry(pluginId, providerIds, async () =>
      withPluginInstallLock(pluginId, async () => {
      // A remove, disable, restart, or reset may have replaced this mutable
      // load candidate while its provider was preparing. Never resurrect it.
      if (!isCurrent() || plugin.started) return;
      const missing = this.capabilityDependencies().missing(plugin.manifest);
      const nextProviderIds = this.preparingCapabilityProviderIds(
        plugin.manifest,
        missing,
      );
      if (nextProviderIds) {
        this.deferBlockedLoadedPlugin(plugin, nextProviderIds);
        return;
      }
      if (missing.length > 0) {
        const reason = `missing required capabilities: ${missing.join(", ")}`;
        this.auditLog?.("error", "plugin_dependency_missing", {
          pluginId,
          missing,
        });
        this.markFailed(pluginId, {
          name: plugin.manifest.name ?? pluginId,
          description: `Missing capabilities: ${missing.join(", ")}`,
        });
        await this.failBootPlugin(pluginId, plugin, reason);
        return;
      }
      const reason = await this.startLoadedPluginAtBoot(pluginId, plugin, isCurrent);
      if (reason !== undefined && reason !== BOOT_START_CANCELLED) {
        await this.failBootPlugin(pluginId, plugin, reason);
      }
      }), isCurrent);
  }

  protected deferBlockedAddPlugin(
    pluginId: string,
    providerIds: readonly string[],
  ): void {
    const manifest = this.knownPluginManifests.get(pluginId);
    if (!manifest) return;
    const isCurrent = this.capabilityBlockedRetryGuard(pluginId, manifest);
    this.deferCapabilityBlockedRetry(pluginId, providerIds, async () => {
      // Re-enter through addPlugin rather than retaining a pre-wait plan. It
      // re-resolves the current registry, receipt, canonical identity, and
      // lifecycle generation before admitting anything.
      if (!isCurrent() || !this.hasTrackedPluginState(pluginId)) return;
      try {
        this.capabilityBlockedRetryAdds.add(pluginId);
        const result = await this.addPlugin(pluginId);
        if (result === "preparing" && this.preparation.isPreparing(pluginId)) {
          this.bridgeCapabilityBlockedReadinessToPreparation(pluginId);
        }
      } catch (error) {
        if (
          isCurrent()
          && this.hasTrackedPluginState(pluginId)
          && !this.inactivePluginIds.has(pluginId)
          && !this.disabledPluginIds.has(pluginId)
        ) {
          const message = error instanceof Error ? error.message : String(error);
          this.auditLog?.("error", "plugin_dependency_retry_failed", {
            pluginId,
            reason: message,
          });
          this.markFailed(pluginId, {
            name: this.knownPluginManifests.get(pluginId)?.name ?? pluginId,
            description: message,
          });
          this.rejectCapabilityBlockedRetry(pluginId, new Error(message));
        }
      } finally {
        this.capabilityBlockedRetryAdds.delete(pluginId);
      }
    }, isCurrent);
  }

  protected override resetLoadedState(): void {
    this.clearAllCapabilityBlockedRetries();
    this.capabilityBlockedRetryAdds.clear();
    super.resetLoadedState();
  }

  async stopAll(): Promise<void> {
    for (const plugin of this.plugins.values()) {
      await this.stopAfterStartFailure(
        plugin.manifest.id,
        plugin.instance,
        plugin.lifecycleHookScope,
      );
      plugin.deactivateHostApi?.();
      this.runPluginDisposers(plugin.manifest.id, "stopAll");
      await this.drainPluginHostApiOperations(plugin.manifest.id, plugin);
    }
  }

  async restartAll(): Promise<void> {
    this.requireGenerationLifecycle("plugin restartAll");
    // Cancel dependency-held plugin locks before the global mutation queues.
    for (const cancellation of this.pendingRestartCancellations.values()) {
      cancellation.cancel();
    }
    return withAllPluginInstallLocks(() => this.restartAllLocked());
  }

  private async restartAllLocked(): Promise<void> {
    const lifecycleIds = new Set([
      ...this.plugins.keys(),
      ...this.pendingRestarts.keys(),
      ...this.pluginLifecycleGenerations.keys(),
    ]);
    for (const pluginId of lifecycleIds) {
      this.clearCapabilityBlockedRetry(
        pluginId,
        `plugin '${pluginId}' capability dependency wait was cancelled by restartAll`,
      );
      this.beginPluginLifecycleOperation(pluginId);
    }
    await Promise.allSettled([...this.pendingRestarts.values()]);
    const loadPlan = await this.resolveManifestLoadPlanInternal();
    const currentIdentities = await this.assertCurrentPluginIdentityLoadPlan(loadPlan);
    const targets = currentIdentities.filter(({ plan }) => plan.enabled);
    const targetIds = new Set(targets.map(({ snapshot }) => snapshot.manifest.id));
    // Tear down consumers before their providers. The ordinary remove guard is
    // intentionally strict, so registry changes that remove both sides of an
    // active dependency must be ordered rather than attempting the provider
    // first merely because of insertion order.
    const pendingRemovalIds = new Set(
      [...this.plugins.keys()].filter((pluginId) => !targetIds.has(pluginId)),
    );
    while (pendingRemovalIds.size > 0) {
      const nextPluginId = [...pendingRemovalIds].find(
        (pluginId) =>
          this.activeCapabilityDependentsMissingAfterProviderChange(
            pluginId,
            undefined,
          ).length === 0,
      );
      if (!nextPluginId) {
        // A remaining active dependent is outside this removal set, or the
        // set forms a capability cycle that cannot be safely torn down one at
        // a time. Reuse the public guard for an actionable diagnostic.
        const blockedPluginId = pendingRemovalIds.values().next().value;
        if (typeof blockedPluginId === "string") {
          this.assertNoActiveCapabilityDependents(blockedPluginId, "remove");
        }
        throw new Error("restartAll could not order capability-dependent removals");
      }
      await this.removePlugin(nextPluginId);
      pendingRemovalIds.delete(nextPluginId);
    }

    // A cold restartAll may have no active providers yet. Iterate just like
    // boot so a consumer listed before its provider waits for the provider's
    // successful active-generation publication.
    const pendingPluginIds = new Set(
      targets.map(({ snapshot }) => snapshot.manifest.id),
    );
    const failures: Error[] = [];
    let madeProgress = true;
    while (pendingPluginIds.size > 0 && madeProgress) {
      madeProgress = false;
      for (const { snapshot } of targets) {
        const pluginId = snapshot.manifest.id;
        if (!pendingPluginIds.has(pluginId)) continue;
        if (this.capabilityDependencies().missing(snapshot.manifest).length > 0) {
          continue;
        }
        pendingPluginIds.delete(pluginId);
        madeProgress = true;
        try {
          if (this.plugins.has(pluginId)) {
            const result = await this.restartPlugin(pluginId);
            if (result === "failed") {
              failures.push(new Error(`restartAll failed for ${pluginId}`));
            }
          } else {
            await this.addPlugin(pluginId);
          }
        } catch (error) {
          failures.push(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      }
    }
    for (const { snapshot, plan } of targets) {
      const pluginId = snapshot.manifest.id;
      if (!pendingPluginIds.has(pluginId)) continue;
      const missing = this.capabilityDependencies().missing(snapshot.manifest);
      this.rememberPluginInstallAlias(pluginId, plan.pluginIdHint);
      this.rememberPluginManifest(
        pluginId,
        snapshot.manifest,
        snapshot.approvedPluginAccess,
      );
      const preparingProviderIds = this.preparingCapabilityProviderIds(
        snapshot.manifest,
        missing,
      );
      if (preparingProviderIds) {
        this.deferBlockedAddPlugin(pluginId, preparingProviderIds);
        continue;
      }
      this.markFailed(pluginId, {
        name: snapshot.manifest.name ?? pluginId,
        description: `Missing capabilities: ${missing.join(", ")}`,
      });
      failures.push(
        new Error(
          `restartAll blocked for ${pluginId} — missing required capabilities: ${missing.join(", ")}`,
        ),
      );
    }
    if (failures.length > 0) throw failures[0]!;
  }

  /** US-3c.2 — Targeted single-plugin restart. */
  async restartPlugin(
    pluginId: string,
    opts: { skipPreparation?: boolean; throwOnFailure?: boolean } = {},
  ): Promise<RestartPluginResult> {
    const canonicalPluginId = this.resolveKnownPluginId(pluginId);
    this.assertPluginLifecycleAvailable(canonicalPluginId);
    if (
      hasExclusivePluginLifecycleMutation()
      && !isPluginInstallLockHeld(canonicalPluginId)
    ) {
      log.warn(
        `restartPlugin rejected while an all-plugin lifecycle mutation is queued: ${canonicalPluginId}`,
      );
      return "failed";
    }
    const pending = this.pendingRestarts.get(canonicalPluginId);
    if (pending) return pending;
    const cancellation = this.createPendingRestartCancellation();
    this.pendingRestartCancellations.set(canonicalPluginId, cancellation);
    const restart = withPluginInstallLock(canonicalPluginId, async () => {
      this.clearCapabilityBlockedRetry(
        canonicalPluginId,
        `plugin '${canonicalPluginId}' capability dependency wait was cancelled by restart`,
      );
      const generation = this.beginPluginLifecycleOperation(
        canonicalPluginId,
        cancellation,
      );
      cancellation.generation = generation;
      if (cancellation.cancelled) return "failed";
      return this.restartPluginInternal(
        canonicalPluginId,
        generation,
        cancellation,
        opts,
      );
    }).finally(() => {
      if (this.pendingRestarts.get(canonicalPluginId) === restart) {
        this.pendingRestarts.delete(canonicalPluginId);
      }
      if (this.pendingRestartCancellations.get(canonicalPluginId) === cancellation) {
        this.pendingRestartCancellations.delete(canonicalPluginId);
      }
    });
    this.pendingRestarts.set(canonicalPluginId, restart);
    return restart;
  }

  protected async restartPluginInternal(
    pluginId: string,
    generation: number,
    cancellation: PendingRestartCancellation,
    opts: { skipPreparation?: boolean; throwOnFailure?: boolean } = {},
  ): Promise<RestartPluginResult> {
    const generationLifecycle = this.requireCapabilityCommitLifecycle("plugin restart");
    plog("info", { pluginId, phase: PluginPhase.RESTART_REQUEST }, "restart requested");
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      plog("warn", { pluginId, phase: PluginPhase.RESTART_REQUEST, reason: "not_loaded" }, "restart no-op — plugin not loaded");
      return undefined;
    }
    const isCurrent = () =>
      !cancellation.cancelled
      && this.isPluginLifecycleOperationCurrent(pluginId, generation);

    const loadPlan = await this.resolveManifestLoadPlanInternal();
    if (!isCurrent()) return "failed";
    const currentIdentities = await this.assertCurrentPluginIdentityLoadPlan(loadPlan);
    if (!isCurrent()) return "failed";
    const installClaim = this.getPluginInstallClaim(pluginId);
    const targetIdentity = currentIdentities.find(({ plan, snapshot }) => {
      if (snapshot.manifest.id !== pluginId) return false;
      return installClaim === null
        ? !plan.pluginIdHint
          && resolve(dirname(plan.manifestPath)) === resolve(plugin.pluginRoot)
        : plan.pluginIdHint === (installClaim ?? pluginId);
    });
    const snapshot = targetIdentity?.snapshot;
    const targetPlan = targetIdentity?.plan;
    const pluginRoot = targetPlan ? dirname(targetPlan.manifestPath) : plugin.pluginRoot;
    const approvedPluginAccess =
      snapshot?.approvedPluginAccess ??
      targetPlan?.approvedPluginAccess ??
      plugin.approvedPluginAccess ??
      this.knownPluginAccessGrants.get(pluginId);
    const receiptPluginId = targetPlan?.pluginIdHint ?? this.getPluginInstallClaim(pluginId);
    const integrityResult: PluginIntegrityCheckResult = receiptPluginId
      ? await this.verifyReceiptAndDevGuard(receiptPluginId, pluginRoot)
      : { ok: true };
    if (!isCurrent()) return "failed";
    if (!integrityResult.ok) {
      return "failed";
    }
    let manifest: PluginManifest;
    try {
      manifest =
        snapshot?.manifest ??
        (await this.readManifest(targetPlan?.manifestPath ?? resolve(pluginRoot, "plugin.json")));
    } catch (err) {
      plog("error", { pluginId, phase: PluginPhase.RESTART_RELOAD_FAIL, err, reason: "manifest_read" }, "manifest read failed during restart");
      return "failed";
    }
    this.assertPluginManifestIdentity(pluginId, manifest.id);
    const missingCapabilities = this.capabilityDependencies().missing(manifest);
    if (missingCapabilities.length > 0) {
      const reason = `missing required capabilities: ${missingCapabilities.join(", ")}`;
      log.error(`${pluginId} restart rejected — ${reason}`);
      this.auditLog?.("error", "plugin_dependency_missing", {
        pluginId,
        missing: missingCapabilities,
      });
      if (opts.throwOnFailure) throw new Error(reason);
      return "failed";
    }
    try {
      this.assertActiveCapabilityDependentsRemainSatisfied(
        pluginId,
        manifest,
        "plugin restart",
      );
    } catch (error) {
      if (opts.throwOnFailure) throw error;
      log.error(
        `${pluginId} restart rejected — ${(error as Error).message}`,
      );
      return "failed";
    }
    const restartPlan: ManifestLoadPlan = targetPlan ?? {
      pluginIdHint: pluginId,
      manifestPath: resolve(pluginRoot, "plugin.json"),
      enabled: true,
      approvedPluginAccess,
    };

    let preparationResult: PluginStartPreparationOutcome = undefined;
    if (!opts.skipPreparation && this.preparePluginStart) {
      const pluginRootForPreparation = dirname(restartPlan.manifestPath);
      let result: PluginStartPreparationReturn;
      let preparation = this.pendingRestartPreparations.get(pluginId);
      if (!preparation) {
        try {
          result = this.preparePluginStart({
            pluginId: manifest.id,
            manifest,
            manifestPath: restartPlan.manifestPath,
            pluginRoot: pluginRootForPreparation,
          });
        } catch (err) {
          plog("error", { pluginId, phase: PluginPhase.START_FAIL, err, reason: "restart_dependency_prepare" }, "restart dependency preparation failed");
          return "failed";
        }
        if (result && typeof (result as Promise<PluginStartPreparationOutcome>).then === "function") {
          preparation = Promise.resolve(result);
          this.pendingRestartPreparations.set(pluginId, preparation);
          void preparation.finally(() => {
            if (this.pendingRestartPreparations.get(pluginId) === preparation) {
              this.pendingRestartPreparations.delete(pluginId);
            }
          }).catch(() => {});
        } else {
          preparationResult = result as PluginStartPreparationOutcome;
        }
      }
      if (preparation) {
        try {
          const outcome = await Promise.race([
            preparation.then((result) => ({ status: "prepared" as const, result })),
            cancellation.promise.then(() => ({ status: "cancelled" as const })),
          ]);
          if (outcome.status === "cancelled") return "failed";
          preparationResult = outcome.result;
        } catch (err) {
          plog("error", { pluginId, phase: PluginPhase.START_FAIL, err, reason: "restart_dependency_prepare" }, "restart dependency preparation failed");
          return "failed";
        }
      }
    }

    if (!isCurrent()) return "failed";
    if (
      preparationResult
      && typeof preparationResult === "object"
      && preparationResult.configOverride
    ) {
      this.mergeConfigOverride(pluginId, preparationResult.configOverride);
    }
    const activationId = randomUUID();
    const runtimeRoot = await this.materializeImmutableRuntimeRoot(
      pluginId,
      pluginRoot,
      activationId,
      receiptPluginId ?? pluginId,
    );
    let entryPath: string;
    try {
      entryPath = this.resolveEntryPathForPlugin(runtimeRoot, manifest.entry);
    } catch (error) {
      await this.removeUnpublishedRuntimeRoot(pluginId, runtimeRoot);
      plog("error", { pluginId, phase: PluginPhase.RESTART_RELOAD_FAIL, err: error, reason: "entry_path" }, "entry path rejected during restart");
      return "failed";
    }
    const resolvedEntryPath = resolveRealEntryPath(entryPath);
    // Cache-bust so restart imports the new bundle rather than memoized ESM.
    let createPlugin: RuntimePluginFactory | undefined;
    try {
      createPlugin = await this.importPluginFactoryForLifecycle(
        pluginId,
        resolvedEntryPath,
        true,
      );
      plog("debug", { pluginId, phase: PluginPhase.RESTART_RELOAD_OK }, "module re-imported");
    } catch (err) {
      await this.removeUnpublishedRuntimeRoot(pluginId, runtimeRoot);
      plog("error", { pluginId, phase: PluginPhase.RESTART_RELOAD_FAIL, err }, "module re-import failed");
      return "failed";
    }

    if (!isCurrent()) {
      await this.removeUnpublishedRuntimeRoot(pluginId, runtimeRoot);
      return "failed";
    }

    if (!createPlugin) {
      await this.removeUnpublishedRuntimeRoot(pluginId, runtimeRoot);
      plog("error", { pluginId, phase: PluginPhase.RESTART_RELOAD_FAIL, reason: "no_default_export" }, "entry does not export default/createPlugin after restart");
      return "failed";
    }

    const pluginDataDir = this.ensureDataDir(pluginId, pluginRoot);
    const hostEffects = new HostApiGenerationScope(pluginId);
    const {
      hostApi,
      disposers: replacementDisposers,
      deactivate: deactivateReplacementHostApi,
      drainOperations: drainReplacementHostApiOperations,
      commit: commitReplacementHostApi,
      lifecycleHookScope: replacementLifecycleHookScope,
    } = this.buildHostApiIncarnation(
      pluginId,
      manifest,
      pluginDataDir,
      hostEffects,
    );

    let instance: RuntimePlugin;
    try {
      instance = await runPluginFactoryWithTimeout(
        () => this.runPluginLifecycleHook(
          replacementLifecycleHookScope,
          () => createPlugin(
            buildPluginContext({
              pluginId,
              pluginRoot: runtimeRoot,
              hostRoot: this.hostRoot,
              pluginDataDir,
              manifest,
              configOverrides: this.configOverrides,
              hostApi,
            }),
          ),
        ),
        async (lateInstance) => {
          deactivateReplacementHostApi();
          await this.stopAfterStartFailure(
            pluginId,
            lateInstance,
            replacementLifecycleHookScope,
          );
        },
      );
    } catch (err) {
      deactivateReplacementHostApi();
      hostEffects.discard();
      if (err instanceof PluginFactoryTimeoutError) {
        this.quarantinePluginLifecycle(pluginId, err.message);
      }
      this.runDisposerList(replacementDisposers, "failed restart factory");
      await this.drainPluginHostApiOperations(pluginId, {
        drainHostApiOperations: drainReplacementHostApiOperations,
      });
      await this.removeUnpublishedRuntimeRoot(pluginId, runtimeRoot);
      plog("error", { pluginId, phase: PluginPhase.RESTART_RELOAD_FAIL, err, reason: "createPlugin_failed" }, "createPlugin failed during restart");
      if (opts.throwOnFailure) throw err;
      return "failed";
    }

    if (!isCurrent()) {
      deactivateReplacementHostApi();
      hostEffects.discard();
      await this.stopAfterStartFailure(pluginId, instance, replacementLifecycleHookScope);
      this.runDisposerList(replacementDisposers, "stale restart factory");
      await this.drainPluginHostApiOperations(pluginId, {
        drainHostApiOperations: drainReplacementHostApiOperations,
      });
      await this.removeUnpublishedRuntimeRoot(pluginId, runtimeRoot);
      return "failed";
    }

    const methods = buildMethodMap(manifest, instance, (toolName) =>
      plog("warn", { pluginId, phase: PluginPhase.REGISTER_TOOL_SKIP, toolName, reason: "missing_handler" }, "tool disabled — missing handler after restart"),
    );

    try {
      if (instance.start) {
        await runStartWithTimeout(
          () => this.runPluginLifecycleHook(
            replacementLifecycleHookScope,
            instance.start!.bind(instance),
          ),
          manifest.startupTimeoutMs,
        );
      }
      plog("debug", { pluginId, phase: PluginPhase.RESTART_START_OK }, "restart complete");
    } catch (err) {
      if (err instanceof PluginStartupTimeoutError) {
        this.quarantinePluginLifecycle(pluginId, err.message);
      }
      plog("error", { pluginId, phase: PluginPhase.RESTART_START_FAIL, err }, "start after restart failed");
      deactivateReplacementHostApi();
      hostEffects.discard();
      await this.stopAfterStartFailure(pluginId, instance, replacementLifecycleHookScope);
      this.runDisposerList(replacementDisposers, "failed restart start");
      await this.drainPluginHostApiOperations(pluginId, {
        drainHostApiOperations: drainReplacementHostApiOperations,
      });
      await this.removeUnpublishedRuntimeRoot(pluginId, runtimeRoot);
      if (opts.throwOnFailure) throw err;
      return "failed";
    }

    if (!isCurrent()) {
      deactivateReplacementHostApi();
      hostEffects.discard();
      await this.stopAfterStartFailure(pluginId, instance, replacementLifecycleHookScope);
      this.runDisposerList(replacementDisposers, "stale restart start");
      await this.drainPluginHostApiOperations(pluginId, {
        drainHostApiOperations: drainReplacementHostApiOperations,
      });
      await this.removeUnpublishedRuntimeRoot(pluginId, runtimeRoot);
      return "failed";
    }
    const candidate: PluginRuntimeGenerationProjection = Object.freeze({
      activationId,
      installId: this.requirePluginInstallClaim(pluginId),
      manifest,
      pluginRoot: runtimeRoot,
      instance,
      methods: new Map(methods),
      ...(approvedPluginAccess ? { approvedPluginAccess } : {}),
      hostEffects,
      disposers: replacementDisposers,
      deactivateHostApi: deactivateReplacementHostApi,
      drainHostApiOperations: drainReplacementHostApiOperations,
      lifecycleHookScope: replacementLifecycleHookScope,
    });
    try {
      await generationLifecycle.replaceRuntime(
        candidate,
        this.capabilityDependencyCommitScope(() => {
          if (!isCurrent()) {
            throw new Error(`plugin restart cancelled for ${pluginId}`);
          }
          this.assertActiveCapabilityDependencies(manifest, "plugin restart");
          this.assertActiveCapabilityDependentsRemainSatisfied(
            pluginId,
            manifest,
            "plugin restart",
          );
          commitReplacementHostApi();
        }),
      );
    } catch (error) {
      deactivateReplacementHostApi();
      if (hostEffects.isPreparing()) hostEffects.discard();
      await this.stopAfterStartFailure(pluginId, instance, replacementLifecycleHookScope);
      this.runDisposerList(replacementDisposers, "failed restart publication");
      await this.drainPluginHostApiOperations(pluginId, {
        drainHostApiOperations: drainReplacementHostApiOperations,
      });
      await this.removeUnpublishedRuntimeRoot(pluginId, runtimeRoot);
      plog("error", { pluginId, phase: PluginPhase.RESTART_RELOAD_FAIL, err: error, reason: "publication" }, "runtime generation publication failed");
      return "failed";
    }
    this.onEnable?.(pluginId);
    return "started";
  }

  /** US-A3 — Targeted single-plugin add for install / install-local paths. */
  async addPlugin(pluginId: string): Promise<"started" | "preparing"> {
    const knownPluginId = this.resolveKnownPluginId(pluginId);
    this.assertPluginLifecycleAvailable(knownPluginId);
    if (!this.capabilityBlockedRetryAdds.has(knownPluginId)) {
      this.clearCapabilityBlockedRetry(
        knownPluginId,
        `plugin '${knownPluginId}' capability dependency wait was superseded by a new add`,
      );
    }
    if (this.plugins.has(knownPluginId)) {
      try {
        const restartResult = await this.restartPlugin(knownPluginId);
        if (restartResult === "deferred") return "preparing";
        if (restartResult === "failed") {
          throw new Error(`restartPlugin failed for ${pluginId}`);
        }
      } catch (err) {
        if ((err as { code?: string })?.code === "plugin-identity-collision") throw err;
        throw new Error(`addPlugin failed for ${pluginId}: ${(err as Error).message}`);
      }
      this.throwIfPluginFailedAfterAdd(knownPluginId);
      return "started";
    }

    const activePreparationGeneration = this.pluginLifecycleGenerations.get(knownPluginId);
    const lifecycleGeneration =
      this.preparation.hasPending(knownPluginId) && activePreparationGeneration !== undefined
        ? activePreparationGeneration
        : this.beginPluginLifecycleOperation(pluginId);

    const loadPlan = await this.resolveManifestLoadPlanInternal();
    if (this.pluginLifecycleGenerations.get(pluginId) !== lifecycleGeneration) {
      throw new Error(`addPlugin cancelled for ${pluginId}`);
    }
    const currentIdentities = await this.assertCurrentPluginIdentityLoadPlan(loadPlan);
    if (this.pluginLifecycleGenerations.get(pluginId) !== lifecycleGeneration) {
      throw new Error(`addPlugin cancelled for ${pluginId}`);
    }
    const targetIdentity = currentIdentities.find(({ plan }) =>
      plan.enabled && plan.pluginIdHint === pluginId
    ) ?? currentIdentities.find(({ plan, snapshot }) =>
      !plan.pluginIdHint && plan.enabled && snapshot.manifest.id === pluginId
    );
    const snapshot = targetIdentity?.snapshot;
    const targetPlan = targetIdentity?.plan;
    if (!snapshot) {
      const requestedPlan = loadPlan.find((plan) => plan.pluginIdHint === pluginId);
      if (requestedPlan?.enabled) {
        await this.readManifest(requestedPlan.manifestPath); // throws with the actual reason
      }
      throw new Error(`addPlugin: plugin not found in registry or disabled: ${pluginId}`);
    }
    if (!targetPlan) {
      throw new Error(`addPlugin: load plan entry missing for ${pluginId}`);
    }

    const { manifest, approvedPluginAccess } = snapshot;
    if (!this.adoptPluginLifecycleIdentity(
      pluginId,
      manifest.id,
      lifecycleGeneration,
      targetPlan.pluginIdHint,
    )) {
      throw new Error(`addPlugin cancelled for ${pluginId}`);
    }
    const shouldCommit = () =>
      this.isPluginLifecycleOperationCurrent(manifest.id, lifecycleGeneration);
    if (!shouldCommit()) throw new Error(`addPlugin cancelled for ${pluginId}`);
    this.rememberPluginManifest(manifest.id, manifest, approvedPluginAccess);

    const startResult = await this.instantiateAndStartSinglePlugin(
      targetPlan,
      manifest,
      approvedPluginAccess,
      { shouldCommit },
    );
    if (startResult === "deferred") return "preparing";
    if (startResult === "cancelled") {
      throw new Error(`addPlugin cancelled for ${pluginId}`);
    }

    // IPC install callers need a hard failure signal for rollback.
    this.throwIfPluginFailedAfterAdd(manifest.id);
    return "started";
  }

  /** US-A3 — Targeted single-plugin remove for uninstall paths. */
  async removePlugin(
    pluginId: string,
    options: { preserveConfigOverride?: boolean } = {},
  ): Promise<void> {
    const canonicalPluginId = this.resolveKnownPluginId(pluginId);
    // Cancel dependency-held restart work before entering the lifecycle lock.
    this.pendingRestartCancellations.get(canonicalPluginId)?.cancel();
    return withPluginInstallLock(canonicalPluginId, () =>
      this.removePluginLocked(pluginId, canonicalPluginId, options)
    );
  }

}
