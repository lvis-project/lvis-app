import { dirname, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
  PluginAccessSpec,
  PluginHostApi,
  PluginManifest,
  RuntimePlugin,
  RuntimePluginFactory,
} from "../types.js";
import type { Actor } from "../deployment-guard.js";
import { PluginDeploymentDeniedError } from "../deployment-guard.js";
import { resolveDependencies } from "../dependency-resolver.js";
import { pluginArtifactGenerationId } from "../plugin-artifact-identity.js";
import { updatePluginRegistry } from "../registry.js";
import type {
  CommittedPluginGeneration,
  PluginRuntimeGenerationLifecycle,
  PluginRuntimeGenerationProjection,
} from "../plugin-host-generation.js";
import { HostApiGenerationScope } from "../plugin-host-effect-scope.js";
import {
  materializePluginGenerationRoot,
  removeRetainedPluginGeneration,
} from "../plugin-contributions.js";
import {
  PluginFactoryTimeoutError,
  PluginStartupTimeoutError,
  runPluginFactoryWithTimeout,
  runStartWithTimeout,
} from "./lifecycle-timeout.js";
import { CapabilityDependencies } from "./capability-dependencies.js";
import {
  buildPluginContext,
  resolveRealEntryPath,
} from "./sandbox.js";
import type {
  LoadedPlugin,
  ManifestLoadPlan,
  PluginLifecycleHookScope,
  SinglePluginStartResult,
} from "./types.js";
import {
  buildMethodMap,
} from "./plugin-loader.js";
import { createLogger } from "../../lib/logger.js";
import { plog, PluginPhase } from "../lifecycle-log.js";
import { withPluginInstallLock } from "../install-lifecycle.js";
import { type RestartPluginResult } from "./runtime-state.js";
import { PluginRuntimePublicationState } from "./runtime-publication-state.js";
import type { PreparedArtifactRuntimeActivationInput } from "./index.js";
import { commitAtomicPluginRemoval } from "./atomic-removal.js";
import type {
  CapabilityBlockedReadiness,
  CapabilityBlockedRetry,
  CapabilityCommitScopedGenerationLifecycle,
  CapabilityDependencyCommitScope,
} from "./runtime-lifecycle-capability-types.js";
const log = createLogger("plugin-runtime");
type PreparedArtifactHostApiIncarnation = {
  hostApi: PluginHostApi;
  disposers: Array<() => void>;
  deactivate: () => void;
  drainOperations: () => Promise<void>;
  commit: () => void;
  lifecycleHookScope: PluginLifecycleHookScope;
};
export abstract class PluginRuntimeCapabilityLifecycle extends PluginRuntimePublicationState {
  private readonly capabilityBlockedRetries = new Map<
    string,
    CapabilityBlockedRetry
  >();
  protected readonly capabilityBlockedReadiness = new Map<
    string,
    CapabilityBlockedReadiness
  >();
  protected readonly capabilityBlockedRetryAdds = new Set<string>();
  private readonly watchedPreparingCapabilityProviders = new Map<string, symbol>();
  private pendingCapabilityBlockedRetry: Promise<void> | undefined;
  private capabilityBlockedRetryRequested = false;

  protected abstract importPluginFactoryForLifecycle(
    pluginId: string,
    resolvedEntryPath: string,
    manifest: PluginManifest,
    bustCache?: boolean,
  ): Promise<RuntimePluginFactory | undefined>;

  protected abstract startLoadedPluginAtBoot(
    pluginId: string,
    expectedPlugin?: LoadedPlugin,
    shouldCommit?: () => boolean,
  ): Promise<string | undefined>;

  protected abstract failBootPlugin(
    pluginId: string,
    plugin: LoadedPlugin,
    reason: string,
  ): Promise<void>;

  abstract restartPlugin(
    pluginId: string,
    opts?: { skipPreparation?: boolean; throwOnFailure?: boolean },
  ): Promise<RestartPluginResult>;

  abstract addPlugin(pluginId: string): Promise<"started" | "preparing">;

  abstract removePlugin(
    pluginId: string,
    options?: { preserveConfigOverride?: boolean },
  ): Promise<void>;

  protected abstract deferBlockedAddPlugin(
    pluginId: string,
    providerIds: readonly string[],
  ): void;
  /**
   * A capability-blocked boot candidate is loaded enough to have a runtime
   * projection, but it has never published a bundle generation. The bundle
   * lifecycle deliberately rejects normal deactivation for that state, because
   * an active pointer must never be fabricated just to tear down a candidate.
   */
  protected isUnpublishedLoadedCandidate(
    pluginId: string,
    plugin: LoadedPlugin,
    generationLifecycle: PluginRuntimeGenerationLifecycle,
  ): boolean {
    return this.plugins.get(pluginId) === plugin
      && plugin.started === false
      && !generationLifecycle.getActive(pluginId);
  }

  private throwUnpublishedCandidateCleanupErrors(pluginId: string, cleanupErrors: readonly Error[]): void {
    if (cleanupErrors.length === 1) throw cleanupErrors[0]!;
    if (cleanupErrors.length > 1) {
      throw new AggregateError(
        cleanupErrors,
        `unpublished plugin candidate cleanup failed: ${pluginId}`,
      );
    }
  }

