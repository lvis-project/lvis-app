/**
 * PluginRuntime orchestrator.
 *
 * This class is a thin coordinator that delegates to domain modules:
 *   - manifest-validation.ts  — AJV + MUST/SHOULD checks
 *   - snapshots.ts            — readEnabledManifestSnapshots, load plan, trust boundary
 *   - sandbox.ts              — entry-path resolution, data-dir, noop HostApi
 */

import { dirname, resolve } from "node:path";
import type { ValidateFunction } from "ajv";
import type {
  InstallPolicy,
  PluginAccessSpec,
  PluginConfigSchema,
  PluginHostApi,
  PluginManifest,
  PluginToolHandler,
  PluginUiExtension,
  RuntimePlugin,
  RuntimePluginFactory,
} from "../types.js";
import { createPluginStorage } from "../storage.js";
import type { Actor, PluginDeploymentGuard } from "../deployment-guard.js";
import { resolveDependencies } from "../dependency-resolver.js";
import { devLinkedEntryAllowed, getIsPackaged } from "../../boot/dev-flags.js";
import { verifyInstallReceipt } from "../plugin-install-receipt.js";
import { updatePluginRegistry } from "../registry.js";

import {
  buildManifestValidator,
  getDeclaredEmittedEvents,
  normalizeInstallPolicy,
  parsePluginJson,
} from "./manifest-validation.js";
import {
  readEnabledManifestSnapshots,
  resolveManifestLoadPlan,
} from "./snapshots.js";
import {
  buildImportUrl,
  buildPluginContext,
  createNoopHostApi,
  ensurePluginDataDir,
  resolveEntryPath,
  resolveRealEntryPath,
} from "./sandbox.js";
import type { LoadedPlugin, ManifestLoadPlan, ManifestSnapshot } from "./types.js";
import { createLogger } from "../../lib/logger.js";
const log = createLogger("plugin-runtime");

export type { InstallPolicy };
export { normalizeInstallPolicy, getDeclaredEmittedEvents };
export { resolveManifestLoadPlan, readEnabledManifestSnapshots };

// Re-export public interface types so callers that do
// `import { PluginCard, PluginPerfStats } from "./runtime/index.js"` work.
export type { ManifestLoadPlan, ManifestSnapshot };

/**
 * Phase 1.5 Option C — non-active plugin catalog card.
 */
export interface PluginCard {
  id: string;
  name: string;
  description: string;
  sampleTools: string[];
  /** All tool names declared in the manifest (filtered by toolRegistry visibility when provided). */
  tools: string[];
  /** Capability tags declared in manifest.capabilities. */
  capabilities: string[];
  /** tool name → description from manifest.toolSchemas */
  toolDescriptions?: Record<string, string>;
  /** true when the plugin is protected from ordinary user uninstall/disable */
  isManaged?: boolean;
  /** Install policy declared in the manifest: "admin" (IT-managed) or "user" (anyone). */
  installPolicy?: "admin" | "user";
  /** Runtime load status derived from loaded/failed/disabled runtime state. */
  loadStatus: "loaded" | "failed" | "disabled";
  version?: string;
  publisher?: string;
  configSchema?: PluginConfigSchema;
}

/**
 * Per-plugin performance statistics collected at runtime.
 */
export interface PluginPerfStats {
  startupMs: number;
  toolCallCount: number;
  errorCount: number;
  totalExecMs: number;
  lastCallAt: number | null;
}

export interface PluginRuntimeOptions {
  hostRoot: string;
  manifestPaths?: string[];
  registryPath?: string;
  pluginsRoot?: string;
  configOverrides?: Record<string, Record<string, unknown>>;
  /** Plugin-scoped HostApi factory — injected by boot.ts */
  createHostApi?: (pluginId: string, manifest: PluginManifest, pluginDataDir: string) => PluginHostApi;
  deploymentGuard?: PluginDeploymentGuard;
  installReceiptCacheRoot?: string;
  auditLog?: (level: "info" | "warn" | "error", message: string, data?: unknown) => void;
  onDisable?: (pluginId: string) => void;
}

