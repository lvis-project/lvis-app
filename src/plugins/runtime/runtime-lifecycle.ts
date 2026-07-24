import { basename, dirname, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
  PluginAccessSpec,
  PluginManifest,
  PluginToolHandler,
  RuntimePlugin,
  RuntimePluginFactory,
} from "../types.js";
import type { Actor } from "../deployment-guard.js";
import { resolveDependencies } from "../dependency-resolver.js";
import { updatePluginRegistry } from "../registry.js";
import type {
  CommittedPluginGeneration,
  PluginRuntimeGenerationProjection,
} from "../plugin-host-generation.js";
import { HostApiGenerationScope } from "../plugin-host-effect-scope.js";
import {
  materializePluginGenerationRoot,
  removeRetainedPluginGeneration,
} from "../plugin-contributions.js";
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
import type { ManifestLoadPlan, ManifestSnapshot, SinglePluginStartResult } from "./types.js";
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
  PluginRuntimeState,
  type PendingRestartCancellation,
  type RestartPluginResult,
} from "./runtime-state.js";
import type { PreparedArtifactRuntimeActivationInput } from "./index.js";
import {
  preflightPluginLoadPlan,
  type BootPreflightOutcome,
  type PluginIntegrityCheckResult,
} from "./runtime-preflight.js";
import { commitAtomicPluginRemoval } from "./atomic-removal.js";
const log = createLogger("plugin-runtime");
export class PluginRuntimeLifecycle extends PluginRuntimeState {
  private async importPluginFactoryForLifecycle(
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
      enabledManifestSnapshots.set(pluginId, {
        manifest: outcome.manifest,
        approvedPluginAccess: outcome.approvedPluginAccess,
      });
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

      if (manifest.keywords && manifest.keywords.length > 0) {
        hostApi.registerKeywords(manifest.keywords);
        plog("debug", { pluginId: manifest.id, phase: PluginPhase.REGISTER_KEYWORDS_OK, count: manifest.keywords.length }, "keywords registered");
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
      // ConversationLoop scope and the hostApi.registerKeywords gate suppress
      // model-visible tools/keywords for inactive plugins.
    }
    this.loaded = true;
  }

  async startAll(): Promise<void> {
    const generationLifecycle = this.requireGenerationLifecycle("plugin start");
    await this.load();
    const SLOW_THRESHOLD_MS = 5000;
    const failed: Array<{ id: string; reason: string }> = [];

    const tasks = [...this.plugins.values()].map((plugin) => {
      const { id } = plugin.manifest;
      const startedAt = Date.now();
      const slowTimer = setTimeout(() => {
        log.warn(`slow plugin: ${id} (>${SLOW_THRESHOLD_MS}ms)`);
      }, SLOW_THRESHOLD_MS);

      const startPromise = (async () => {
        this.perf.ensure(id);
        try {
          if (!plugin.instance.start) {
            this.perf.setStartupMs(id, Date.now() - startedAt);
            plugin.started = true;
            return;
          }
          try {
            await runStartWithTimeout(
              () => this.runPluginLifecycleHook(
                plugin.lifecycleHookScope,
                plugin.instance.start!.bind(plugin.instance),
              ),
              plugin.manifest.startupTimeoutMs,
            );
          } catch (err) {
            if (err instanceof PluginStartupTimeoutError) {
              this.quarantinePluginLifecycle(id, err.message);
            }
            // Fail closed immediately. Peer starts may still be running, but
            // this failed incarnation must not retain HostApi while the batch
            // waits for them to settle.
            plugin.deactivateHostApi?.();
            throw err;
          }
        } finally {
          clearTimeout(slowTimer);
        }
        const elapsed = Date.now() - startedAt;
        this.perf.setStartupMs(id, elapsed);
        plugin.started = true;
        if (elapsed > SLOW_THRESHOLD_MS) {
          plog("warn", { pluginId: id, phase: PluginPhase.START_SLOW, elapsedMs: elapsed }, "plugin start slow");
        } else {
          plog("debug", { pluginId: id, phase: PluginPhase.START_OK, elapsedMs: elapsed }, "plugin start ok");
        }
      })();

      return startPromise.then(
        () => ({ id, ok: true as const }),
        (err: Error) => ({ id, ok: false as const, reason: err.message }),
      );
    });

    const results = await Promise.allSettled(tasks);
    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      const item = result.value;
      if (!item.ok) failed.push({ id: item.id, reason: item.reason });
    }

