import { basename, dirname, resolve } from "node:path";
import type {
  PluginAccessSpec,
  PluginManifest,
  PluginToolHandler,
  RuntimePlugin,
  RuntimePluginFactory,
} from "../types.js";
import type { Actor } from "../deployment-guard.js";
import { resolveDependencies } from "../dependency-resolver.js";
import { isDevModeUnlocked } from "../../boot/dev-flags.js";
import { verifyInstallReceipt } from "../plugin-install-receipt.js";
import { updatePluginRegistry } from "../registry.js";
import { runStartWithTimeout } from "./lifecycle-timeout.js";

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
import { PluginRuntimeState, type RestartPluginResult } from "./runtime-state.js";

const log = createLogger("plugin-runtime");
const BOOT_PREFLIGHT_CONCURRENCY = 4;

type PluginIntegrityCheckResult =
  | {
      ok: true;
      verified?: {
        installSource: "marketplace" | "local-dev";
        signerKeyId: string | null;
        artifactSha256: string | null;
      };
    }
  | {
      ok: false;
      reason: string;
      error?: unknown;
    };

type BootPreflightOutcome =
  | {
      ok: true;
      plan: ManifestLoadPlan;
      manifest: PluginManifest;
      approvedPluginAccess: PluginAccessSpec | undefined;
      integrityResult?: PluginIntegrityCheckResult;
    }
  | {
      ok: false;
      plan: ManifestLoadPlan;
      kind: "integrity";
      integrityResult: PluginIntegrityCheckResult & { ok: false };
    }
  | {
      ok: false;
      plan: ManifestLoadPlan;
      kind: "manifest";
      error: unknown;
      integrityResult?: PluginIntegrityCheckResult;
    };

/**
 * Bounded parallel map whose result positions always match the input order.
 * Receipt hashing is I/O-heavy, so an unbounded Promise.all can make startup
 * slower on large managed fleets even though a small amount of overlap helps.
 */
async function mapBoundedInOrder<T, R>(
  items: readonly T[],
  concurrency: number,
  mapItem: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapItem(items[index]!, index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, () => worker()),
  );
  return results;
}