export class PluginRuntime {
  private readonly hostRoot: string;
  private readonly manifestPaths: string[];
  private readonly registryPath?: string;
  private readonly pluginsRoot?: string;
  private configOverrides: Record<string, Record<string, unknown>>;
  private readonly createHostApi?: (pluginId: string, manifest: PluginManifest, pluginDataDir: string) => PluginHostApi;
  private readonly deploymentGuard?: PluginDeploymentGuard;
  private readonly installReceiptCacheRoot?: string;
  private readonly auditLog?: (level: "info" | "warn" | "error", message: string, data?: unknown) => void;
  private readonly onDisable?: (pluginId: string) => void;
  private readonly plugins = new Map<string, LoadedPlugin>();
  private readonly methodMap = new Map<string, { pluginId: string; handler: PluginToolHandler }>();
  private readonly perfStats = new Map<string, PluginPerfStats>();
  private readonly disposers = new Map<string, Array<() => void>>();
  private readonly knownPluginManifests = new Map<string, PluginManifest>();
  private readonly knownPluginAccessGrants = new Map<string, PluginAccessSpec | undefined>();
  private readonly knownToolOwners = new Map<string, string>();
  private readonly knownEventOwners = new Map<string, string>();
  private readonly failedPluginIds = new Set<string>();
  private readonly failedPluginStubs = new Map<string, { name: string; description: string }>();
  private readonly disabledPluginIds = new Set<string>();
  private loaded = false;
  /** Sprint 4-B §B-1 — lazily-compiled AJV validator for plugin.schema.json. */
  private manifestValidator: ValidateFunction | null = null;
  private manifestValidatorLoaded = false;

  constructor(options: PluginRuntimeOptions) {
    this.hostRoot = resolve(options.hostRoot);
    this.manifestPaths = (options.manifestPaths ?? []).map((path) => resolve(path));
    this.registryPath = options.registryPath ? resolve(options.registryPath) : undefined;
    this.pluginsRoot = options.pluginsRoot ? resolve(options.pluginsRoot) : undefined;
    this.configOverrides = options.configOverrides ?? {};
    this.createHostApi = options.createHostApi;
    this.deploymentGuard = options.deploymentGuard;
    this.installReceiptCacheRoot = options.installReceiptCacheRoot
      ? resolve(options.installReceiptCacheRoot)
      : undefined;
    this.auditLog = options.auditLog;
    this.onDisable = options.onDisable;
  }

  // ─── Manifest Validator (lazy) ─────────────────────────────────────────────

  private async getManifestValidator(): Promise<ValidateFunction | null> {
    if (this.manifestValidatorLoaded) return this.manifestValidator;
    this.manifestValidatorLoaded = true;
    this.manifestValidator = await buildManifestValidator(import.meta.url);
    return this.manifestValidator;
  }

  private async readManifest(path: string): Promise<PluginManifest> {
    const validator = await this.getManifestValidator();
    return parsePluginJson(path, validator);
  }

  // ─── Sandbox helpers (instance-context wrappers) ───────────────────────────

  private resolveEntryPathForPlugin(pluginRoot: string, entry: string): string {
    return resolveEntryPath(pluginRoot, entry, this.hostRoot);
  }

  private ensureDataDir(pluginId: string, pluginRoot: string): string {
    return ensurePluginDataDir(pluginId, pluginRoot, this.pluginsRoot);
  }

  private buildHostApi(pluginId: string, manifest: PluginManifest, pluginDataDir: string): PluginHostApi {
    const hostApi = this.createHostApi?.(pluginId, manifest, pluginDataDir) ?? createNoopHostApi(pluginId, pluginDataDir);
    // Defence-in-depth: PluginHostApi.storage is required but partial hostApi
    // objects from test harnesses may omit it.
    if (!hostApi.storage) {
      hostApi.storage = createPluginStorage(pluginId, pluginDataDir);
    }
    return hostApi;
  }

  // ─── Load Plan & Snapshots ─────────────────────────────────────────────────

  private async resolveManifestLoadPlanInternal(): Promise<ManifestLoadPlan[]> {
    return resolveManifestLoadPlan({
      manifestPaths: this.manifestPaths,
      registryPath: this.registryPath,
      pluginsRoot: this.pluginsRoot,
    });
  }