    for (const plugin of [...this.plugins.values()]) {
      if (!plugin.started || failed.some((entry) => entry.id === plugin.manifest.id)) continue;
      const projection = this.getRuntimeGenerationProjection(plugin.manifest.id);
      if (!projection) continue;
      try {
        await generationLifecycle.replaceRuntime(projection);
      } catch (error) {
        failed.push({
          id: plugin.manifest.id,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    for (const { id, reason } of failed) {
      plog("error", { pluginId: id, phase: PluginPhase.START_FAIL, reason }, "plugin start failed");
      const plugin = this.plugins.get(id);
      if (!plugin) continue;
      await this.failClosedLoadedPlugin(id, plugin, "start failure cleanup");
      if (plugin.hostEffects?.isPreparing()) plugin.hostEffects.discard();
      await this.removeUnpublishedRuntimeRoot(id, plugin.pluginRoot);
    }
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
    for (const pluginId of lifecycleIds) this.beginPluginLifecycleOperation(pluginId);
    await Promise.allSettled([...this.pendingRestarts.values()]);
    const loadPlan = await this.resolveManifestLoadPlanInternal();
    const currentIdentities = await this.assertCurrentPluginIdentityLoadPlan(loadPlan);
    const targetIds = new Set(
      currentIdentities
        .filter(({ plan }) => plan.enabled)
        .map(({ snapshot }) => snapshot.manifest.id),
    );
    for (const pluginId of [...this.plugins.keys()]) {
      if (!targetIds.has(pluginId)) await this.removePlugin(pluginId);
    }
    for (const pluginId of targetIds) {
      if (this.plugins.has(pluginId)) {
        const result = await this.restartPlugin(pluginId);
        if (result === "failed") throw new Error(`restartAll failed for ${pluginId}`);
      } else {
        await this.addPlugin(pluginId);
      }
    }
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
    const generationLifecycle = this.requireGenerationLifecycle("plugin restart");
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
    const restartPlan: ManifestLoadPlan = targetPlan ?? {
      pluginIdHint: pluginId,
      manifestPath: resolve(pluginRoot, "plugin.json"),
      enabled: true,
      approvedPluginAccess,
    };

    if (!opts.skipPreparation && this.preparePluginStart) {
      const pluginRootForPreparation = dirname(restartPlan.manifestPath);
      let result: Promise<void> | void | null | undefined;
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
        if (result && typeof (result as Promise<void>).then === "function") {
          preparation = Promise.resolve(result);
          this.pendingRestartPreparations.set(pluginId, preparation);
          void preparation.finally(() => {
            if (this.pendingRestartPreparations.get(pluginId) === preparation) {
              this.pendingRestartPreparations.delete(pluginId);
            }
          }).catch(() => {});
        }
      }
      if (preparation) {
        try {
          const outcome = await Promise.race([
            preparation.then(() => "prepared" as const),
            cancellation.promise.then(() => "cancelled" as const),
          ]);
          if (outcome === "cancelled") return "failed";
        } catch (err) {
          plog("error", { pluginId, phase: PluginPhase.START_FAIL, err, reason: "restart_dependency_prepare" }, "restart dependency preparation failed");
          return "failed";
        }
      }
    }

    if (!isCurrent()) return "failed";
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
    if (manifest.keywords && manifest.keywords.length > 0) {
      hostApi.registerKeywords(manifest.keywords);
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
    commitReplacementHostApi();
    try {
      await generationLifecycle.replaceRuntime(candidate);
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

  private async removePluginLocked(
    pluginId: string,
    canonicalPluginId: string,
    options: { preserveConfigOverride?: boolean },
  ): Promise<void> {
    // Invalidate in-flight add/restart continuations before the first await.
    this.beginPluginLifecycleOperation(canonicalPluginId);
    this.preparation.clearFor(canonicalPluginId);
    this.pendingRestartPreparations.delete(canonicalPluginId);
    // Late incarnations own private disposers; tracked state can be purged
    // without waiting on an invalidated preparation that may never settle.
    const plugin = this.plugins.get(canonicalPluginId);
    let retirementError: unknown;
    if (plugin) {
      const generationLifecycle = this.requireGenerationLifecycle("plugin removal");
      const { retirement } = await generationLifecycle.deactivateWithCommit(canonicalPluginId, async () => undefined);
      retirementError = await this.captureCommittedRetirementFailure(canonicalPluginId, retirement, "plugin removal");
    } else if (
      !this.knownPluginManifests.has(canonicalPluginId) &&
      !this.failedPluginIds.has(canonicalPluginId) &&
      !this.failedPluginStubs.has(canonicalPluginId) &&
      !this.disabledPluginIds.has(canonicalPluginId)
    ) {
      log.warn(`removePlugin: plugin not loaded — ${pluginId}`);
      this.knownInstallAliases.delete(canonicalPluginId);
      this.knownInstallClaims.delete(canonicalPluginId);
      this.inactivePluginIds.delete(canonicalPluginId);
      if (!options.preserveConfigOverride) {
        this.configStore.delete(canonicalPluginId);
      }
      return;
    } else {
      log.info(`removePlugin: plugin in non-loaded state (failed/disabled), purging tracking — ${pluginId}`);
    }

    // stop() may persist configuration while releasing resources. Delete the
    // runtime override only after that hook has been bounded and deactivated.
    if (!options.preserveConfigOverride) {
      this.configStore.delete(canonicalPluginId);
    }

    this.knownPluginManifests.delete(canonicalPluginId);
    this.knownPluginAccessGrants.delete(canonicalPluginId);
    for (const [toolName, ownerId] of [...this.knownToolOwners.entries()]) {
      if (ownerId === canonicalPluginId) this.knownToolOwners.delete(toolName);
    }
    for (const [eventType, ownerId] of [...this.knownEventOwners.entries()]) {
      if (ownerId === canonicalPluginId) this.knownEventOwners.delete(eventType);
    }
    this.failedPluginIds.delete(canonicalPluginId);
    this.failedPluginStubs.delete(canonicalPluginId);
    this.loadFailureInfo.delete(canonicalPluginId);
    this.disabledPluginIds.delete(canonicalPluginId);
    this.inactivePluginIds.delete(canonicalPluginId);
    this.invalidatePluginUiRevision(canonicalPluginId);
    this.knownInstallAliases.delete(canonicalPluginId);
    this.knownInstallClaims.delete(canonicalPluginId);

    this.onDisable?.(canonicalPluginId);
    if (retirementError !== undefined) throw retirementError;
  }

  /** Instantiate and start one post-boot plugin without rebuilding its peers. */
  protected async instantiateAndStartSinglePlugin(
    plan: ManifestLoadPlan,
    manifest: PluginManifest,
    approvedPluginAccess: PluginAccessSpec | undefined,
    opts: { skipPreparation?: boolean; cacheBust?: boolean; shouldCommit?: () => boolean } = {},
  ): Promise<SinglePluginStartResult> {
    const generationLifecycle = this.requireGenerationLifecycle("plugin add");
    const pluginRoot = dirname(plan.manifestPath);
    const canCommit = () => opts.shouldCommit?.() ?? true;
    if (!canCommit()) return "cancelled";
    this.rememberPluginInstallAlias(manifest.id, plan.pluginIdHint);
    if (plan.pluginIdHint) {
      const integrityResult = await this.verifyReceiptAndDevGuard(
        plan.pluginIdHint,
        pluginRoot,
      );
      if (!canCommit()) return "cancelled";
      if (!integrityResult.ok) {
        this.markFailed(plan.pluginIdHint);
        return "failed";
      }
    }

    // Plugin↔app minimum-version gate — HARD BLOCK at LOAD (see boot path).
    if (!canCommit()) return "cancelled";
    if (this.markIncompatibleAppVersion(manifest)) {
      return "failed";
    }

    const requiredCapabilities = manifest.requires?.capabilities ?? [];
    if (requiredCapabilities.length > 0) {
      const availableManifests = [...this.knownPluginManifests.entries()]
        .filter(([id]) => id !== manifest.id)
        .map(([, m]) => m);
      const dependencyResult = resolveDependencies(requiredCapabilities, availableManifests);
      if (!dependencyResult.ok) {
        if (!canCommit()) return "cancelled";
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
        return "failed";
      }
    }

    if (!canCommit()) return "cancelled";
    if (!opts.skipPreparation && this.preparation.deferStart(plan, manifest, approvedPluginAccess, opts)) {
      return "deferred";
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
      if (!canCommit()) {
        await this.removeUnpublishedRuntimeRoot(manifest.id, runtimeRoot);
        return "cancelled";
      }
      const reason = (err as Error).message;
      log.error(`${manifest.id} rejected: ${reason}`);
      this.auditLog?.("error", "plugin_entry_path_rejected", {
        pluginId: manifest.id,
        entry: manifest.entry,
        reason,
      });
      this.markFailed(manifest.id);
      await this.removeUnpublishedRuntimeRoot(manifest.id, runtimeRoot);
      return "failed";
    }
    const resolvedEntryPath = resolveRealEntryPath(entryPath);

    let createPlugin: RuntimePluginFactory | undefined;
    try {
      createPlugin = await this.importPluginFactoryForLifecycle(
        manifest.id,
        resolvedEntryPath,
        opts.cacheBust,
      );
    } catch (err) {
      if (!canCommit()) {
        await this.removeUnpublishedRuntimeRoot(manifest.id, runtimeRoot);
        return "cancelled";
      }
      log.error(`${manifest.id} import failed: %s`, (err as Error).message);
      this.auditLog?.("error", "plugin_import_failed", {
        pluginId: manifest.id,
        reason: (err as Error).message,
      });
      this.markFailed(manifest.id);
      await this.removeUnpublishedRuntimeRoot(manifest.id, runtimeRoot);
      return "failed";
    }
    if (!canCommit()) {
      await this.removeUnpublishedRuntimeRoot(manifest.id, runtimeRoot);
      return "cancelled";
    }
    if (!createPlugin) {
      log.error(`${manifest.id} entry does not export default/createPlugin — skipped`);
      this.markFailed(manifest.id);
      await this.removeUnpublishedRuntimeRoot(manifest.id, runtimeRoot);
      return "failed";
    }

    const pluginDataDir = this.ensureDataDir(manifest.id, pluginRoot);
    const hostEffects = new HostApiGenerationScope(manifest.id);
    const { hostApi, disposers, deactivate, drainOperations, commit, lifecycleHookScope } =
      this.buildHostApiIncarnation(
        manifest.id,
        manifest,
        pluginDataDir,
        hostEffects,
      );

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
      this.runDisposerList(disposers, "failed add factory");
      await this.drainPluginHostApiOperations(manifest.id, {
        drainHostApiOperations: drainOperations,
      });
      if (!canCommit()) {
        await this.removeUnpublishedRuntimeRoot(manifest.id, runtimeRoot);
        return "cancelled";
      }
      log.error(`${manifest.id} createPlugin failed: %s`, (err as Error).message);
      this.markFailed(manifest.id);
      await this.removeUnpublishedRuntimeRoot(manifest.id, runtimeRoot);
      return "failed";
    }

    const methods = new Map<string, PluginToolHandler>();
    for (const toolName of declaredRuntimeMethods(manifest)) {
      const handler = instance.handlers[toolName];
      if (!handler) {
        log.warn(`missing handler '${toolName}' — tool disabled`);
        continue;
      }
      methods.set(toolName, handler);
      const owner = this.methodMap.get(toolName)?.pluginId;
      if (owner && owner !== manifest.id) {
        deactivate();
        hostEffects.discard();
        await this.stopAfterStartFailure(manifest.id, instance, lifecycleHookScope);
        this.runDisposerList(disposers, "duplicate add method");
        await this.drainPluginHostApiOperations(manifest.id, {
          drainHostApiOperations: drainOperations,
        });
        await this.removeUnpublishedRuntimeRoot(manifest.id, runtimeRoot);
        throw new Error(`Duplicate plugin method registered: ${toolName}`);
      }
    }

    if (!canCommit()) {
      deactivate();
      hostEffects.discard();
      await this.stopAfterStartFailure(manifest.id, instance, lifecycleHookScope);
      this.runDisposerList(disposers, "stale add factory");
      await this.drainPluginHostApiOperations(manifest.id, {
        drainHostApiOperations: drainOperations,
      });
      await this.removeUnpublishedRuntimeRoot(manifest.id, runtimeRoot);
      return "cancelled";
    }

    let startupMs = 0;
    if (instance.start) {
      const startedAt = Date.now();
      try {
        await runStartWithTimeout(
          () => this.runPluginLifecycleHook(
            lifecycleHookScope,
            instance.start!.bind(instance),
          ),
          manifest.startupTimeoutMs,
        );
        startupMs = Date.now() - startedAt;
      } catch (err) {
        deactivate();
        hostEffects.discard();
        if (err instanceof PluginStartupTimeoutError) {
          this.quarantinePluginLifecycle(manifest.id, err.message);
        }
        if (!canCommit()) {
          await this.stopAfterStartFailure(manifest.id, instance, lifecycleHookScope);
          this.runDisposerList(disposers, "stale add start");
          await this.drainPluginHostApiOperations(manifest.id, {
            drainHostApiOperations: drainOperations,
          });
          await this.removeUnpublishedRuntimeRoot(manifest.id, runtimeRoot);
          return "cancelled";
        }
        log.error(`start during addPlugin failed: %s`, (err as Error).message);
        this.markFailed(manifest.id);
        await this.stopAfterStartFailure(manifest.id, instance, lifecycleHookScope);
        this.runDisposerList(disposers, "failed add start");
        await this.drainPluginHostApiOperations(manifest.id, {
          drainHostApiOperations: drainOperations,
        });
        await this.removeUnpublishedRuntimeRoot(manifest.id, runtimeRoot);
        return "failed";
      }
    }
    if (!canCommit()) {
      deactivate();
      hostEffects.discard();
      await this.stopAfterStartFailure(manifest.id, instance, lifecycleHookScope);
      this.runDisposerList(disposers, "stale add commit");
      await this.drainPluginHostApiOperations(manifest.id, {
        drainHostApiOperations: drainOperations,
      });
      await this.removeUnpublishedRuntimeRoot(manifest.id, runtimeRoot);
      return "cancelled";
    }
    for (const toolName of methods.keys()) {
      const owner = this.methodMap.get(toolName)?.pluginId;
      if (owner && owner !== manifest.id) {
        deactivate();
        hostEffects.discard();
        await this.stopAfterStartFailure(manifest.id, instance, lifecycleHookScope);
        this.runDisposerList(disposers, "duplicate add method");
        await this.drainPluginHostApiOperations(manifest.id, {
          drainHostApiOperations: drainOperations,
        });
        await this.removeUnpublishedRuntimeRoot(manifest.id, runtimeRoot);
        throw new Error(`Duplicate plugin method registered: ${toolName}`);
      }
    }
    if (manifest.keywords && manifest.keywords.length > 0) {
      hostApi.registerKeywords(manifest.keywords);
    }
    const candidate: PluginRuntimeGenerationProjection = Object.freeze({
      activationId,
      installId: this.requirePluginInstallClaim(manifest.id),
      manifest,
      pluginRoot: runtimeRoot,
      instance,
      methods: new Map(methods),
      ...(approvedPluginAccess ? { approvedPluginAccess } : {}),
      hostEffects,
      disposers,
      deactivateHostApi: deactivate,
      drainHostApiOperations: drainOperations,
      lifecycleHookScope,
    });
    commit();
    try {
      await generationLifecycle.replaceRuntime(candidate);
    } catch (error) {
      deactivate();
      if (hostEffects.isPreparing()) hostEffects.discard();
      await this.stopAfterStartFailure(manifest.id, instance, lifecycleHookScope);
      this.runDisposerList(disposers, "failed add publication");
      await this.drainPluginHostApiOperations(manifest.id, {
        drainHostApiOperations: drainOperations,
      });
      await this.removeUnpublishedRuntimeRoot(manifest.id, runtimeRoot);
      throw error;
    }
    this.inactivePluginIds.delete(manifest.id);
    this.perf.recordStartup(manifest.id, startupMs);
    this.onEnable?.(manifest.id);
    return "started";
  }

  /** I2 — Plugin live-reload (dev only). */
  async reloadPlugin(pluginId: string): Promise<void> {
    const canonicalPluginId = this.resolveKnownPluginId(pluginId);
    this.assertPluginLifecycleAvailable(canonicalPluginId);
    this.requireGenerationLifecycle("plugin reload");
    const pendingRestart = this.pendingRestarts.get(canonicalPluginId);
    if (pendingRestart) {
      this.pendingRestartCancellations.get(canonicalPluginId)?.cancel();
      await pendingRestart;
    }
    const result = await this.restartPlugin(canonicalPluginId, {
      skipPreparation: true,
      throwOnFailure: true,
    });
    if (result !== "started") {
      throw new Error(
        `reloadPlugin failed for ${canonicalPluginId}: ${result ?? "not-loaded"}`,
      );
    }
  }

  /** Disable a loaded plugin at runtime. */
  async disable(pluginId: string, actor: Actor = "user"): Promise<void> {
    const canonicalPluginId = this.resolveKnownPluginId(pluginId);
    this.pendingRestartCancellations.get(canonicalPluginId)?.cancel();
    return withPluginInstallLock(canonicalPluginId, () =>
      this.disableLocked(pluginId, canonicalPluginId, actor)
    );
  }

  private async disableLocked(
    pluginId: string,
    canonicalPluginId: string,
    actor: Actor,
  ): Promise<void> {
    if (this.deploymentGuard) {
      const result = await this.deploymentGuard.canDisable(pluginId, actor);
      if (!result.allowed) {
        throw new Error(result.reason ?? `Plugin disable denied: ${pluginId}`);
      }
    }
    this.pendingRestartPreparations.delete(canonicalPluginId);
    this.beginPluginLifecycleOperation(canonicalPluginId);
    this.preparation.clearFor(canonicalPluginId);

    if (!this.plugins.has(canonicalPluginId)) {
      throw new Error(`Plugin not loaded: ${pluginId}`);
    }

    const generationLifecycle = this.requireGenerationLifecycle("plugin disable");
    const { retirement } = await generationLifecycle.deactivateWithCommit(canonicalPluginId, async () => {
      if (!this.registryPath) return;
      await updatePluginRegistry(this.registryPath, (registry) => {
        const aliases = new Set([
          canonicalPluginId,
          ...(this.knownInstallAliases.get(canonicalPluginId) ?? []),
        ]);
        const entry = registry.plugins.find((candidate) => aliases.has(candidate.id));
        if (entry) entry.enabled = false;
      });
    });

    this.disabledPluginIds.add(canonicalPluginId);
    this.failedPluginIds.delete(canonicalPluginId);
    this.invalidatePluginUiRevision(canonicalPluginId);
    this.onDisable?.(canonicalPluginId);
    await this.settleCommittedRetirement(canonicalPluginId, retirement, "plugin disable");
  }

  /** Prepare and atomically publish one immutable marketplace generation. */
  async activatePreparedArtifact<T>(
    input: PreparedArtifactRuntimeActivationInput<T>,
  ): Promise<CommittedPluginGeneration<T>> {
    const generationLifecycle = this.requireGenerationLifecycle("prepared artifact activation");
    if (!this.installReceiptCacheRoot) throw new Error("prepared artifact activation requires installReceiptCacheRoot");
    const manifestRaw = await readFile(resolve(input.pluginRoot, "plugin.json"), "utf8");
    const manifest = JSON.parse(manifestRaw) as PluginManifest;
    if (manifest.id !== input.manifest.id || manifest.version !== input.manifest.version) {
      throw new Error(`prepared artifact manifest identity changed for '${input.manifest.id}'`);
    }
    return this.withPreparedInstallIdentity(manifest.id, input.installId, async (installId) => {
    const candidateRegistryEntry = this.validatePreparedRegistryEntry(manifest, input.registryEntry);
    const activationId = randomUUID();
    const artifactGenerationId = createHash("sha256")
      .update(manifestRaw)
      .update("\0")
      .update(input.receiptRaw)
      .digest("hex");
    const generationId = createHash("sha256")
      .update(artifactGenerationId)
      .update("\0")
      .update(activationId)
      .digest("hex");
    const payloadRoot = await materializePluginGenerationRoot(
      input.pluginRoot,
      this.installReceiptCacheRoot!,
      manifest.id,
      generationId,
      input.receiptRaw,
      installId,
    );
    let createPlugin: RuntimePluginFactory | undefined;
    try {
      const entryPath = this.resolveEntryPathForPlugin(payloadRoot, manifest.entry);
      createPlugin = await this.importPluginFactoryForLifecycle(
        manifest.id,
        resolveRealEntryPath(entryPath),
        true,
      );
    } catch (error) {
      await removeRetainedPluginGeneration(
        this.installReceiptCacheRoot!,
        manifest.id,
        generationId,
      );
      throw error;
    }
    if (!createPlugin) {
      await removeRetainedPluginGeneration(
        this.installReceiptCacheRoot!,
        manifest.id,
        generationId,
      );
      throw new Error(`prepared artifact '${manifest.id}' has no default/createPlugin export`);
    }
    const hostEffects = new HostApiGenerationScope(manifest.id);
    let pluginDataDir: string;
    let hostApiIncarnation: ReturnType<PluginRuntimeLifecycle["buildHostApiIncarnation"]>;
    try {
      pluginDataDir = this.ensureDataDir(manifest.id, payloadRoot);
      hostApiIncarnation = this.buildHostApiIncarnation(
        manifest.id,
        manifest,
        pluginDataDir,
        hostEffects,
        installId,
        candidateRegistryEntry,
      );
    } catch (error) {
      hostEffects.discard();
      await removeRetainedPluginGeneration(
        this.installReceiptCacheRoot!,
        manifest.id,
        generationId,
      );
      throw error;
    }
    const {
      hostApi,
      disposers,
      deactivate,
      drainOperations,
      commit,
      lifecycleHookScope,
    } = hostApiIncarnation;
    let instance: RuntimePlugin | undefined;
    try {
      instance = await runPluginFactoryWithTimeout(
        () => this.runPluginLifecycleHook(
          lifecycleHookScope,
          () => createPlugin(buildPluginContext({
            pluginId: manifest.id,
            pluginRoot: payloadRoot,
            hostRoot: this.hostRoot,
            pluginDataDir,
            manifest,
            configOverrides: this.configOverrides,
            hostApi,
          })),
        ),
        async (lateInstance) => {
          deactivate();
          await this.stopAfterStartFailure(manifest.id, lateInstance, lifecycleHookScope);
        },
      );
      const methods = buildMethodMap(manifest, instance, (toolName) =>
        plog(
          "warn",
          { pluginId: manifest.id, phase: PluginPhase.REGISTER_TOOL_SKIP, toolName, reason: "missing_handler" },
          "tool disabled — missing handler in prepared artifact",
        ),
      );
      if (manifest.keywords && manifest.keywords.length > 0) {
        hostApi.registerKeywords(manifest.keywords);
      }
      if (instance.start) {
        await runStartWithTimeout(
          () => this.runPluginLifecycleHook(
            lifecycleHookScope,
            instance!.start!.bind(instance),
          ),
          manifest.startupTimeoutMs,
        );
      }
      const projection: PluginRuntimeGenerationProjection = Object.freeze({
        activationId,
        installId,
        manifest,
        pluginRoot: payloadRoot,
        instance,
        methods: new Map(methods),
        ...(input.approvedPluginAccess ? { approvedPluginAccess: input.approvedPluginAccess } : {}),
        hostEffects,
        disposers,
        deactivateHostApi: deactivate,
        drainHostApiOperations: drainOperations,
        lifecycleHookScope,
      });
      commit();
      const result = await generationLifecycle.replaceRuntimeWithCommit(
        projection,
        input.receiptRaw,
        input.durableCommit,
      );
      this.onEnable?.(manifest.id);
      return result;
    } catch (error) {
      if (
        error instanceof PluginFactoryTimeoutError
        || error instanceof PluginStartupTimeoutError
      ) {
        this.quarantinePluginLifecycle(manifest.id, error.message);
      }
      const committed = generationLifecycle.getActive(manifest.id)?.generationId === generationId;
      if (!committed) {
        deactivate();
        if (hostEffects.isPreparing()) hostEffects.discard();
        if (instance) {
          await this.stopAfterStartFailure(manifest.id, instance, lifecycleHookScope);
        }
        this.runDisposerList(disposers, "failed prepared artifact activation");
        await this.drainPluginHostApiOperations(manifest.id, {
          drainHostApiOperations: drainOperations,
        });
        await removeRetainedPluginGeneration(
          this.installReceiptCacheRoot!,
          manifest.id,
          generationId,
        );
      }
      throw error;
    }
    });
  }

  async removePluginWithCommit<T>(
    pluginId: string,
    durableCommit: () => Promise<T>,
  ): Promise<T> {
    const canonicalPluginId = this.resolveKnownPluginId(pluginId);
    const generationLifecycle = this.requireGenerationLifecycle("atomic plugin removal");
    return generationLifecycle.runInLifecycleQueue(canonicalPluginId, () =>
      commitAtomicPluginRemoval({
        requestedPluginId: pluginId,
        loaded: this.plugins.has(canonicalPluginId),
        known: this.hasTrackedPluginState(canonicalPluginId),
        hasActiveGeneration: () => Boolean(generationLifecycle.getActive(canonicalPluginId)),
        durableCommit,
        deactivateWithCommit: () =>
          generationLifecycle.deactivateWithCommit(canonicalPluginId, durableCommit),
        captureRetirementFailure: (retirement) =>
          this.captureCommittedRetirementFailure(
            canonicalPluginId,
            retirement,
            "atomic plugin removal",
          ),
        purgeRuntimeState: () => this.removePlugin(canonicalPluginId),
      }),
    );
  }

  // ─── Dispatcher / Bridge ───────────────────────────────────────────────────

}