export class PluginRuntimeLifecycle extends PluginRuntimeState {
  protected async preflightBootLoadPlan(
    loadPlan: ManifestLoadPlan[],
  ): Promise<BootPreflightOutcome[]> {
    if (loadPlan.length === 0) return [];
    // Compile AJV once before concurrent reads. This also prevents parallel
    // callers from paying duplicate schema-compilation cost.
    await this.getManifestValidator();
    return mapBoundedInOrder(
      loadPlan,
      BOOT_PREFLIGHT_CONCURRENCY,
      async (plan): Promise<BootPreflightOutcome> => {
        let integrityResult: PluginIntegrityCheckResult | undefined;
        if (plan.pluginIdHint) {
          try {
            integrityResult = await this.verifyReceiptAndDevGuard(
              plan.pluginIdHint,
              dirname(plan.manifestPath),
              { report: false },
            );
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            integrityResult = {
              ok: false,
              reason: `install receipt verification failed unexpectedly: ${detail}`,
              error,
            };
          }
          if (!integrityResult.ok) {
            return { ok: false, plan, kind: "integrity", integrityResult };
          }
        }
        try {
          const manifest = await this.readManifest(plan.manifestPath, { report: false });
          return {
            ok: true,
            plan,
            manifest,
            approvedPluginAccess: plan.approvedPluginAccess,
            integrityResult,
          };
        } catch (error) {
          return { ok: false, plan, kind: "manifest", error, integrityResult };
        }
      },
    );
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    const loadPlan = await this.resolveManifestLoadPlanInternal();
    for (const plan of loadPlan) {
      const pluginId = plan.pluginIdHint ?? `<unresolved:${basename(dirname(plan.manifestPath))}>`;
      plog("debug", { pluginId, phase: PluginPhase.LOAD_START }, "loading plugin");
    }
    const preflight = await this.preflightBootLoadPlan(loadPlan);
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
      const pluginId = plan.pluginIdHint ?? `<unresolved:${basename(dirname(manifestPath))}>`;
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
      const { manifest, approvedPluginAccess } = outcome;
      this.rememberPluginInstallAlias(manifest.id, plan.pluginIdHint);
      this.knownPluginManifests.set(manifest.id, manifest);
      this.failedPluginStubs.delete(manifest.id);
      this.loadFailureInfo.delete(manifest.id);
      // #1176 M1 fix: inactive plugins (enabled=false) are LOADED just like
      // active ones — only model exposure is gated. Seed inactivePluginIds here
      // so isPluginEnabled() is correct immediately after boot; the boot
      // ToolRegistry sync and hostApi.registerKeywords gate suppress inactive
      // tools/keywords without stop/reload churn.
      if (!plan.enabled) {
        this.inactivePluginIds.add(manifest.id);
      } else {
        // Ensure a previously-inactive plugin becomes active on re-enable.
        this.inactivePluginIds.delete(manifest.id);
      }
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
      let entryPath: string;
      try {
        entryPath = this.resolveEntryPathForPlugin(pluginRoot, manifest.entry);
      } catch (err) {
        const reason = (err as Error).message;
        plog("error", { pluginId: manifest.id, phase: PluginPhase.LOAD_FAIL, err, reason: "entry_path" }, "entry path rejected");
        this.auditLog?.("error", "plugin_entry_path_rejected", {
          pluginId: manifest.id,
          entry: manifest.entry,
          reason,
        });
        this.markFailed(manifest.id);
        continue;
      }
      const resolvedEntryPath = resolveRealEntryPath(entryPath);
      let createPlugin: RuntimePluginFactory | undefined;
      try {
        createPlugin = await importPluginFactory(resolvedEntryPath);
      } catch (err) {
        plog("error", { pluginId: manifest.id, phase: PluginPhase.LOAD_FAIL, err, reason: "import" }, "import failed");
        this.auditLog?.("error", "plugin_import_failed", {
          pluginId: manifest.id,
          reason: (err as Error).message,
        });
        this.markFailed(manifest.id);
        continue;
      }
      if (!createPlugin) {
        plog("error", { pluginId: manifest.id, phase: PluginPhase.LOAD_FAIL, reason: "no_default_export" }, "entry does not export default/createPlugin");
        this.markFailed(manifest.id);
        continue;
      }

      const pluginDataDir = this.ensureDataDir(manifest.id, pluginRoot);
      const hostApi = this.buildHostApi(manifest.id, manifest, pluginDataDir);

      const instance = await createPlugin(
        buildPluginContext({
          pluginId: manifest.id,
          pluginRoot,
          hostRoot: this.hostRoot,
          pluginDataDir,
          manifest,
          configOverrides: this.configOverrides,
          hostApi,
        }),
      );

      const methods = new Map<string, PluginToolHandler>();
      for (const toolName of declaredRuntimeMethods(manifest)) {
        const handler = instance.handlers[toolName];
        if (!handler) {
          plog("warn", { pluginId: manifest.id, phase: PluginPhase.REGISTER_TOOL_SKIP, toolName, reason: "missing_handler" }, "tool disabled — missing handler");
          continue;
        }
        methods.set(toolName, handler);
        if (this.methodMap.has(toolName)) {
          throw new Error(`Duplicate plugin method registered: ${toolName}`);
        }
        this.methodMap.set(toolName, { pluginId: manifest.id, handler });
        plog("debug", { pluginId: manifest.id, phase: PluginPhase.REGISTER_TOOL_OK, toolName }, "tool registered");
      }

      if (manifest.keywords && manifest.keywords.length > 0) {
        hostApi.registerKeywords(manifest.keywords);
        plog("debug", { pluginId: manifest.id, phase: PluginPhase.REGISTER_KEYWORDS_OK, count: manifest.keywords.length }, "keywords registered");
      }

      this.plugins.set(manifest.id, {
        manifest,
        pluginRoot,
        instance,
        methods,
        approvedPluginAccess,
        started: false,
      });
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
          await runStartWithTimeout(
            plugin.instance.start.bind(plugin.instance),
            plugin.manifest.startupTimeoutMs,
          );
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

    for (const { id, reason } of failed) {
      plog("error", { pluginId: id, phase: PluginPhase.START_FAIL, reason }, "plugin start failed");
      const plugin = this.plugins.get(id);
      if (!plugin) continue;
      this.markFailed(id);
      this.cleanupFailedStartRuntimeState(id, plugin.methods);
      await this.stopAfterStartFailure(plugin.manifest.id, plugin.instance);
    }
  }

  async stopAll(): Promise<void> {
    for (const plugin of this.plugins.values()) {
      try {
        await plugin.instance.stop?.();
      } catch (err) {
        log.error(`stopAll failed for ${plugin.manifest.id}: %s`, (err as Error).message);
      }
    }
  }

  async restartAll(): Promise<void> {
    const loadedPluginIds = [...this.plugins.keys()];
    await this.stopAll();
    for (const pluginId of loadedPluginIds) {
      this.onDisable?.(pluginId);
    }
    this.resetLoadedState();
    await this.startAll();
    // Symmetric to the per-plugin onDisable fan-out above: fire onEnable for
    // each plugin that survived the restart so the host's ToolRegistry sync
    // (wired in boot/steps/plugin-runtime.ts) runs without callers having to
    // remember a follow-up sync. Initial boot's `startAll` is the only path
    // that intentionally bypasses onEnable — registration there flows through
    // PluginLoopbackManager (each plugin runs as an in-process MCP server),
    // wired in boot/steps/plugin-runtime.ts, which owns that one-shot.
    // See architecture.md §9.3a.
    if (this.onEnable) {
      for (const pluginId of this.plugins.keys()) {
        this.onEnable(pluginId);
      }
    }
  }