  private async readSnapshotsInternal(
    loadPlan: ManifestLoadPlan[],
  ): Promise<Map<string, ManifestSnapshot>> {
    const validator = await this.getManifestValidator();
    return readEnabledManifestSnapshots(loadPlan, validator);
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  async load(): Promise<void> {
    if (this.loaded) return;
    const loadPlan = await this.resolveManifestLoadPlanInternal();
    const enabledManifestSnapshots = await this.readSnapshotsInternal(loadPlan);
    for (const [pluginId, snapshot] of enabledManifestSnapshots) {
      const { manifest, approvedPluginAccess } = snapshot;
      this.knownPluginManifests.set(pluginId, manifest);
      this.knownPluginAccessGrants.set(pluginId, approvedPluginAccess);
      for (const toolName of manifest.tools ?? []) {
        this.knownToolOwners.set(toolName, pluginId);
      }
      for (const eventType of getDeclaredEmittedEvents(manifest)) {
        this.knownEventOwners.set(eventType, pluginId);
      }
    }
    for (const plan of loadPlan) {
      const manifestPath = plan.manifestPath;
      const pluginRoot = dirname(manifestPath);
      if (plan.pluginIdHint) {
        const skipReceiptForDevLink = plan.devLinked === true && devLinkedEntryAllowed();
        const integrityResult = await this.verifyReceiptAndDevGuard(
          plan.pluginIdHint,
          pluginRoot,
          skipReceiptForDevLink,
        );
        if (!integrityResult.ok) {
          this.markFailed(plan.pluginIdHint);
          continue;
        }
      }
      let manifest: PluginManifest;
      try {
        manifest = await this.readManifest(manifestPath);
      } catch (err) {
        log.error(`${(err as Error).message}`);
        if (plan.enabled && plan.pluginIdHint) {
          this.markFailed(plan.pluginIdHint, {
            name: plan.pluginIdHint,
            description: "Plugin manifest could not be loaded.",
          });
        }
        continue;
      }
      this.knownPluginManifests.set(manifest.id, manifest);
      this.failedPluginStubs.delete(manifest.id);
      if (!plan.enabled) {
        this.disabledPluginIds.add(manifest.id);
        this.failedPluginIds.delete(manifest.id);
        continue;
      }
      this.disabledPluginIds.delete(manifest.id);
      this.failedPluginIds.delete(manifest.id);
      const requiredCapabilities = manifest.requires?.capabilities ?? [];
      if (requiredCapabilities.length > 0) {
        const availableManifests = [...enabledManifestSnapshots.entries()]
          .filter(([pluginId]) => pluginId !== manifest.id)
          .map(([, candidate]) => candidate.manifest);
        const dependencyResult = resolveDependencies(requiredCapabilities, availableManifests);
        if (!dependencyResult.ok) {
          const reason = `missing required capabilities: ${dependencyResult.missing.join(", ")}`;
          log.error(`${manifest.id} rejected — ${reason}`);
          this.auditLog?.("error", "plugin_dependency_missing", {
            pluginId: manifest.id,
            missing: dependencyResult.missing,
          });
          this.markFailed(manifest.id, {
            name: manifest.name,
            description: `Missing capabilities: ${dependencyResult.missing.join(", ")}`,
          });
          continue;
        }
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
        continue;
      }
      const resolvedEntryPath = resolveRealEntryPath(entryPath);
      let module: { default?: RuntimePluginFactory; createPlugin?: RuntimePluginFactory };
      try {
        module = (await import(buildImportUrl(resolvedEntryPath))) as {
          default?: RuntimePluginFactory;
          createPlugin?: RuntimePluginFactory;
        };
      } catch (err) {
        log.error(`${manifest.id} import failed: %s`, (err as Error).message);
        this.auditLog?.("error", "plugin_import_failed", {
          pluginId: manifest.id,
          reason: (err as Error).message,
        });
        this.markFailed(manifest.id);
        continue;
      }
      const createPlugin = module.default ?? module.createPlugin;
      if (!createPlugin) {
        log.error(`${manifest.id} entry does not export default/createPlugin — skipped`);
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
      for (const toolName of manifest.tools) {
        const handler = instance.handlers[toolName];
        if (!handler) {
          log.warn({ pluginId: manifest.id, toolName }, `missing handler '${toolName}' — tool disabled`);
          continue;
        }
        methods.set(toolName, handler);
        if (this.methodMap.has(toolName)) {
          throw new Error(`Duplicate plugin method registered: ${toolName}`);
        }
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
        approvedPluginAccess: plan.approvedPluginAccess,
        devLinked: plan.devLinked,
      });
      this.failedPluginIds.delete(manifest.id);
      this.disabledPluginIds.delete(manifest.id);
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
        if (!this.perfStats.has(id)) {
          this.perfStats.set(id, { startupMs: 0, toolCallCount: 0, errorCount: 0, totalExecMs: 0, lastCallAt: null });
        }
        try {
          if (!plugin.instance.start) {
            this.perfStats.get(id)!.startupMs = Date.now() - startedAt;
            return;
          }
          const hardTimeoutMs = plugin.manifest.startupTimeoutMs;
          if (hardTimeoutMs && hardTimeoutMs > 0) {
            let timer: NodeJS.Timeout | undefined;
            const timeout = new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                reject(new Error(`startup timeout (>${hardTimeoutMs}ms)`));
              }, hardTimeoutMs);
            });
            try {
              await Promise.race([Promise.resolve(plugin.instance.start()), timeout]);
            } finally {
              if (timer) clearTimeout(timer);
            }
          } else {
            await plugin.instance.start();
          }
        } finally {
          clearTimeout(slowTimer);
        }
        const elapsed = Date.now() - startedAt;
        const stats = this.perfStats.get(id);
        if (stats) stats.startupMs = elapsed;
        if (elapsed > SLOW_THRESHOLD_MS) {
          log.warn(`slow plugin: ${id} finished in ${elapsed}ms`);
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
      log.error(`start failed (non-fatal): ${reason}`);
      const plugin = this.plugins.get(id);
      if (!plugin) continue;
      this.markFailed(id);
      for (const method of plugin.methods.keys()) {
        this.methodMap.delete(method);
      }
      this.plugins.delete(id);
    }
  }

  async stopAll(): Promise<void> {
    for (const plugin of this.plugins.values()) {
      await plugin.instance.stop?.();
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
  }

  /**
   * US-3c.2 — Targeted single-plugin restart.
   */
  async restartPlugin(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      log.warn(`restartPlugin: plugin not loaded — ${pluginId}`);
      return;
    }

    try {
      await plugin.instance.stop?.();
    } catch (err) {
      log.error(`stop during restartPlugin failed: %s`, (err as Error).message);
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

    const { pluginRoot } = plugin;
    const skipReceiptForDevLink = plugin.devLinked === true && devLinkedEntryAllowed();
    const integrityResult = await this.verifyReceiptAndDevGuard(pluginId, pluginRoot, skipReceiptForDevLink);
    if (!integrityResult.ok) {
      this.markFailed(pluginId);
      return;
    }
    let manifest: PluginManifest;
    try {
      const manifestPath = resolve(pluginRoot, "plugin.json");
      manifest = await this.readManifest(manifestPath);
    } catch (err) {
      log.error(`failed to read manifest during restartPlugin: %s`, (err as Error).message);
      this.markFailed(pluginId);
      return;
    }
    const entryPath = this.resolveEntryPathForPlugin(pluginRoot, manifest.entry);
    const resolvedEntryPath = resolveRealEntryPath(entryPath);
    const importUrl = buildImportUrl(resolvedEntryPath);

    let module: { default?: RuntimePluginFactory; createPlugin?: RuntimePluginFactory };
    try {
      module = (await import(importUrl)) as {
        default?: RuntimePluginFactory;
        createPlugin?: RuntimePluginFactory;
      };
    } catch (err) {
      log.error(`import failed during restartPlugin: %s`, (err as Error).message);
      this.markFailed(pluginId);
      return;
    }

    const createPlugin = module.default ?? module.createPlugin;
    if (!createPlugin) {
      log.error(`entry does not export default/createPlugin after restartPlugin`);
      this.markFailed(pluginId);
      return;
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
      log.error(`createPlugin failed during restartPlugin: %s`, (err as Error).message);
      this.markFailed(pluginId);
      return;
    }

    const methods = new Map<string, PluginToolHandler>();
    for (const toolName of manifest.tools) {
      const handler = instance.handlers[toolName];
      if (!handler) {
        log.warn(`missing handler '${toolName}' after restartPlugin — tool disabled`);
        continue;
      }
      methods.set(toolName, handler);
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
      approvedPluginAccess: this.knownPluginAccessGrants.get(pluginId),
    });
    this.failedPluginIds.delete(pluginId);
    this.disabledPluginIds.delete(pluginId);

    try {
      await instance.start?.();
    } catch (err) {
      log.error(`start after restartPlugin failed: %s`, (err as Error).message);
      this.markFailed(pluginId);
      for (const method of methods.keys()) {
        this.methodMap.delete(method);
      }
      this.plugins.delete(pluginId);
    }
  }

  setConfigOverride(pluginId: string, config: Record<string, unknown>): void {
    if (Object.keys(config).length === 0) {
      delete this.configOverrides[pluginId];
      return;
    }
    this.configOverrides[pluginId] = { ...config };
  }

  /**
   * US-A3 — Targeted single-plugin add for install / install-local paths.
   */
  async addPlugin(pluginId: string): Promise<void> {
    if (this.plugins.has(pluginId)) {
      await this.restartPlugin(pluginId);
      return;
    }

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
    this.knownPluginManifests.set(pluginId, manifest);
    this.knownPluginAccessGrants.set(pluginId, approvedPluginAccess);
    for (const toolName of manifest.tools ?? []) {
      this.knownToolOwners.set(toolName, pluginId);
    }
    for (const eventType of getDeclaredEmittedEvents(manifest)) {
      this.knownEventOwners.set(eventType, pluginId);
    }

    await this.instantiateAndStartSinglePlugin(targetPlan, manifest, approvedPluginAccess);
  }

  /**
   * US-A3 — Targeted single-plugin remove for uninstall paths.
   */
  async removePlugin(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      log.warn(`removePlugin: plugin not loaded — ${pluginId}`);
      return;
    }

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
    this.disabledPluginIds.delete(pluginId);

    this.onDisable?.(pluginId);
  }

  /** Helper: does a manifest path's directory name suggest it owns `pluginId`? */
  private matchesManifestPath(manifestPath: string, pluginId: string): boolean {
    const parent = dirname(manifestPath);
    const dirName = parent.split(/[\\/]/).pop() ?? "";
    return dirName === pluginId || dirName === pluginId.replace(/[^a-zA-Z0-9._-]/g, "-");
  }

  /**
   * Verify the install receipt for `pluginId` under `pluginRoot` and enforce
   * the dev-signer-in-packaged-build guard. Emits all relevant audit log
   * entries so callers cannot forget them.
   *
   * Returns `{ ok: true }` when verification passes (or is not required).
   * Returns `{ ok: false }` when the plugin must be rejected — the caller is
   * responsible for calling `markFailed` and deciding the control-flow
   * (`continue` vs `return`).
   *
   * Skips all checks when `installReceiptCacheRoot` is not configured or
   * when `skipForDevLink` is true (dev-linked entry in non-packaged build).
   */
  private async verifyReceiptAndDevGuard(
    pluginId: string,
    pluginRoot: string,
    skipForDevLink: boolean,
  ): Promise<{ ok: true } | { ok: false }> {
    if (!this.installReceiptCacheRoot || skipForDevLink) {
      return { ok: true };
    }
    const receiptResult = await verifyInstallReceipt(
      this.installReceiptCacheRoot,
      pluginId,
      pluginRoot,
    );
    if (!receiptResult.ok) {
      log.error({ pluginId, reason: receiptResult.reason }, `${pluginId} rejected — install receipt integrity failed`);
      this.auditLog?.("error", "plugin_integrity_rejected", {
        pluginId,
        reason: receiptResult.reason,
      });
      return { ok: false };
    }
    const { installSource, signerKeyId, artifactSha256 } = receiptResult.receipt;
    if (getIsPackaged() && installSource === "local-dev") {
      const reason = "local-dev install rejected in packaged build";
      log.error({ pluginId, reason }, `${pluginId} rejected — ${reason}`);
      this.auditLog?.("error", "plugin_integrity_rejected", { pluginId, reason });
      return { ok: false };
    }
    this.auditLog?.("info", "plugin_integrity_verified", {
      pluginId,
      installSource,
      artifactSha256,
      signerKeyId,
    });
    return { ok: true };
  }

  /**
   * Per-plugin instantiation + start. Extracted from `load()` + `startAll()`
   * so single-plugin install (`addPlugin`) can run the same path without a
   * full restart.
   */
  private async instantiateAndStartSinglePlugin(
    plan: ManifestLoadPlan,
    manifest: PluginManifest,
    approvedPluginAccess: PluginAccessSpec | undefined,
  ): Promise<void> {
    const pluginRoot = dirname(plan.manifestPath);
    if (plan.pluginIdHint) {
      const skipReceiptForDevLink = plan.devLinked === true && devLinkedEntryAllowed();
      const integrityResult = await this.verifyReceiptAndDevGuard(
        plan.pluginIdHint,
        pluginRoot,
        skipReceiptForDevLink,
      );
      if (!integrityResult.ok) {
        this.markFailed(plan.pluginIdHint);
        return;
      }
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
          name: manifest.name,
          description: `Missing capabilities: ${dependencyResult.missing.join(", ")}`,
        });
        return;
      }
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
      return;
    }
    const resolvedEntryPath = resolveRealEntryPath(entryPath);

    let module: { default?: RuntimePluginFactory; createPlugin?: RuntimePluginFactory };
    try {
      module = (await import(buildImportUrl(resolvedEntryPath))) as {
        default?: RuntimePluginFactory;
        createPlugin?: RuntimePluginFactory;
      };
    } catch (err) {
      log.error(`${manifest.id} import failed: %s`, (err as Error).message);
      this.auditLog?.("error", "plugin_import_failed", {
        pluginId: manifest.id,
        reason: (err as Error).message,
      });
      this.markFailed(manifest.id);
      return;
    }
    const createPlugin = module.default ?? module.createPlugin;
    if (!createPlugin) {
      log.error(`${manifest.id} entry does not export default/createPlugin — skipped`);
      this.markFailed(manifest.id);
      return;
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
      return;
    }

    const methods = new Map<string, PluginToolHandler>();
    for (const toolName of manifest.tools) {
      const handler = instance.handlers[toolName];
      if (!handler) {
        log.warn(`missing handler '${toolName}' — tool disabled`);
        continue;
      }
      methods.set(toolName, handler);
      if (this.methodMap.has(toolName)) {
        throw new Error(`Duplicate plugin method registered: ${toolName}`);
      }
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
    });
    this.failedPluginIds.delete(manifest.id);
    this.disabledPluginIds.delete(manifest.id);

    if (!this.perfStats.has(manifest.id)) {
      this.perfStats.set(manifest.id, { startupMs: 0, toolCallCount: 0, errorCount: 0, totalExecMs: 0, lastCallAt: null });
    }

    if (instance.start) {
      const startedAt = Date.now();
      try {
        const hardTimeoutMs = manifest.startupTimeoutMs;
        if (hardTimeoutMs && hardTimeoutMs > 0) {
          let timer: NodeJS.Timeout | undefined;
          const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`startup timeout (>${hardTimeoutMs}ms)`)), hardTimeoutMs);
          });
          try {
            await Promise.race([Promise.resolve(instance.start()), timeout]);
          } finally {
            if (timer) clearTimeout(timer);
          }
        } else {
          await instance.start();
        }
        this.perfStats.get(manifest.id)!.startupMs = Date.now() - startedAt;
      } catch (err) {
        log.error(`start during addPlugin failed: %s`, (err as Error).message);
        this.markFailed(manifest.id);
        for (const method of methods.keys()) {
          this.methodMap.delete(method);
        }
        this.plugins.delete(manifest.id);
      }
    }
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

    for (const method of plugin.methods.keys()) {
      this.methodMap.delete(method);
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
    const importUrl = buildImportUrl(resolvedEntryPath, true); // cache-bust for dev reload
    const module = (await import(importUrl)) as {
      default?: RuntimePluginFactory;
      createPlugin?: RuntimePluginFactory;
    };
    const createPlugin = module.default ?? module.createPlugin;
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

    const methods = new Map<string, PluginToolHandler>();
    for (const toolName of manifest.tools) {
      const handler = instance.handlers[toolName];
      if (!handler) {
        log.warn(`missing handler '${toolName}' after reload — tool disabled`);
        continue;
      }
      methods.set(toolName, handler);
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
    });

    try {
      await instance.start?.();
    } catch (err) {
      log.error(`start after reload failed: %s`, (err as Error).message);
      throw err;
    }
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

    if (this.registryPath) {
      await updatePluginRegistry(this.registryPath, (registry) => {
        const entry = registry.plugins.find((p) => p.id === pluginId);
        if (entry) {
          entry.enabled = false;
        }
      });
    }

    this.onDisable?.(pluginId);
  }

  // ─── Dispatcher / Bridge ───────────────────────────────────────────────────

  async call(method: string, payload?: unknown): Promise<unknown> {
    const entry = this.methodMap.get(method);
    if (!entry) {
      throw new Error(`Plugin method not found: ${method}`);
    }
    const { pluginId } = entry;
    let stats = this.perfStats.get(pluginId);
    if (!stats) {
      stats = { startupMs: 0, toolCallCount: 0, errorCount: 0, totalExecMs: 0, lastCallAt: null };
      this.perfStats.set(pluginId, stats);
    }
    stats.toolCallCount += 1;
    stats.lastCallAt = Date.now();
    const t0 = Date.now();
    try {
      return await entry.handler(payload);
    } catch (err) {
      stats.errorCount += 1;
      throw err;
    } finally {
      stats.totalExecMs += Date.now() - t0;
    }
  }

  resolveToolOwner(method: string): string | undefined {
    return this.methodMap.get(method)?.pluginId ?? this.knownToolOwners.get(method);
  }

  assertPluginToolAccess(callerPluginId: string, method: string): void {
    const targetPluginId = this.resolveToolOwner(method);
    if (!targetPluginId || targetPluginId === callerPluginId) return;
    const rule = this.getPluginAccessGrant(callerPluginId)?.plugins.find((entry) => entry.pluginId === targetPluginId);
    if (rule?.tools?.includes(method)) return;
    this.auditLog?.("error", "plugin_tool_access_denied", {
      callerPluginId,
      targetPluginId,
      method,
    });
    throw new Error(
      `Plugin '${callerPluginId}' is not allowed to call tool '${method}' on plugin '${targetPluginId}'`,
    );
  }

  assertPluginEventAccess(callerPluginId: string, eventType: string): void {
    const targetPluginId = this.inferEventOwner(eventType);
    if (!targetPluginId || targetPluginId === callerPluginId) return;
    const rule = this.getPluginAccessGrant(callerPluginId)?.plugins.find((entry) => entry.pluginId === targetPluginId);
    if (rule?.events?.includes(eventType)) return;
    this.auditLog?.("error", "plugin_event_access_denied", {
      callerPluginId,
      targetPluginId,
      eventType,
    });
    throw new Error(
      `Plugin '${callerPluginId}' is not allowed to subscribe to event '${eventType}' from plugin '${targetPluginId}'`,
    );
  }

  assertPluginEventEmitAccess(callerPluginId: string, eventType: string): void {
    const ownerPluginId = this.inferEventOwner(eventType);
    if (!ownerPluginId || ownerPluginId === callerPluginId) return;
    this.auditLog?.("error", "plugin_event_emit_denied", {
      callerPluginId,
      ownerPluginId,
      eventType,
    });
    throw new Error(
      `Plugin '${callerPluginId}' is not allowed to emit event '${eventType}' owned by plugin '${ownerPluginId}'`,
    );
  }

  /**
   * H2: Renderer-originated plugin invocation.
   */
  async callFromUi(method: string, payload?: unknown): Promise<unknown> {
    const entry = this.methodMap.get(method);
    if (!entry) {
      throw new Error(`Plugin method not found: ${method}`);
    }
    const plugin = this.plugins.get(entry.pluginId);
    const uiCallable = plugin?.manifest.uiCallable ?? [];
    if (!uiCallable.includes(method)) {
      throw new Error(
        `Method '${method}' is not UI-callable for plugin '${entry.pluginId}'. ` +
        `Declare it in manifest.uiCallable[] to allow renderer invocation.`,
      );
    }
    return entry.handler(payload);
  }

  getMethodMap(): ReadonlyMap<string, { pluginId: string; handler: PluginToolHandler }> {
    return this.methodMap;
  }

  // ─── Queries ───────────────────────────────────────────────────────────────

  getPerfStats(): Record<string, PluginPerfStats> {
    const result: Record<string, PluginPerfStats> = {};
    for (const [id, stats] of this.perfStats) {
      result[id] = { ...stats };
    }
    return result;
  }

  /**
   * Test-only: inject a plugin + method handler directly into the runtime's
   * internal maps without going through the full load/start lifecycle.
   *
   * Populates `plugins`, `methodMap`, and `perfStats` so that `call()`,
   * `getPerfStats()`, and related queries work without disk fixtures.
   *
   * @internal Only call from test files. The leading underscore signals
   *   test-only usage; tree-shaking removes it from production bundles.
   */
  _testInjectPlugin(
    pluginId: string,
    toolName: string,
    handler: (payload?: unknown) => Promise<unknown>,
  ): void {
    const stub: LoadedPlugin = {
      manifest: {
        id: pluginId,
        name: pluginId,
        version: "1.0.0",
        entry: "index.js",
        description: "Test fixture",
        publisher: "Test fixture",
        tools: [toolName],
      },
      pluginRoot: "/tmp/test-inject",
      instance: {} as import("../types.js").RuntimePlugin,
      methods: new Map([[toolName, handler as import("../types.js").PluginToolHandler]]),
    };
    this.plugins.set(pluginId, stub);
    this.methodMap.set(toolName, { pluginId, handler: handler as import("../types.js").PluginToolHandler });
    if (!this.perfStats.has(pluginId)) {
      this.perfStats.set(pluginId, {
        startupMs: 0,
        toolCallCount: 0,
        errorCount: 0,
        totalExecMs: 0,
        lastCallAt: null,
      });
    }
  }

  registerDisposer(pluginId: string, dispose: () => void): void {
    let list = this.disposers.get(pluginId);
    if (!list) {
      list = [];
      this.disposers.set(pluginId, list);
    }
    list.push(dispose);
  }

  listToolNames(): string[] {
    return [...this.methodMap.keys()].sort();
  }

  listPluginIds(): string[] {
    return [...this.plugins.keys()];
  }

  getPluginManifest(pluginId: string): PluginManifest | undefined {
    return this.plugins.get(pluginId)?.manifest ?? this.knownPluginManifests.get(pluginId);
  }

  private getPluginAccessGrant(pluginId: string): PluginAccessSpec | undefined {
    return this.plugins.get(pluginId)?.approvedPluginAccess ?? this.knownPluginAccessGrants.get(pluginId);
  }

  listPluginCards(toolRegistry?: { getVisibleTools(): Array<{ name: string }> }): PluginCard[] {
    const visibleNames = toolRegistry
      ? new Set(toolRegistry.getVisibleTools().map((t) => t.name))
      : null;
    const cards = new Map<string, PluginCard>();
    for (const [pluginId, manifest] of this.knownPluginManifests) {
      const loadStatus = this.plugins.has(pluginId)
        ? "loaded"
        : this.failedPluginIds.has(pluginId)
          ? "failed"
          : this.disabledPluginIds.has(pluginId)
            ? "disabled"
            : null;
      if (!loadStatus) continue;
      cards.set(pluginId, this.buildPluginCard(pluginId, manifest, loadStatus, visibleNames));
    }
    for (const [pluginId, stub] of this.failedPluginStubs) {
      if (cards.has(pluginId)) continue;
      cards.set(pluginId, {
        id: pluginId,
        name: stub.name,
        description: stub.description,
        sampleTools: [],
        tools: [],
        capabilities: [],
        loadStatus: "failed",
      });
    }
    return [...cards.values()];
  }

  listPluginManifests(): Array<{ pluginId: string; manifest: PluginManifest }> {
    const result: Array<{ pluginId: string; manifest: PluginManifest }> = [];
    for (const [pluginId, plugin] of this.plugins) {
      result.push({ pluginId, manifest: plugin.manifest });
    }
    return result;
  }

  findPluginIdByCapability(capability: string): string | undefined {
    const matches = this.listPluginIdsByCapability(capability);
    if (matches.length > 1) {
      log.warn(
        `Multiple plugins declare capability '${capability}': ${matches.join(", ")}. ` +
        `Using '${matches[0]}'. Ensure only one plugin provides this capability.`,
      );
    }
    return matches[0];
  }

  listPluginIdsByCapability(capability: string): string[] {
    const result: string[] = [];
    for (const [pluginId, plugin] of this.plugins) {
      if (plugin.manifest.capabilities?.includes(capability)) {
        result.push(pluginId);
      }
    }
    return result;
  }

  getPluginInstance<T = unknown>(pluginId: string): T | undefined {
    return this.plugins.get(pluginId)?.instance as T | undefined;
  }

  getPluginEntryDir(pluginId: string): string | undefined {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return undefined;
    try {
      const entryPath = this.resolveEntryPathForPlugin(plugin.pluginRoot, plugin.manifest.entry);
      return dirname(entryPath);
    } catch {
      return undefined;
    }
  }

  getPluginRoot(pluginId: string): string | undefined {
    return this.plugins.get(pluginId)?.pluginRoot;
  }

  listUiExtensions(): Array<{ pluginId: string; extension: PluginUiExtension; entryUrl?: string }> {
    const result: Array<{ pluginId: string; extension: PluginUiExtension; entryUrl?: string }> = [];
    for (const [pluginId, plugin] of this.plugins) {
      for (const extension of plugin.manifest.ui ?? []) {
        const entrySource = extension.entry ?? extension.page;
        let entryPath: string | undefined;
        if (entrySource) {
          try {
            entryPath = this.resolveEntryPathForPlugin(plugin.pluginRoot, entrySource);
          } catch (err) {
            log.warn(
              `ui entry rejected for '${pluginId}': ${(err as Error).message}`,
            );
            this.auditLog?.("error", "plugin_ui_entry_path_rejected", {
              pluginId,
              entry: entrySource,
              reason: (err as Error).message,
            });
            continue;
          }
        }
        result.push({
          pluginId,
          extension,
          entryUrl: entryPath ? buildImportUrl(entryPath) : undefined,
        });
      }
    }
    return result;
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private resetLoadedState(): void {
    for (const [pluginId, list] of this.disposers) {
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
    this.methodMap.clear();
    this.failedPluginIds.clear();
    this.failedPluginStubs.clear();
    this.disabledPluginIds.clear();
    this.loaded = false;
  }

  private markFailed(
    pluginId: string,
    stub?: { name: string; description: string },
  ): void {
    this.failedPluginIds.add(pluginId);
    this.disabledPluginIds.delete(pluginId);
    if (stub) {
      this.failedPluginStubs.set(pluginId, stub);
    }
  }

  private buildPluginCard(
    pluginId: string,
    manifest: PluginManifest,
    loadStatus: PluginCard["loadStatus"],
    visibleNames: Set<string> | null,
  ): PluginCard {
    const allTools = manifest.tools ?? [];
    const filteredTools = visibleNames
      ? allTools.filter((t) => visibleNames.has(t))
      : allTools;
    const sampleTools = filteredTools.slice(0, 3);
    let description: string;
    if (manifest.description) {
      description = manifest.description;
    } else {
      const schemas = manifest.toolSchemas;
      if (schemas) {
        const parts: string[] = [];
        for (const toolName of sampleTools) {
          const desc = schemas[toolName]?.description;
          if (desc) parts.push(desc);
        }
        description = parts.length > 0 ? parts.join(" / ") : `Plugin: ${manifest.name}`;
      } else {
        description = `Plugin: ${manifest.name}`;
      }
    }
    const toolDescriptions: Record<string, string> = {};
    if (manifest.toolSchemas) {
      for (const toolName of filteredTools) {
        const desc = manifest.toolSchemas[toolName]?.description;
        if (desc) toolDescriptions[toolName] = desc;
      }
    }
    return {
      id: pluginId,
      name: manifest.name,
      description,
      sampleTools,
      tools: filteredTools,
      capabilities: manifest.capabilities ?? [],
      toolDescriptions: Object.keys(toolDescriptions).length > 0 ? toolDescriptions : undefined,
      isManaged: normalizeInstallPolicy(manifest) === "admin",
      installPolicy: manifest.installPolicy ?? "user",
      loadStatus,
      version: manifest.version,
      publisher: manifest.publisher,
      configSchema: manifest.configSchema,
    };
  }

  private inferEventOwner(eventType: string): string | undefined {
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