  private runUnpublishedCandidateDisposers(
    disposers: Array<() => void> | undefined,
    context: string,
    cleanupErrors: Error[],
  ): void {
    if (!disposers) return;
    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        log.error(`disposer failed during ${context}: %s`, normalized.message);
        cleanupErrors.push(normalized);
      }
    }
  }

  /**
   * Retire resources owned by an unpublished candidate. The map/method state is
   * deliberately not touched here: direct removal detaches it synchronously,
   * while prepared replacement has already published the successor. A failed
   * stop, effect cleanup, or HostApi drain preserves the old retained root and
   * is surfaced to the caller's retirement contract.
   */
  private async retireUnpublishedCandidateResources(
    pluginId: string,
    plugin: LoadedPlugin,
    candidateDisposers: Array<() => void> | undefined,
    context: string,
    options: { authorityAlreadyRevoked?: boolean; preserveRuntimeRoot?: string } = {},
    initialErrors: Error[] = [],
  ): Promise<void> {
    const cleanupErrors = [...initialErrors];
    if (!options.authorityAlreadyRevoked) {
      try {
        plugin.deactivateHostApi?.();
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }

    let stopped = false;
    try {
      stopped = await this.stopAfterStartFailure(
        pluginId,
        plugin.instance,
        plugin.lifecycleHookScope,
      );
      if (!stopped) {
        cleanupErrors.push(new Error(`unpublished plugin candidate stop failed: ${pluginId}`));
      }
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
    }

    try {
      if (plugin.hostEffects?.isPreparing()) plugin.hostEffects.discard();
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
    }
    this.runUnpublishedCandidateDisposers(candidateDisposers, context, cleanupErrors);

    let drained = false;
    try {
      drained = await this.drainPluginHostApiOperations(pluginId, plugin);
      if (!drained) {
        cleanupErrors.push(new Error(
          `unpublished plugin candidate HostApi drain failed: ${pluginId}`,
        ));
      }
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
    }

    if (
      cleanupErrors.length === 0
      && stopped
      && drained
      && plugin.pluginRoot !== options.preserveRuntimeRoot
    ) {
      try {
        await this.removeUnpublishedRuntimeRoot(pluginId, plugin.pluginRoot);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    this.throwUnpublishedCandidateCleanupErrors(pluginId, cleanupErrors);
  }

  /**
   * Discard exactly one unstarted, unpublished candidate without touching the
   * bundle-generation pointer. Callers own durable state, retry cancellation,
   * and catalog bookkeeping; this method only retires the candidate-local
   * runtime resources it can prove still belong to `plugin`.
   */
  protected detachUnpublishedLoadedCandidate(
    pluginId: string,
    plugin: LoadedPlugin,
    context: string,
  ): () => Promise<void> {
    if (this.plugins.get(pluginId) !== plugin) {
      throw new Error(`plugin '${pluginId}' unpublished candidate changed before cleanup`);
    }
    const candidateDisposers = this.disposers.get(pluginId);
    const cleanupErrors: Error[] = [];
    try {
      plugin.deactivateHostApi?.();
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
    }
    // Do not remove a same-id successor's handlers if a stale callback manages
    // to interleave with this candidate cleanup.
    if (this.plugins.get(pluginId) !== plugin) {
      throw new Error(`plugin '${pluginId}' unpublished candidate changed during cleanup`);
    }
    for (const [toolName, handler] of plugin.methods) {
      const entry = this.methodMap.get(toolName);
      if (entry?.pluginId === pluginId && entry.handler === handler) {
        this.methodMap.delete(toolName);
      }
    }
    this.plugins.delete(pluginId);
    if (candidateDisposers && this.disposers.get(pluginId) === candidateDisposers) {
      this.disposers.delete(pluginId);
    }
    return () =>
      this.retireUnpublishedCandidateResources(
        pluginId,
        plugin,
        candidateDisposers,
        context,
        { authorityAlreadyRevoked: true },
        cleanupErrors,
      );
  }

  /**
   * Retire a candidate displaced by a successfully published replacement. Its
   * successor already owns the runtime maps, so this only touches resources
   * captured from the exact old object and never mutates current map entries.
   */
  private retireDisplacedUnpublishedLoadedCandidate(
    pluginId: string,
    plugin: LoadedPlugin,
    candidateDisposers: Array<() => void> | undefined,
    replacementRuntimeRoot: string,
    context: string,
  ): Promise<void> {
    if (this.plugins.get(pluginId) === plugin) {
      return Promise.reject(new Error(
        `plugin '${pluginId}' unpublished candidate was not displaced by replacement`,
      ));
    }
    return this.retireUnpublishedCandidateResources(
      pluginId,
      plugin,
      candidateDisposers,
      context,
      { preserveRuntimeRoot: replacementRuntimeRoot },
    );
  }

  protected async removePluginLocked(
    pluginId: string,
    canonicalPluginId: string,
    options: { preserveConfigOverride?: boolean },
  ): Promise<void> {
    this.assertNoActiveCapabilityDependents(canonicalPluginId, "remove");
    this.clearCapabilityBlockedRetry(
      canonicalPluginId,
      `plugin '${canonicalPluginId}' capability dependency wait was cancelled by removal`,
    );
    // Invalidate in-flight add/restart continuations before the first await.
    this.beginPluginLifecycleOperation(canonicalPluginId);
    this.preparation.clearFor(canonicalPluginId);
    this.pendingRestartPreparations.delete(canonicalPluginId);
    // Late incarnations own private disposers; tracked state can be purged
    // without waiting on an invalidated preparation that may never settle.
    const plugin = this.plugins.get(canonicalPluginId);
    let retirementError: unknown;
    let unpublishedCleanup: (() => Promise<void>) | undefined;
    if (plugin) {
      const generationLifecycle = this.requireCapabilityCommitLifecycle("plugin removal");
      if (this.isUnpublishedLoadedCandidate(canonicalPluginId, plugin, generationLifecycle)) {
        unpublishedCleanup = this.detachUnpublishedLoadedCandidate(
          canonicalPluginId,
          plugin,
          "unpublished plugin removal",
        );
      } else {
        const { retirement } = await generationLifecycle.deactivateWithCommit(
          canonicalPluginId,
          async () => undefined,
          this.capabilityDependencyCommitScope(() => {
            this.assertNoActiveCapabilityDependents(canonicalPluginId, "remove");
          }),
        );
        retirementError = await this.captureCommittedRetirementFailure(canonicalPluginId, retirement, "plugin removal");
      }
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
    if (unpublishedCleanup) {
      try {
        await unpublishedCleanup();
      } catch (error) {
        retirementError = error;
      }
    }
    if (retirementError !== undefined) throw retirementError;
  }

  /** Instantiate and start one post-boot plugin without rebuilding its peers. */
  protected async instantiateAndStartSinglePlugin(
    plan: ManifestLoadPlan,
    manifest: PluginManifest,
    approvedPluginAccess: PluginAccessSpec | undefined,
    opts: { skipPreparation?: boolean; cacheBust?: boolean; shouldCommit?: () => boolean } = {},
  ): Promise<SinglePluginStartResult> {
    const generationLifecycle = this.requireCapabilityCommitLifecycle("plugin add");
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
        // Keyed by the canonical manifest id — the caller already remembered
        // the manifest under it, so the registry-id key the receipt check uses
        // would leave that card reporting a non-failed status and strip the
        // reason from `throwIfPluginFailedAfterAdd`.
        this.markReceiptIntegrityFailed(
          manifest.id,
          integrityResult.reason,
          manifest.name ?? manifest.id,
        );
        return "failed";
      }
    }

    // Plugin↔app minimum-version gate — HARD BLOCK at LOAD (see boot path).
    if (!canCommit()) return "cancelled";
    if (this.markIncompatibleAppVersion(manifest)) {
      return "failed";
    }

    // Plugin revocation gate — HARD BLOCK at LOAD (see boot path).
    if (!canCommit()) return "cancelled";
    if (this.markRevoked(manifest)) {
      return "failed";
    }

    const missingCapabilities = this.capabilityDependencies().missing(manifest);
    if (missingCapabilities.length > 0) {
      if (!canCommit()) return "cancelled";
      const preparingProviderIds = this.preparingCapabilityProviderIds(
        manifest,
        missingCapabilities,
      );
      if (preparingProviderIds) {
        // This branch is reached only by PreparationTracker after the
        // consumer's own preparation completed. Waiting here is background
        // work, so startAll/restartAll remain nonblocking.
        if (opts.skipPreparation) {
          await this.waitForPreparingCapabilityProviderChange(
            preparingProviderIds,
          );
          if (!canCommit()) return "cancelled";
          return this.instantiateAndStartSinglePlugin(
            plan,
            manifest,
            approvedPluginAccess,
            opts,
          );
        }
        // Let the existing tracker own a consumer's own preparation first.
        // If it has no preparation hook, retain only the id and re-enter via
        // addPlugin once a provider settles so current identity is re-read.
        if (
          this.preparation.deferStart(
            plan,
            manifest,
            approvedPluginAccess,
            opts,
          )
        ) {
          return "deferred";
        }
        this.deferBlockedAddPlugin(manifest.id, preparingProviderIds);
        return "deferred";
      }
      if (!canCommit()) return "cancelled";
      const reason = `missing required capabilities: ${missingCapabilities.join(", ")}`;
      log.error(`${manifest.id} rejected — ${reason}`);
      this.auditLog?.("error", "plugin_dependency_missing", {
        pluginId: manifest.id,
        missing: missingCapabilities,
      });
      this.markFailed(manifest.id, {
        name: manifest.name ?? manifest.id,
        description: `Missing capabilities: ${missingCapabilities.join(", ")}`,
      });
      return "failed";
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
        manifest,
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

    const methods = buildMethodMap(manifest, instance, (toolName) =>
      plog(
        "warn",
        { pluginId: manifest.id, phase: PluginPhase.REGISTER_TOOL_SKIP, toolName, reason: "missing_handler" },
        "tool disabled — missing handler",
      ),
    );
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
    try {
      await generationLifecycle.replaceRuntime(
        candidate,
        this.capabilityDependencyCommitScope(() => {
          if (!canCommit()) {
            throw new Error(`plugin add cancelled for ${manifest.id}`);
          }
          this.assertActiveCapabilityDependencies(manifest, "plugin add");
          commit();
        }),
      );
    } catch (error) {
      deactivate();
      if (hostEffects.isPreparing()) hostEffects.discard();
      await this.stopAfterStartFailure(manifest.id, instance, lifecycleHookScope);
      this.runDisposerList(disposers, "failed add publication");
      await this.drainPluginHostApiOperations(manifest.id, {
        drainHostApiOperations: drainOperations,
      });
      await this.removeUnpublishedRuntimeRoot(manifest.id, runtimeRoot);
      if (!canCommit()) return "cancelled";
      const missing = this.capabilityDependencies().missing(manifest);
      if (missing.length > 0) {
        this.auditLog?.("error", "plugin_dependency_missing", {
          pluginId: manifest.id,
          missing,
        });
        this.markFailed(manifest.id, {
          name: manifest.name ?? manifest.id,
          description: `Missing capabilities: ${missing.join(", ")}`,
        });
        return "failed";
      }
      throw error;
    }
    this.inactivePluginIds.delete(manifest.id);
    this.perf.recordStartup(manifest.id, startupMs);
    this.resolveCapabilityBlockedRetry(manifest.id);
    this.onEnable?.(manifest.id);
    return "started";
  }

  /** Capability providers are successfully started, actively admitted generations. */
  protected capabilityDependencies(): CapabilityDependencies {
    return new CapabilityDependencies(
      this.knownPluginManifests,
      (pluginId) => this.isPluginGenerationActive(pluginId),
    );
  }

  /**
   * The generation coordinator is authoritative. The local started bit also
   * prevents an unstarted boot candidate from being treated as active by
   * legacy/test lifecycle adapters.
   */
  protected isPluginGenerationActive(pluginId: string): boolean {
    return this.plugins.get(pluginId)?.started === true
      && Boolean(this.generationLifecycle?.getActive(pluginId));
  }

  /**
   * Returns a non-empty provider set only when every missing capability can be
   * supplied by a provider that is already preparing. Callers must not await
   * it on a boot/restart path: readiness is watched in the background so a
   * hung preparation cannot hold the runtime startup promise open.
   */
  protected preparingCapabilityProviderIds(
    manifest: PluginManifest,
    missingCapabilities: readonly string[],
  ): string[] | undefined {
    if (missingCapabilities.length === 0) return undefined;
    const candidatesByCapability = new Map<string, string[]>();
    for (const capability of missingCapabilities) {
      const candidates = [...this.knownPluginManifests.entries()]
        .filter(([pluginId, candidate]) =>
          pluginId !== manifest.id
          && this.preparation.isPreparing(pluginId)
          && candidate.capabilities?.includes(capability),
        )
        .map(([pluginId]) => pluginId);
      if (candidates.length === 0) return undefined;
      candidatesByCapability.set(capability, candidates);
    }

    // A preparation task that would wait back on the current plugin can never
    // publish a provider. Reject that cycle here so both tasks fail closed
    // instead of leaving boot/restart indefinitely "preparing".
    const waitableByCapability = new Map<string, string[]>();
    for (const [capability, candidates] of candidatesByCapability) {
      const waitable = candidates.filter(
        (pluginId) => !this.preparingCapabilityCanReach(pluginId, manifest.id),
      );
      if (waitable.length === 0) return undefined;
      waitableByCapability.set(capability, waitable);
    }
    return [...new Set([...waitableByCapability.values()].flat())];
  }

  /** Waits only inside an already-background preparation task. */
  private async waitForPreparingCapabilityProviderChange(
    providerIds: readonly string[],
  ): Promise<void> {
    await Promise.race(
      providerIds.map((pluginId) =>
        this.preparation.waitForReady(pluginId).catch(() => undefined),
      ),
    );
  }

  /**
   * Keep a consumer visibly preparing and retry it only after one of its
   * concrete provider preparations settles. The retry callback must resolve
   * current runtime identity itself; no stale load plan is retained here.
   */
  protected deferCapabilityBlockedRetry(
    pluginId: string,
    providerIds: readonly string[],
    retry: () => Promise<void>,
    isCurrent: () => boolean,
  ): void {
    if (!isCurrent()) return;
    const readiness = this.capabilityBlockedReadiness.get(pluginId)
      ?? this.createCapabilityBlockedReadiness();
    this.capabilityBlockedReadiness.set(pluginId, readiness);
    const entry: CapabilityBlockedRetry = { retry, isCurrent, readiness };
    this.capabilityBlockedPluginIds.add(pluginId);
    this.capabilityBlockedRetries.set(pluginId, entry);
    this.markPluginUiRevision(pluginId);
    for (const providerId of providerIds) {
      if (!this.preparation.isPreparing(providerId)) continue;
      if (this.watchedPreparingCapabilityProviders.has(providerId)) continue;
      const watchToken = Symbol(providerId);
      this.watchedPreparingCapabilityProviders.set(providerId, watchToken);
      void this.preparation.waitForReady(providerId).then(
        () => this.requestCapabilityBlockedRetry(),
        () => this.requestCapabilityBlockedRetry(),
      ).finally(() => {
        if (this.watchedPreparingCapabilityProviders.get(providerId) === watchToken) {
          this.watchedPreparingCapabilityProviders.delete(providerId);
        }
      });
    }
  }

  /**
   * Captures the exact consumer incarnation that was blocked. A later
   * remove, disable, reset, restart, or reinstall must make the old callback
   * a no-op even if a provider's original readiness promise settles late.
   */
  protected capabilityBlockedRetryGuard(
    pluginId: string,
    manifest: PluginManifest,
    loadedPlugin?: LoadedPlugin,
  ): () => boolean {
    const lifecycleGeneration = this.pluginLifecycleGenerations.get(pluginId);
    const installClaim = this.knownInstallClaims.get(pluginId);
    return () =>
      this.knownPluginManifests.get(pluginId) === manifest
      && this.knownInstallClaims.get(pluginId) === installClaim
      && this.pluginLifecycleGenerations.get(pluginId) === lifecycleGeneration
      && !this.disabledPluginIds.has(pluginId)
      && !this.inactivePluginIds.has(pluginId)
      && (!loadedPlugin || this.plugins.get(pluginId) === loadedPlugin);
  }

  private createCapabilityBlockedReadiness(): CapabilityBlockedReadiness {
    let settled = false;
    let resolvePromise!: () => void;
    let rejectPromise!: (error: Error) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    // Callers can intentionally observe cancellation failures; avoid an
    // unhandled rejection when no caller requested readiness for this block.
    void promise.catch(() => undefined);
    return {
      promise,
      resolve: () => {
        if (settled) return;
        settled = true;
        resolvePromise();
      },
      reject: (error) => {
        if (settled) return;
        settled = true;
        rejectPromise(error);
      },
    };
  }

  protected resolveCapabilityBlockedRetry(
    pluginId: string,
    expectedReadiness?: CapabilityBlockedReadiness,
  ): void {
    const readiness = this.capabilityBlockedReadiness.get(pluginId);
    if (!readiness || (expectedReadiness && readiness !== expectedReadiness)) return;
    this.capabilityBlockedRetries.delete(pluginId);
    this.capabilityBlockedReadiness.delete(pluginId);
    const wasBlocked = this.capabilityBlockedPluginIds.delete(pluginId);
    if (wasBlocked) this.markPluginUiRevision(pluginId);
    readiness.resolve();
  }

  protected rejectCapabilityBlockedRetry(
    pluginId: string,
    error: Error,
    expectedReadiness?: CapabilityBlockedReadiness,
    expectedEntry?: CapabilityBlockedRetry,
  ): void {
    const readiness = this.capabilityBlockedReadiness.get(pluginId);
    const current = this.capabilityBlockedRetries.get(pluginId);
    if (!readiness) {
      if (expectedReadiness) return;
      this.capabilityBlockedRetries.delete(pluginId);
      const wasBlocked = this.capabilityBlockedPluginIds.delete(pluginId);
      if (wasBlocked) this.markPluginUiRevision(pluginId);
      return;
    }
    if (expectedReadiness && readiness !== expectedReadiness) return;
    // A re-deferred retry owns the same readiness promise. An old watcher must
    // never reject that newer attempt after it has replaced the map entry.
    if (expectedEntry && current && current !== expectedEntry) return;
    this.capabilityBlockedRetries.delete(pluginId);
    this.capabilityBlockedReadiness.delete(pluginId);
    const wasBlocked = this.capabilityBlockedPluginIds.delete(pluginId);
    if (wasBlocked) this.markPluginUiRevision(pluginId);
    readiness.reject(error);
  }

  /** Cancel one blocked consumer and fail all of its outstanding waiters. */
  protected clearCapabilityBlockedRetry(
    pluginId: string,
    reason = `plugin '${pluginId}' capability dependency wait was cancelled`,
  ): void {
    this.rejectCapabilityBlockedRetry(pluginId, new Error(reason));
  }

  protected clearAllCapabilityBlockedRetries(): void {
    const blockedPluginIds = new Set([
      ...this.capabilityBlockedRetries.keys(),
      ...this.capabilityBlockedReadiness.keys(),
      ...this.capabilityBlockedPluginIds,
    ]);
    this.watchedPreparingCapabilityProviders.clear();
    this.capabilityBlockedRetryRequested = false;
    for (const pluginId of blockedPluginIds) {
      this.clearCapabilityBlockedRetry(
        pluginId,
        `plugin '${pluginId}' capability dependency wait was cancelled by runtime reset`,
      );
    }
  }

  protected bridgeCapabilityBlockedReadinessToPreparation(pluginId: string): void {
    const readiness = this.capabilityBlockedReadiness.get(pluginId);
    if (!readiness) return;
    const entry: CapabilityBlockedRetry = {
      retry: async () => undefined,
      isCurrent: () => this.preparation.isPreparing(pluginId),
      readiness,
      waitingForOwnPreparation: true,
    };
    this.capabilityBlockedRetries.set(pluginId, entry);
    void this.preparation.waitForReady(pluginId).then(
      () => this.resolveCapabilityBlockedRetry(pluginId, readiness),
      (error: unknown) => this.rejectCapabilityBlockedRetry(
        pluginId,
        error instanceof Error ? error : new Error(String(error)),
        readiness,
        entry,
      ),
    );
  }

  private requestCapabilityBlockedRetry(): void {
    this.capabilityBlockedRetryRequested = true;
    if (this.pendingCapabilityBlockedRetry) return;
    const retryTask = (async () => {
      while (this.capabilityBlockedRetryRequested) {
        this.capabilityBlockedRetryRequested = false;
        for (const [pluginId, entry] of [...this.capabilityBlockedRetries]) {
          if (this.capabilityBlockedRetries.get(pluginId) !== entry) continue;
          if (entry.waitingForOwnPreparation) continue;
          this.capabilityBlockedRetries.delete(pluginId);
          if (!entry.isCurrent()) {
            this.rejectCapabilityBlockedRetry(
              pluginId,
              new Error(`plugin '${pluginId}' capability dependency wait was cancelled`),
              entry.readiness,
              entry,
            );
            continue;
          }
          try {
            await entry.retry();
          } catch (error) {
            if (entry.isCurrent() && this.hasTrackedPluginState(pluginId)) {
              this.markFailed(pluginId, {
                name: this.knownPluginManifests.get(pluginId)?.name ?? pluginId,
                description: error instanceof Error ? error.message : String(error),
              });
            }
            this.rejectCapabilityBlockedRetry(
              pluginId,
              error instanceof Error ? error : new Error(String(error)),
              entry.readiness,
              entry,
            );
            log.error(
              `capability-blocked retry failed for ${pluginId}: ${(error as Error).message}`,
            );
          } finally {
            if (
              !this.capabilityBlockedRetries.has(pluginId)
              && this.capabilityBlockedReadiness.get(pluginId) === entry.readiness
            ) {
              if (this.isPluginGenerationActive(pluginId)) {
                this.resolveCapabilityBlockedRetry(pluginId);
              } else {
                this.rejectCapabilityBlockedRetry(
                  pluginId,
                  new Error(`plugin '${pluginId}' capability dependency retry did not start`),
                  entry.readiness,
                  entry,
                );
              }
            }
          }
        }
      }
    })();
    this.pendingCapabilityBlockedRetry = retryTask;
    void retryTask.finally(() => {
      if (this.pendingCapabilityBlockedRetry !== retryTask) return;
      this.pendingCapabilityBlockedRetry = undefined;
      if (this.capabilityBlockedRetryRequested) {
        this.requestCapabilityBlockedRetry();
      }
    }).catch(() => undefined);
  }
  /** True when a preparing provider would itself wait back on `targetPluginId`. */
  private preparingCapabilityCanReach(
    pluginId: string,
    targetPluginId: string,
    visited = new Set<string>(),
  ): boolean {
    if (pluginId === targetPluginId) return true;
    if (visited.has(pluginId) || !this.preparation.isPreparing(pluginId)) {
      return false;
    }
    visited.add(pluginId);
    const manifest = this.knownPluginManifests.get(pluginId);
    if (!manifest) return false;
    const missing = this.capabilityDependencies().missing(manifest);
    for (const capability of missing) {
      const providers = [...this.knownPluginManifests.entries()]
        .filter(([candidatePluginId, candidate]) =>
          candidatePluginId !== pluginId
          && this.preparation.isPreparing(candidatePluginId)
          && candidate.capabilities?.includes(capability),
        )
        .map(([candidatePluginId]) => candidatePluginId);
      // One alternative provider that can progress without the target breaks
      // this path; a cycle is mandatory only when every candidate for a
      // required capability routes back to the target.
      if (
        providers.length > 0
        && providers.every((providerId) =>
          this.preparingCapabilityCanReach(providerId, targetPluginId, new Set(visited)),
        )
      ) {
        return true;
      }
    }
    return false;
  }

  protected assertEnabledCapabilityDependencies(manifest: PluginManifest): void {
    this.assertActiveCapabilityDependencies(manifest, "plugin re-enable");
  }

  protected assertActiveCapabilityDependencies(
    manifest: PluginManifest,
    operation: string,
  ): void {
    const missing = this.capabilityDependencies().missing(manifest);
    if (missing.length > 0) {
      throw new Error(
        `${operation} blocked — missing required capabilities: ${missing.join(", ")}`,
      );
    }
  }

  /**
   * The bundle lifecycle prepares candidates outside this scope, then calls it
   * immediately around the generation-pointer commit. This closes the gap
   * between dependency admission and a concurrent provider teardown without
   * serializing module import or plugin startup.
   */
  protected capabilityDependencyCommitScope(
    assertDependencies: () => void,
  ): CapabilityDependencyCommitScope {
    return <T>(operation: () => Promise<T>): Promise<T> =>
      this.withCapabilityDependencyCommit(async () => {
        assertDependencies();
        return await operation();
      });
  }

  protected requireCapabilityCommitLifecycle(
    operation: string,
  ): CapabilityCommitScopedGenerationLifecycle {
    return this.requireGenerationLifecycle(operation) as CapabilityCommitScopedGenerationLifecycle;
  }

  /**
   * Refuse a provider teardown when it is the last active provider for an
   * already-admitted consumer. Cascading teardown would be surprising and
   * could expose a consumer while its declared runtime prerequisite is gone.
   */
  protected assertNoActiveCapabilityDependents(
    providerPluginId: string,
    operation: "disable" | "remove",
  ): void {
    this.assertActiveCapabilityDependentsRemainSatisfied(
      providerPluginId,
      undefined,
      `plugin ${operation}`,
    );
  }

  /**
   * Before removing a provider or publishing its replacement, prove every
   * already-active consumer remains covered by the post-change provider set.
   * A replacement may legitimately change capabilities only when another
   * active provider covers each affected consumer requirement.
   */
  protected assertActiveCapabilityDependentsRemainSatisfied(
    providerPluginId: string,
    replacementManifest: PluginManifest | undefined,
    operation: string,
  ): void {
    const blocked = this.activeCapabilityDependentsMissingAfterProviderChange(
      providerPluginId,
      replacementManifest,
    );
    if (blocked.length === 0) return;
    const details = blocked
      .map(({ pluginId, missing }) => `${pluginId} (${missing.join(", ")})`)
      .join("; ");
    throw new Error(
      `${operation} blocked — active dependents require capabilities: ${details}`,
    );
  }

  protected activeCapabilityDependentsMissingAfterProviderChange(
    providerPluginId: string,
    replacementManifest: PluginManifest | undefined,
  ): Array<{ pluginId: string; missing: string[] }> {
    if (!this.isPluginGenerationActive(providerPluginId)) return [];
    const availableProviders = this.capabilityDependencies()
      .activeManifests([providerPluginId]);
    if (replacementManifest) availableProviders.push(replacementManifest);
    const blocked = [...this.knownPluginManifests.entries()].flatMap(
      ([candidatePluginId, candidateManifest]) => {
        if (
          candidatePluginId === providerPluginId
          || !this.isPluginGenerationActive(candidatePluginId)
        ) {
          return [];
        }
        const required = candidateManifest.requires?.capabilities ?? [];
        // A consumer cannot satisfy its own declaration. This mirrors the
        // normal admission resolver, which always excludes the candidate id.
        const dependencyResult = resolveDependencies(
          required,
          availableProviders.filter(
            (providerManifest) => providerManifest.id !== candidatePluginId,
          ),
        );
        return !dependencyResult.ok
          ? [{ pluginId: candidatePluginId, missing: dependencyResult.missing }]
          : [];
      },
    );
    return blocked;
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
        throw new PluginDeploymentDeniedError(
          result.reason ?? `Plugin disable denied: ${pluginId}`,
        );
      }
    }
    if (!this.plugins.has(canonicalPluginId)) {
      throw new Error(`Plugin not loaded: ${pluginId}`);
    }
    this.assertNoActiveCapabilityDependents(canonicalPluginId, "disable");
    const generationLifecycle = this.requireCapabilityCommitLifecycle("plugin disable");
    const plugin = this.plugins.get(canonicalPluginId)!;
    const persistDisable = async (): Promise<void> => {
      if (!this.registryPath) return;
      await updatePluginRegistry(this.registryPath, (registry) => {
        const aliases = new Set([
          canonicalPluginId,
          ...(this.knownInstallAliases.get(canonicalPluginId) ?? []),
        ]);
        const entry = registry.plugins.find((candidate) => aliases.has(candidate.id));
        if (entry) entry.enabled = false;
      });
    };
    let retirement: Promise<void> = Promise.resolve();
    let committedCleanupError: unknown;
    let unpublishedCleanup: (() => Promise<void>) | undefined;
    if (this.isUnpublishedLoadedCandidate(canonicalPluginId, plugin, generationLifecycle)) {
      const commitScope = this.capabilityDependencyCommitScope(() => {
        this.assertNoActiveCapabilityDependents(canonicalPluginId, "disable");
      });
      await generationLifecycle.runInLifecycleQueue(canonicalPluginId, () =>
        commitScope(async () => {
          // Keep the preparing candidate and its readiness promise intact when
          // the durable registry write fails. Once it commits, disable wins and
          // the exact local candidate may be discarded.
          await persistDisable();
          this.pendingRestartPreparations.delete(canonicalPluginId);
          this.clearCapabilityBlockedRetry(
            canonicalPluginId,
            `plugin '${canonicalPluginId}' capability dependency wait was cancelled by disable`,
          );
          this.beginPluginLifecycleOperation(canonicalPluginId);
          this.preparation.clearFor(canonicalPluginId);
          try {
            unpublishedCleanup = this.detachUnpublishedLoadedCandidate(
              canonicalPluginId,
              plugin,
              "unpublished plugin disable",
            );
          } catch (error) {
            committedCleanupError = error;
          }
        }),
      );
    } else {
      this.pendingRestartPreparations.delete(canonicalPluginId);
      this.clearCapabilityBlockedRetry(
        canonicalPluginId,
        `plugin '${canonicalPluginId}' capability dependency wait was cancelled by disable`,
      );
      this.beginPluginLifecycleOperation(canonicalPluginId);
      this.preparation.clearFor(canonicalPluginId);
      const committed = await generationLifecycle.deactivateWithCommit(
        canonicalPluginId,
        persistDisable,
        this.capabilityDependencyCommitScope(() => {
          this.assertNoActiveCapabilityDependents(canonicalPluginId, "disable");
        }),
      );
      retirement = committed.retirement;
    }

    this.disabledPluginIds.add(canonicalPluginId);
    this.failedPluginIds.delete(canonicalPluginId);
    this.invalidatePluginUiRevision(canonicalPluginId);
    this.onDisable?.(canonicalPluginId);
    if (unpublishedCleanup) {
      try {
        await unpublishedCleanup();
      } catch (error) {
        committedCleanupError = committedCleanupError === undefined
          ? error
          : new AggregateError(
              [
                committedCleanupError instanceof Error
                  ? committedCleanupError
                  : new Error(String(committedCleanupError)),
                error instanceof Error ? error : new Error(String(error)),
              ],
              `plugin '${canonicalPluginId}' committed disable cleanup failed`,
            );
      }
    }
    if (committedCleanupError !== undefined) throw committedCleanupError;
    await this.settleCommittedRetirement(canonicalPluginId, retirement, "plugin disable");
  }

  /** Prepare and atomically publish one immutable marketplace generation. */
  async activatePreparedArtifact<T>(
    input: PreparedArtifactRuntimeActivationInput<T>,
  ): Promise<CommittedPluginGeneration<T>> {
    const generationLifecycle = this.requireCapabilityCommitLifecycle("prepared artifact activation");
    if (!this.installReceiptCacheRoot) throw new Error("prepared artifact activation requires installReceiptCacheRoot");
    const manifestRaw = await readFile(resolve(input.pluginRoot, "plugin.json"), "utf8");
    const manifest = JSON.parse(manifestRaw) as PluginManifest;
    if (manifest.id !== input.manifest.id || manifest.version !== input.manifest.version) {
      throw new Error(`prepared artifact manifest identity changed for '${input.manifest.id}'`);
    }
    this.assertActiveCapabilityDependencies(manifest, "prepared artifact activation");
    this.assertActiveCapabilityDependentsRemainSatisfied(
      manifest.id,
      manifest,
      "prepared artifact activation",
    );
    return this.withPreparedInstallIdentity(manifest.id, input.installId, async (installId) => {
    const candidateRegistryEntry = this.validatePreparedRegistryEntry(manifest, input.registryEntry);
    // Marketplace activation builds and starts the candidate directly from the
    // verified staging tree, so it does not pass through restartPlugin's
    // dependency-preparation gate. Prepare declared host-managed runtimes here
    // before the factory snapshots configOverrides; otherwise Python-backed
    // candidates start without the injected pythonExecutable and the atomic
    // update rolls back even though ordinary boot/restart can prepare them.
    const preparationResult = await this.preparePluginStart?.({
        pluginId: manifest.id,
        manifest,
        manifestPath: resolve(input.pluginRoot, "plugin.json"),
        pluginRoot: input.pluginRoot,
      });
    const candidateConfigOverride =
      preparationResult && typeof preparationResult === "object"
        ? preparationResult.configOverride
        : undefined;
    const candidateConfigOverrides = candidateConfigOverride
      ? {
          ...this.configOverrides,
          [manifest.id]: {
            ...(this.configOverrides[manifest.id] ?? {}),
            ...candidateConfigOverride,
          },
        }
      : this.configOverrides;
    const activationId = randomUUID();
    const artifactGenerationId = pluginArtifactGenerationId(manifestRaw, input.receiptRaw);
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
        manifest,
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
    let hostApiIncarnation: PreparedArtifactHostApiIncarnation;
    try {
      pluginDataDir = this.ensureDataDir(manifest.id, payloadRoot);
      hostApiIncarnation = this.buildHostApiIncarnation(
        manifest.id,
        manifest,
        pluginDataDir,
        hostEffects,
        installId,
        candidateRegistryEntry,
        input.approvedPluginAccess ?? null,
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
            configOverrides: candidateConfigOverrides,
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
      return withPluginInstallLock(manifest.id, async () => {
        let displacedUnpublishedCandidate:
          | { plugin: LoadedPlugin; disposers: Array<() => void> | undefined }
          | undefined;
        const result = await generationLifecycle.replaceRuntimeWithCommit(
          projection,
          input.receiptRaw,
          input.durableCommit,
          this.capabilityDependencyCommitScope(() => {
            this.assertActiveCapabilityDependencies(
              manifest,
              "prepared artifact activation",
            );
            this.assertActiveCapabilityDependentsRemainSatisfied(
              manifest.id,
              manifest,
              "prepared artifact activation",
            );
            const incumbent = this.plugins.get(manifest.id);
            if (
              incumbent
              && this.isUnpublishedLoadedCandidate(
                manifest.id,
                incumbent,
                generationLifecycle,
              )
            ) {
              displacedUnpublishedCandidate = {
                plugin: incumbent,
                disposers: this.disposers.get(manifest.id),
              };
            }
            commit();
          }),
        );
        if (candidateConfigOverride) {
          this.mergeConfigOverride(manifest.id, candidateConfigOverride);
        }

        // The durable commit and pointer publication have succeeded. Only now
        // may a blocked incumbent lose its readiness/retry state; durable
        // failure above leaves that exact candidate retryable.
        this.clearCapabilityBlockedRetry(
          manifest.id,
          `plugin '${manifest.id}' capability dependency wait was superseded by prepared activation`,
        );
        this.beginPluginLifecycleOperation(manifest.id);
        this.preparation.clearFor(manifest.id);
        this.onEnable?.(manifest.id);

        const displacedRetirement = displacedUnpublishedCandidate
          ? this.retireDisplacedUnpublishedLoadedCandidate(
              manifest.id,
              displacedUnpublishedCandidate.plugin,
              displacedUnpublishedCandidate.disposers,
              payloadRoot,
              "prepared artifact activation replacement",
            )
          : Promise.resolve();
        const retirement = Promise.all([result.retirement, displacedRetirement])
          .then(() => undefined);
        const completion = Promise.all([result.completion, displacedRetirement])
          .then(() => undefined);
        // Consumers may await the returned retirement; attaching this observer
        // simply prevents an unobserved async cleanup failure from becoming an
        // unhandled rejection before that happens.
        void retirement.catch(() => undefined);
        void completion.catch(() => undefined);
        return Object.freeze({
          result: result.result,
          retirement,
          completion,
          retirementDeferred: result.retirementDeferred,
        });
      });
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
    const generationLifecycle = this.requireCapabilityCommitLifecycle("atomic plugin removal");
    return generationLifecycle.runInLifecycleQueue(canonicalPluginId, () => {
      this.assertNoActiveCapabilityDependents(canonicalPluginId, "remove");
      return commitAtomicPluginRemoval({
        requestedPluginId: pluginId,
        // An unstarted capability-blocked candidate owns a local runtime
        // projection but no bundle generation. Atomic removal must commit the
        // marketplace transaction first, then let removePlugin discard that
        // candidate locally instead of asking PluginBundleLifecycle to invent
        // an inactive generation for it.
        loaded: Boolean(generationLifecycle.getActive(canonicalPluginId)),
        known: this.hasTrackedPluginState(canonicalPluginId),
        hasActiveGeneration: () => Boolean(generationLifecycle.getActive(canonicalPluginId)),
        durableCommit,
        deactivateWithCommit: () =>
          generationLifecycle.deactivateWithCommit(
            canonicalPluginId,
            durableCommit,
            this.capabilityDependencyCommitScope(() => {
              this.assertNoActiveCapabilityDependents(canonicalPluginId, "remove");
            }),
          ),
        captureRetirementFailure: (retirement) =>
          this.captureCommittedRetirementFailure(
            canonicalPluginId,
            retirement,
            "atomic plugin removal",
        ),
        purgeRuntimeState: () => this.removePlugin(canonicalPluginId),
      });
    });
  }

  // ─── Dispatcher / Bridge ───────────────────────────────────────────────────

}