  /**
   * US-3c.2 — Targeted single-plugin restart.
   */
  async restartPlugin(
    pluginId: string,
    opts: { skipPreparation?: boolean } = {},
  ): Promise<RestartPluginResult> {
    const pending = this.pendingRestarts.get(pluginId);
    if (pending) return pending;
    const generation = this.beginPluginLifecycleOperation(pluginId);
    const restart = this.restartPluginInternal(pluginId, generation, opts).finally(() => {
      if (this.pendingRestarts.get(pluginId) === restart) {
        this.pendingRestarts.delete(pluginId);
      }
    });
    this.pendingRestarts.set(pluginId, restart);
    return restart;
  }

  protected async restartPluginInternal(
    pluginId: string,
    generation: number,
    opts: { skipPreparation?: boolean } = {},
  ): Promise<RestartPluginResult> {
    plog("info", { pluginId, phase: PluginPhase.RESTART_REQUEST }, "restart requested");
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      plog("warn", { pluginId, phase: PluginPhase.RESTART_REQUEST, reason: "not_loaded" }, "restart no-op — plugin not loaded");
      return undefined;
    }
    const isCurrent = () => this.isPluginLifecycleOperationCurrent(pluginId, generation);

    const loadPlan = await this.resolveManifestLoadPlanInternal();
    const enabledSnapshots = await this.readSnapshotsInternal(loadPlan);
    const snapshot = enabledSnapshots.get(pluginId);
    const targetPlan = loadPlan.find(
      (p) =>
        p.pluginIdHint === pluginId ||
        (p.enabled && this.matchesManifestPath(p.manifestPath, pluginId)),
    );
    const pluginRoot = targetPlan ? dirname(targetPlan.manifestPath) : plugin.pluginRoot;
    const approvedPluginAccess =
      snapshot?.approvedPluginAccess ??
      targetPlan?.approvedPluginAccess ??
      plugin.approvedPluginAccess ??
      this.knownPluginAccessGrants.get(pluginId);
    const integrityResult = await this.verifyReceiptAndDevGuard(pluginId, pluginRoot);
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
          await preparation;
        } catch (err) {
          plog("error", { pluginId, phase: PluginPhase.START_FAIL, err, reason: "restart_dependency_prepare" }, "restart dependency preparation failed");
          return "failed";
        }
      }
    }

    if (!isCurrent()) return "failed";

    const entryPath = this.resolveEntryPathForPlugin(pluginRoot, manifest.entry);
    const resolvedEntryPath = resolveRealEntryPath(entryPath);
    // Cache-bust: Node ESM loader memoizes by URL — without it
    // restart re-runs createPlugin against the OLD module's closures
    // even when the on-disk bundle changed. Mirrors `reloadPlugin`.
    let createPlugin: RuntimePluginFactory | undefined;
    try {
      createPlugin = await importPluginFactory(resolvedEntryPath, true);
      plog("debug", { pluginId, phase: PluginPhase.RESTART_RELOAD_OK }, "module re-imported");
    } catch (err) {
      plog("error", { pluginId, phase: PluginPhase.RESTART_RELOAD_FAIL, err }, "module re-import failed");
      return "failed";
    }

    if (!isCurrent()) return "failed";

    if (!createPlugin) {
      plog("error", { pluginId, phase: PluginPhase.RESTART_RELOAD_FAIL, reason: "no_default_export" }, "entry does not export default/createPlugin after restart");
      return "failed";
    }

    const pluginDataDir = this.ensureDataDir(pluginId, pluginRoot);
    const hostApi = this.buildHostApi(pluginId, manifest, pluginDataDir);

    let instance: RuntimePlugin;
    try {
      instance = await createPlugin(
        buildPluginContext({
          pluginId,
          pluginRoot,
          hostRoot: this.hostRoot,
          pluginDataDir,
          manifest,
          configOverrides: this.configOverrides,
          hostApi,
        }),
      );
    } catch (err) {
      plog("error", { pluginId, phase: PluginPhase.RESTART_RELOAD_FAIL, err, reason: "createPlugin_failed" }, "createPlugin failed during restart");
      return "failed";
    }

    if (!isCurrent()) {
      await this.stopAfterStartFailure(pluginId, instance);
      return "failed";
    }

    const methods = buildMethodMap(manifest, instance, (toolName) =>
      plog("warn", { pluginId, phase: PluginPhase.REGISTER_TOOL_SKIP, toolName, reason: "missing_handler" }, "tool disabled — missing handler after restart"),
    );

    try {
      await instance.start?.();
      plog("debug", { pluginId, phase: PluginPhase.RESTART_START_OK }, "restart complete");
    } catch (err) {
      plog("error", { pluginId, phase: PluginPhase.RESTART_START_FAIL, err }, "start after restart failed");
      await this.stopAfterStartFailure(pluginId, instance);
      throw new Error(`restartPlugin failed for ${pluginId}: ${(err as Error).message}`);
    }

    if (!isCurrent()) {
      await this.stopAfterStartFailure(pluginId, instance);
      return "failed";
    }

    try {
      await plugin.instance.stop?.();
      plog("debug", { pluginId, phase: PluginPhase.RESTART_STOP_OK }, "stopped previous instance");
    } catch (err) {
      plog("error", { pluginId, phase: PluginPhase.RESTART_STOP_FAIL, err }, "stop during restart failed");
    }
    if (!isCurrent()) {
      await this.stopAfterStartFailure(pluginId, instance);
      return "failed";
    }

    for (const method of plugin.methods.keys()) {
      this.methodMap.delete(method);
    }
    this.plugins.delete(pluginId);

    const pluginDisposers = this.disposers.get(pluginId);
    if (pluginDisposers) {
      for (const d of pluginDisposers) {
        try { d(); } catch (err) {
          log.error(`disposer failed during restartPlugin: %s`, (err as Error).message);
        }
      }
      this.disposers.delete(pluginId);
    }

    this.onDisable?.(pluginId);

    this.rememberPluginManifest(pluginId, manifest, approvedPluginAccess);
    for (const [toolName, handler] of methods) {
      this.methodMap.set(toolName, { pluginId, handler });
    }
    if (manifest.keywords && manifest.keywords.length > 0) {
      hostApi.registerKeywords(manifest.keywords);
    }
    this.plugins.set(pluginId, {
      manifest,
      pluginRoot,
      instance,
      methods,
      approvedPluginAccess,
      started: true,
    });
    this.markPluginUiRevision(pluginId);
    this.failedPluginIds.delete(pluginId);
    this.disabledPluginIds.delete(pluginId);
    this.onEnable?.(pluginId);
    return "started";
  }

  /**
   * Live view of the raw config-override map, backed by {@link configStore}.
   * Retained as an instance member of this name because unit tests assert
   * against the runtime's internal override map directly (see
   * `runtime-wildcard-config.test.ts`).
   */
  protected get configOverrides(): Record<string, Record<string, unknown>> {
    return this.configStore.all();
  }

  setConfigOverride(pluginId: string, config: Record<string, unknown>): void {
    this.configStore.set(pluginId, config);
  }

  mergeConfigOverride(pluginId: string, config: Record<string, unknown>): void {
    this.configStore.merge(pluginId, config);
  }

  /**
   * #893 — Wildcard (`"*"` slot) config injection. Plugins read the active
   * LLM vendor id via `hostApi.config.get("hostApiVendor")`; the raw API key
   * is NOT injected here — callers must obtain it through `getSecret` so it
   * never appears in the plain-object config map. Merges with existing
   * wildcard overrides (e.g. `pythonExecutable`) so calling this does NOT
   * clobber unrelated keys set by other boot steps.
   */
  setWildcardConfigOverride(config: Record<string, unknown>): void {
    this.configStore.setWildcard(config);
  }

  /**
   * #893 / PR #894 B2 — Read the wildcard slot so `hostApi.config.get(...)`
   * can merge host-injected values (e.g. `hostApiVendor`) into every
   * plugin's effective config map. Returns an empty object when no wildcard
   * overrides have been set so callers can spread the result unconditionally.
   * The returned object is a shallow copy — callers MUST NOT mutate it.
   */
  getWildcardConfigOverride(): Record<string, unknown> {
    return this.configStore.getWildcard();
  }

  /**
   * #893 — Inverse of `setWildcardConfigOverride`. Clears ONLY the keys
   * named in `keys` from the wildcard slot, preserving other injected
   * values. When `keys` is empty the call is a no-op so the unrelated
   * `pythonExecutable` slot survives a vendor swap.
   */
  clearWildcardConfigOverride(keys: string[]): void {
    this.configStore.clearWildcard(keys);
  }

  /**
   * US-A3 — Targeted single-plugin add for install / install-local paths.
   */
  async addPlugin(pluginId: string): Promise<"started" | "preparing"> {
    if (this.plugins.has(pluginId)) {
      try {
        const restartResult = await this.restartPlugin(pluginId);
        if (restartResult === "deferred") return "preparing";
        if (restartResult === "failed") {
          throw new Error(`restartPlugin failed for ${pluginId}`);
        }
      } catch (err) {
        throw new Error(`addPlugin failed for ${pluginId}: ${(err as Error).message}`);
      }
      this.throwIfPluginFailedAfterAdd(pluginId);
      return "started";
    }

    const activePreparationGeneration = this.pluginLifecycleGenerations.get(pluginId);
    const lifecycleGeneration =
      this.preparation.hasPending(pluginId) && activePreparationGeneration !== undefined
        ? activePreparationGeneration
        : this.beginPluginLifecycleOperation(pluginId);
    const shouldCommit = () =>
      this.isPluginLifecycleOperationCurrent(pluginId, lifecycleGeneration);

    const loadPlan = await this.resolveManifestLoadPlanInternal();
    const enabledSnapshots = await this.readSnapshotsInternal(loadPlan);
    const snapshot = enabledSnapshots.get(pluginId);
    const targetPlan = loadPlan.find(
      (p) => p.pluginIdHint === pluginId || (p.enabled && this.matchesManifestPath(p.manifestPath, pluginId)),
    );
    if (!snapshot) {
      if (targetPlan?.enabled) {
        await this.readManifest(targetPlan.manifestPath); // throws with the actual reason
      }
      throw new Error(`addPlugin: plugin not found in registry or disabled: ${pluginId}`);
    }
    if (!targetPlan) {
      throw new Error(`addPlugin: load plan entry missing for ${pluginId}`);
    }

    const { manifest, approvedPluginAccess } = snapshot;
    this.rememberPluginInstallAlias(manifest.id, pluginId);
    this.knownPluginManifests.set(manifest.id, manifest);
    this.knownPluginAccessGrants.set(manifest.id, approvedPluginAccess);
    this.rememberToolOwners(manifest.id, manifest); // #885 §2.4a MODEL-ONLY (see method)
    for (const eventType of getDeclaredEmittedEvents(manifest)) {
      this.knownEventOwners.set(eventType, manifest.id);
    }

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

    // Throw if the plugin landed in failed state — caller (IPC install
    // handler) catches to roll back marketplace state. boot-time `load()`
    // doesn't take this path; it inlines its own iteration.
    this.throwIfPluginFailedAfterAdd(pluginId);
    return "started";
  }

  /**
   * US-A3 — Targeted single-plugin remove for uninstall paths.
   */
  async removePlugin(pluginId: string): Promise<void> {
    // Invalidate in-flight add/restart continuations before the first await.
    this.beginPluginLifecycleOperation(pluginId);
    this.preparation.clearFor(pluginId);
    // A direct runtime caller can overlap remove with a replacement even
    // though all product IPC paths share the install mutex. Wait for the
    // invalidated restart to finish its stale-instance cleanup before we run
    // the plugin's disposer set; otherwise a late start() subscription could
    // be registered after uninstall has already swept the map.
    const pendingRestart = this.pendingRestarts.get(pluginId);
    if (pendingRestart) {
      try {
        await pendingRestart;
      } catch {
        // Removal still owns the final cleanup after a failed replacement.
      }
    }
    this.configStore.delete(pluginId);
    // Plugin may be in one of three states when uninstall is requested:
    //   - loaded (`this.plugins` has it) → run stop + dispose, then clean
    //     all tracking maps below
    //   - failed-load (in `failedPluginIds` / `failedPluginStubs` /
    //     `knownPluginManifests` but NOT in `this.plugins`) → skip the
    //     stop/dispose path but still clean tracking so `listPluginCards`
    //     stops surfacing a stale entry after marketplace registry purge
    //   - not tracked at all (no-op)
    //
    // Pre-fix: an early `return` when `this.plugins` lacked the entry
    // left failed-load plugins in `failedPluginStubs` / `knownPluginManifests`
    // forever — UI showed the ghost card and a second uninstall click hit
    // `Plugin not found` from the deployment guard against the already-purged
    // marketplace registry.
    const plugin = this.plugins.get(pluginId);
    if (plugin) {
      try {
        await plugin.instance.stop?.();
      } catch (err) {
        log.error(`stop during removePlugin failed: %s`, (err as Error).message);
      }

      for (const method of plugin.methods.keys()) {
        this.methodMap.delete(method);
      }
      this.plugins.delete(pluginId);

      const pluginDisposers = this.disposers.get(pluginId);
      if (pluginDisposers) {
        for (const d of pluginDisposers) {
          try { d(); } catch (err) {
            log.error(`disposer failed during removePlugin: %s`, (err as Error).message);
          }
        }
        this.disposers.delete(pluginId);
      }
    } else if (
      !this.knownPluginManifests.has(pluginId) &&
      !this.failedPluginIds.has(pluginId) &&
      !this.failedPluginStubs.has(pluginId) &&
      !this.disabledPluginIds.has(pluginId)
    ) {
      log.warn(`removePlugin: plugin not loaded — ${pluginId}`);
      return;
    } else {
      log.info(`removePlugin: plugin in non-loaded state (failed/disabled), purging tracking — ${pluginId}`);
    }

    this.knownPluginManifests.delete(pluginId);
    this.knownPluginAccessGrants.delete(pluginId);
    for (const [toolName, ownerId] of [...this.knownToolOwners.entries()]) {
      if (ownerId === pluginId) this.knownToolOwners.delete(toolName);
    }
    for (const [eventType, ownerId] of [...this.knownEventOwners.entries()]) {
      if (ownerId === pluginId) this.knownEventOwners.delete(eventType);
    }
    this.failedPluginIds.delete(pluginId);
    this.failedPluginStubs.delete(pluginId);
    this.loadFailureInfo.delete(pluginId);
    this.disabledPluginIds.delete(pluginId);
    this.pluginUiRevisions.delete(pluginId);

    this.onDisable?.(pluginId);
  }

  /** Helper: does a manifest path's directory name suggest it owns `pluginId`? */
  protected matchesManifestPath(manifestPath: string, pluginId: string): boolean {
    const parent = dirname(manifestPath);
    const dirName = parent.split(/[\\/]/).pop() ?? "";
    return dirName === pluginId || dirName === pluginId.replace(/[^a-zA-Z0-9._-]/g, "-");
  }

  /**
   * Verify the install receipt for `pluginId` under `pluginRoot` and enforce
   * the dev-signer-in-packaged-build guard. Reporting may be deferred so boot
   * can perform concurrent checks while emitting results in registry order.
   *
   * Returns `{ ok: true }` when verification passes (or is not required).
   * Returns `{ ok: false }` when the plugin must be rejected — the caller is
   * responsible for calling `markFailed` and deciding the control-flow
   * (`continue` vs `return`).
   *
   * Skips all checks when `installReceiptCacheRoot` is not configured.
   * Receipt verification now applies to every install source (admin / user /
   * local-dev) — the legacy dev-link bypass was removed when the dev:link
   * script was deleted.
   */
  protected async verifyReceiptAndDevGuard(
    pluginId: string,
    pluginRoot: string,
    options: { report?: boolean } = {},
  ): Promise<PluginIntegrityCheckResult> {
    if (!this.installReceiptCacheRoot) {
      return { ok: true };
    }
    const receiptResult = await verifyInstallReceipt(
      this.installReceiptCacheRoot,
      pluginId,
      pluginRoot,
    );
    if (!receiptResult.ok) {
      const result = { ok: false as const, reason: receiptResult.reason };
      if (options.report !== false) this.reportPluginIntegrityResult(pluginId, result);
      return result;
    }
    const { installSource, signerKeyId, artifactSha256 } = receiptResult.receipt;
    // Policy gate: local-dev receipts are only valid in unpackaged dev builds.
    // verifyInstallReceipt is a pure integrity verifier; environment-based
    // policy (packaged vs dev) is enforced here in the runtime layer.
    if (installSource === "local-dev" && !isDevModeUnlocked()) {
      const reason = "local-dev install rejected in packaged build";
      const result = { ok: false as const, reason };
      if (options.report !== false) this.reportPluginIntegrityResult(pluginId, result);
      return result;
    }
    const result: PluginIntegrityCheckResult = {
      ok: true,
      verified: { installSource, artifactSha256, signerKeyId },
    };
    if (options.report !== false) this.reportPluginIntegrityResult(pluginId, result);
    return result;
  }

  protected reportPluginIntegrityResult(
    pluginId: string,
    result: PluginIntegrityCheckResult,
  ): void {
    if (!result.ok) {
      log.error(
        { pluginId, reason: result.reason, ...(result.error === undefined ? {} : { err: result.error }) },
        `${pluginId} rejected — install receipt integrity failed`,
      );
      try {
        this.auditLog?.("error", "plugin_integrity_rejected", {
          pluginId,
          reason: result.reason,
        });
      } catch (error) {
        log.error({ pluginId, err: error }, "plugin integrity rejection audit failed");
      }
      return;
    }
    if (!result.verified) return;
    try {
      this.auditLog?.("info", "plugin_integrity_verified", {
        pluginId,
        ...result.verified,
      });
    } catch (error) {
      log.error({ pluginId, err: error }, "plugin integrity verification audit failed");
    }
  }

  /**
   * Per-plugin instantiation + start. Used by `addPlugin` for post-boot
   * fresh-load installs. Boot's `startAll` intentionally bypasses this path
   * — it runs its own inline start loop and lets registration flow through
   * PluginLoopbackManager (each plugin runs as an in-process MCP server),
   * wired in boot/steps/plugin-runtime.ts, which owns the one-shot
   * ToolRegistry population (see §9.3a). This method fires
   * `onEnable` on the start-success branch so post-boot installs converge
   * the host's transient state automatically.
   */
  protected async instantiateAndStartSinglePlugin(
    plan: ManifestLoadPlan,
    manifest: PluginManifest,
    approvedPluginAccess: PluginAccessSpec | undefined,
    opts: { skipPreparation?: boolean; cacheBust?: boolean; shouldCommit?: () => boolean } = {},
  ): Promise<SinglePluginStartResult> {
    const pluginRoot = dirname(plan.manifestPath);
    this.rememberPluginInstallAlias(manifest.id, plan.pluginIdHint);
    if (plan.pluginIdHint) {
      const integrityResult = await this.verifyReceiptAndDevGuard(
        plan.pluginIdHint,
        pluginRoot,
      );
      if (!integrityResult.ok) {
        this.markFailed(plan.pluginIdHint);
        return "failed";
      }
    }

    // Plugin↔app minimum-version gate — HARD BLOCK at LOAD (see boot path).
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

    if (!opts.skipPreparation && this.preparation.deferStart(plan, manifest, approvedPluginAccess, opts)) {
      return "deferred";
    }

    let entryPath: string;
    try {
      entryPath = this.resolveEntryPathForPlugin(pluginRoot, manifest.entry);
    } catch (err) {
      const reason = (err as Error).message;
      log.error(`${manifest.id} rejected: ${reason}`);
      this.auditLog?.("error", "plugin_entry_path_rejected", {
        pluginId: manifest.id,
        entry: manifest.entry,
        reason,
      });
      this.markFailed(manifest.id);
      return "failed";
    }
    const resolvedEntryPath = resolveRealEntryPath(entryPath);

    let createPlugin: RuntimePluginFactory | undefined;
    try {
      createPlugin = await importPluginFactory(resolvedEntryPath, opts.cacheBust);
    } catch (err) {
      log.error(`${manifest.id} import failed: %s`, (err as Error).message);
      this.auditLog?.("error", "plugin_import_failed", {
        pluginId: manifest.id,
        reason: (err as Error).message,
      });
      this.markFailed(manifest.id);
      return "failed";
    }
    if (!createPlugin) {
      log.error(`${manifest.id} entry does not export default/createPlugin — skipped`);
      this.markFailed(manifest.id);
      return "failed";
    }

    const pluginDataDir = this.ensureDataDir(manifest.id, pluginRoot);
    const hostApi = this.buildHostApi(manifest.id, manifest, pluginDataDir);

    let instance: RuntimePlugin;
    try {
      instance = await createPlugin(
        buildPluginContext({
          pluginId: manifest.id,
          pluginRoot,
          hostRoot: this.hostRoot,
          pluginDataDir,
          manifest,
          configOverrides: this.configOverrides,
          hostApi,
        }),
      );
    } catch (err) {
      log.error(`${manifest.id} createPlugin failed: %s`, (err as Error).message);
      this.markFailed(manifest.id);
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
      if (this.methodMap.has(toolName)) {
        throw new Error(`Duplicate plugin method registered: ${toolName}`);
      }
    }

    if (opts.shouldCommit && !opts.shouldCommit()) {
      await this.stopAfterStartFailure(manifest.id, instance);
      return "cancelled";
    }

    let startupMs = 0;
    if (instance.start) {
      const startedAt = Date.now();
      try {
        await runStartWithTimeout(instance.start.bind(instance), manifest.startupTimeoutMs);
        startupMs = Date.now() - startedAt;
      } catch (err) {
        if (opts.shouldCommit && !opts.shouldCommit()) {
          await this.stopAfterStartFailure(manifest.id, instance);
          return "cancelled";
        }
        log.error(`start during addPlugin failed: %s`, (err as Error).message);
        this.markFailed(manifest.id);
        await this.stopAfterStartFailure(manifest.id, instance);
        return "failed";
      }
    }
    if (opts.shouldCommit && !opts.shouldCommit()) {
      await this.stopAfterStartFailure(manifest.id, instance);
      return "cancelled";
    }
    for (const toolName of methods.keys()) {
      if (this.methodMap.has(toolName)) {
        await this.stopAfterStartFailure(manifest.id, instance);
        throw new Error(`Duplicate plugin method registered: ${toolName}`);
      }
    }
    for (const [toolName, handler] of methods) {
      this.methodMap.set(toolName, { pluginId: manifest.id, handler });
    }

    if (manifest.keywords && manifest.keywords.length > 0) {
      hostApi.registerKeywords(manifest.keywords);
    }

    this.plugins.set(manifest.id, {
      manifest,
      pluginRoot,
      instance,
      methods,
      approvedPluginAccess,
      started: true,
    });
    this.markPluginUiRevision(manifest.id);
    this.failedPluginIds.delete(manifest.id);
    this.loadFailureInfo.delete(manifest.id);
    this.disabledPluginIds.delete(manifest.id);

    this.perf.recordStartup(manifest.id, startupMs);
    this.onEnable?.(manifest.id);
    return "started";
  }

  /**
   * I2 — Plugin live-reload (dev only).
   */
  async reloadPlugin(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      throw new Error(`Plugin not loaded: ${pluginId}`);
    }
    const { manifest, pluginRoot } = plugin;

    try {
      await plugin.instance.stop?.();
    } catch (err) {
      log.error(`stop during reload failed: %s`, (err as Error).message);
    }

    if (plugin) {
      for (const method of plugin.methods.keys()) {
        this.methodMap.delete(method);
      }
    }
    this.plugins.delete(pluginId);
    const pluginDisposers = this.disposers.get(pluginId);
    if (pluginDisposers) {
      for (const d of pluginDisposers) {
        try { d(); } catch (err) {
          log.error(`disposer failed during reload: %s`, (err as Error).message);
        }
      }
      this.disposers.delete(pluginId);
    }

    this.onDisable?.(pluginId);

    const entryPath = this.resolveEntryPathForPlugin(pluginRoot, manifest.entry);
    const resolvedEntryPath = resolveRealEntryPath(entryPath);
    // cache-bust for dev reload
    const createPlugin = await importPluginFactory(resolvedEntryPath, true);
    if (!createPlugin) {
      throw new Error(`Plugin entry does not export default/createPlugin: ${pluginId}`);
    }

    const pluginDataDir = this.ensureDataDir(pluginId, pluginRoot);
    const hostApi = this.buildHostApi(pluginId, manifest, pluginDataDir);
    const instance = await createPlugin(
      buildPluginContext({
        pluginId,
        pluginRoot,
        hostRoot: this.hostRoot,
        pluginDataDir,
        manifest,
        configOverrides: this.configOverrides,
        hostApi,
      }),
    );

    const methods = buildMethodMap(manifest, instance, (toolName) =>
      log.warn(`missing handler '${toolName}' after reload — tool disabled`),
    );
    for (const [toolName, handler] of methods) {
      this.methodMap.set(toolName, { pluginId, handler });
    }

    if (manifest.keywords && manifest.keywords.length > 0) {
      hostApi.registerKeywords(manifest.keywords);
    }

    this.plugins.set(pluginId, {
      manifest,
      pluginRoot,
      instance,
      methods,
      approvedPluginAccess: this.plugins.get(pluginId)?.approvedPluginAccess ?? this.knownPluginAccessGrants.get(pluginId),
      started: false,
    });

    try {
      await instance.start?.();
      this.plugins.get(pluginId)!.started = true;
      this.markPluginUiRevision(pluginId);
    } catch (err) {
      log.error(`start after reload failed: %s`, (err as Error).message);
      this.markFailed(pluginId);
      this.cleanupFailedStartRuntimeState(pluginId, methods);
      await this.stopAfterStartFailure(pluginId, instance);
      throw err;
    }
    this.onEnable?.(pluginId);
  }

  /**
   * Disable a loaded plugin at runtime.
   */
  async disable(pluginId: string, actor: Actor = "user"): Promise<void> {
    if (this.deploymentGuard) {
      const result = await this.deploymentGuard.canDisable(pluginId, actor);
      if (!result.allowed) {
        throw new Error(result.reason ?? `Plugin disable denied: ${pluginId}`);
      }
    }

    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      throw new Error(`Plugin not loaded: ${pluginId}`);
    }

    // Durable state is the source of truth. Do not tear down the live plugin
    // until the registry transaction commits successfully.
    if (this.registryPath) {
      await updatePluginRegistry(this.registryPath, (registry) => {
        const entry = registry.plugins.find((p) => p.id === pluginId);
        if (entry) entry.enabled = false;
      });
    }

    try {
      await plugin.instance.stop?.();
    } catch (err) {
      log.error(`stop during disable failed: %s`, (err as Error).message);
    }

    for (const method of plugin.methods.keys()) {
      this.methodMap.delete(method);
    }
    this.plugins.delete(pluginId);

    const pluginDisposers = this.disposers.get(pluginId);
    if (pluginDisposers) {
      for (const d of pluginDisposers) {
        try { d(); } catch (err) {
          log.error(`disposer failed: %s`, (err as Error).message);
        }
      }
      this.disposers.delete(pluginId);
    }
    this.disabledPluginIds.add(pluginId);
    this.failedPluginIds.delete(pluginId);
    this.pluginUiRevisions.delete(pluginId);

    this.onDisable?.(pluginId);
  }

  // ─── Dispatcher / Bridge ───────────────────────────────────────────────────

}
