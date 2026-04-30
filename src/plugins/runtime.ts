import { readFile } from "node:fs/promises";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
// ajv + ajv-formats ship a CJS default export; ESM interop requires the
// `.default ?? module` dance below. We keep the raw namespace import here so
// the runtime resolves the default robustly across bundlers.
import * as AjvModule from "ajv";
import * as AddFormatsModule from "ajv-formats";
import type { ValidateFunction } from "ajv";
import type {
  InstallPolicy,
  PluginAccessSpec,
  PluginManifest,
  PluginToolHandler,
  PluginUiExtension,
  PluginHostApi,
  RuntimePlugin,
  RuntimePluginFactory,
} from "./types.js";
import { readPluginRegistry, updatePluginRegistry } from "./registry.js";
import { createPluginStorage } from "./storage.js";
import type { Actor, PluginDeploymentGuard } from "./deployment-guard.js";
import { resolveDependencies } from "./dependency-resolver.js";
import { devLinkedEntryAllowed } from "../boot/dev-flags.js";
import { verifyInstallReceipt } from "./plugin-install-receipt.js";

/**
 * M1 — uiCallable safety: inverted model.
 *
 * Rather than maintain a blocklist of destructive verbs (which grows stale
 * whenever a plugin invents a new mutating verb like `_revoke`, `_truncate`,
 * `_wipe`), the renderer→plugin IPC path is gated by an ALLOWLIST of
 * read-like verbs. Anything that is not clearly a read (_get, _list,
 * _search, _read, _show, _query, _preview, _count, _status, _find,
 * _describe, _inspect) is treated as mutating and can only be exposed via
 * uiCallable when the plugin is managed AND signed.
 *
 * Legacy blocklist export retained for backwards-compat (tests may import).
 */
/**
 * Resolve a plugin's manifest `entry` path relative to the plugin root.
 *
 * Security: rejects absolute paths and any relative path that escapes the
 * plugin directory via `..` traversal. Without this guard a hostile
 * `manifest.entry` (e.g. `"../../../etc/passwd.js"`) could cause the host to
 * `import()` an arbitrary file on disk.
 *
 * Implementation note: we use `path.relative()` + an `isAbsolute` / `..` check
 * rather than a string-prefix comparison so the check works on Windows
 * (where `path.resolve()` returns backslash-separated paths) as well as POSIX.
 *
 * Exported for unit testing.
 */
export function resolvePluginEntryPath(pluginRoot: string, entry: string): string {
  if (isAbsolute(entry)) {
    throw new Error(
      `Plugin entry must be a relative path inside the plugin directory, got absolute: ${entry}`,
    );
  }
  const pluginRootResolved = resolve(pluginRoot);
  const resolved = resolve(pluginRootResolved, entry);
  if (resolved !== pluginRootResolved) {
    const rel = relative(pluginRootResolved, resolved);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(
        `Plugin entry '${entry}' resolves outside plugin directory (${pluginRootResolved})`,
      );
    }
  }
  return resolved;
}

type LoadedPlugin = {
  manifest: PluginManifest;
  pluginRoot: string;
  instance: RuntimePlugin;
  methods: Map<string, PluginToolHandler>;
  approvedPluginAccess?: PluginAccessSpec;
};

type ManifestLoadPlan = {
  pluginIdHint?: string;
  manifestPath: string;
  enabled: boolean;
  approvedPluginAccess?: PluginAccessSpec;
  devLinked?: boolean;
};

function normalizeInstallPolicy(
  source: Partial<Pick<PluginManifest, "installPolicy">> | undefined,
): InstallPolicy {
  if (source?.installPolicy === "admin") {
    return "admin";
  }
  return "user";
}

function getDeclaredEmittedEvents(manifest: PluginManifest): string[] {
  const declared = Array.isArray(manifest.emittedEvents) ? manifest.emittedEvents : [];
  const legacyRaw = (manifest as unknown as { eventPublishes?: unknown }).eventPublishes;
  const legacy = Array.isArray(legacyRaw)
    ? legacyRaw.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
  return [...new Set([...declared, ...legacy])];
}

/**
 * Phase 1.5 Option C — 비활성 plugin 카탈로그 카드.
 * SystemPromptBuilder가 "사용 가능한 플러그인 (비활성)" 섹션 렌더링,
 * request_plugin 메타 툴이 허용 가능한 pluginId 목록 산출에 사용.
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
  /** Runtime load status derived from loaded/failed/disabled runtime state. */
  loadStatus: "loaded" | "failed" | "disabled";
  version?: string;
  publisher?: string;
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
  /**
   * Trust root for registry-recorded manifest paths.
   *
   * Anchored at `~/.lvis/plugins/` (resolved by `resolvePluginPaths`), so
   * production callers always supply this. A registry entry is trusted iff
   * its `realpathSync()` is contained under `realpathSync(this)`.
   *
   * Optional only because some unit tests construct PluginRuntime with a
   * `manifestPaths`-only seed that never touches `registryPath`.
   */
  pluginsRoot?: string;
  configOverrides?: Record<string, Record<string, unknown>>;
  /** 플러그인별 HostApi를 생성하는 팩토리 — boot.ts에서 주입 */
  createHostApi?: (pluginId: string, manifest: PluginManifest, pluginDataDir: string) => PluginHostApi;
  /** Phase 1.5 §7.3: disable 시 managed 플러그인 차단 */
  deploymentGuard?: PluginDeploymentGuard;
  /**
   * Cache root containing marketplace install receipts. When provided, every
   * registry-loaded plugin must match the receipt written by the verified
   * marketplace install gate before its manifest is parsed or entry imported.
   */
  installReceiptCacheRoot?: string;
  /** Optional sink for trust and runtime audit events. */
  auditLog?: (level: "info" | "warn" | "error", message: string, data?: unknown) => void;
  /**
   * HIGH-1: plugin disable 시 호출되는 콜백.
   * keywordEngine.unregisterByPlugin / toolRegistry.unregisterByPlugin /
   * conversationLoop.onPluginDisabled 을 boot.ts에서 주입한다.
   */
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
  /**
   * Per-plugin disposers (e.g. event subscriptions). Invoked in order on
   * disable() so host-side state scrubbing is deterministic.
   */
  private readonly disposers = new Map<string, Array<() => void>>();
  private readonly knownPluginManifests = new Map<string, PluginManifest>();
  private readonly knownPluginAccessGrants = new Map<string, PluginAccessSpec | undefined>();
  private readonly knownToolOwners = new Map<string, string>();
  private readonly knownEventOwners = new Map<string, string>();
  /** Plugins whose import/load failed — surfaced to Settings UI as status="failed". */
  private readonly failedPluginIds = new Set<string>();
  private readonly failedPluginStubs = new Map<string, { name: string; description: string }>();
  private readonly disabledPluginIds = new Set<string>();
  private loaded = false;
  /** Sprint 4-B §B-1 — lazily-compiled AJV validator for plugin.schema.json. */
  private manifestValidator: ValidateFunction | null = null;

  constructor(options: PluginRuntimeOptions) {
    this.hostRoot = resolve(options.hostRoot);
    this.manifestPaths = (options.manifestPaths ?? []).map((path) => resolve(path));
    this.registryPath = options.registryPath ? resolve(options.registryPath) : undefined;
    this.pluginsRoot = options.pluginsRoot
      ? resolve(options.pluginsRoot)
      : undefined;
    this.configOverrides = options.configOverrides ?? {};
    this.createHostApi = options.createHostApi;
    this.deploymentGuard = options.deploymentGuard;
    this.installReceiptCacheRoot = options.installReceiptCacheRoot
      ? resolve(options.installReceiptCacheRoot)
      : undefined;
    this.auditLog = options.auditLog;
    this.onDisable = options.onDisable;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    const loadPlan = await this.resolveManifestLoadPlan();
    const enabledManifestSnapshots = await this.readEnabledManifestSnapshots(loadPlan);
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
      // dev-linked plugins bypass the receipt check only when
      // `devLinkedEntryAllowed()` is true (`!isPackaged && LVIS_DEV=1`).
      // Packaged builds always enforce integrity even if a tampered registry
      // sets `_devLinked: true`, since `devLinkedEntryAllowed()` returns false.
      const skipReceiptForDevLink = plan.devLinked === true && devLinkedEntryAllowed();
      if (this.installReceiptCacheRoot && plan.pluginIdHint && !skipReceiptForDevLink) {
        const receiptResult = await verifyInstallReceipt(
          this.installReceiptCacheRoot,
          plan.pluginIdHint,
          pluginRoot,
        );
        if (!receiptResult.ok) {
          console.error(
            `[plugin-runtime] ${plan.pluginIdHint} rejected — install receipt integrity failed: ${receiptResult.reason}`,
          );
          this.auditLog?.("error", "plugin_integrity_rejected", {
            pluginId: plan.pluginIdHint,
            reason: receiptResult.reason,
          });
          this.markFailed(plan.pluginIdHint);
          continue;
        }
        this.auditLog?.("info", "plugin_integrity_verified", {
          pluginId: plan.pluginIdHint,
          artifactSha256: receiptResult.receipt.artifactSha256,
          signerKeyId: receiptResult.receipt.signerKeyId,
        });
      }
      let manifest: PluginManifest;
      try {
        manifest = await this.readManifest(manifestPath);
      } catch (err) {
        // Sprint 1-A A4: fail-soft drop on manifest validation — other
        // plugins keep loading. Error message already contains pluginId,
        // field path, reason, and an example.
        console.error(`[plugin-runtime] ${(err as Error).message}`);
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
          console.error(`[plugin-runtime] ${manifest.id} rejected — ${reason}`);
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
        entryPath = this.resolveEntryPath(pluginRoot, manifest.entry);
      } catch (err) {
        // Bonus security hardening: reject + audit manifests whose entry
        // escapes the plugin directory. Plugin is dropped fail-soft.
        const reason = (err as Error).message;
        console.error(`[plugin-runtime] ${manifest.id} rejected: ${reason}`);
        this.auditLog?.("error", "plugin_entry_path_rejected", {
          pluginId: manifest.id,
          entry: manifest.entry,
          reason,
        });
        this.markFailed(manifest.id);
        continue;
      }
      // Defense-in-depth: resolve any symlinks / 8.3 short-names (Windows) before
      // constructing the file:// URL. Fall back to the original path if realpathSync
      // fails (e.g., entry file doesn't exist yet — import() will error gracefully).
      let resolvedEntryPath: string;
      try {
        resolvedEntryPath = realpathSync(entryPath);
      } catch {
        resolvedEntryPath = entryPath;
      }
      let module: { default?: RuntimePluginFactory; createPlugin?: RuntimePluginFactory };
      try {
        module = (await import(pathToFileURL(resolvedEntryPath).href)) as {
          default?: RuntimePluginFactory;
          createPlugin?: RuntimePluginFactory;
        };
      } catch (err) {
        // Fail-soft: per-plugin import failures (missing deps, syntax errors,
        // electron-only imports, etc.) must NOT crash boot. The plugin is
        // dropped + marked failed so the Settings UI can surface the reason,
        // while other plugins continue loading.
        console.error(`[plugin-runtime] ${manifest.id} import failed:`, (err as Error).message);
        this.auditLog?.("error", "plugin_import_failed", {
          pluginId: manifest.id,
          reason: (err as Error).message,
        });
        this.markFailed(manifest.id);
        continue;
      }
      const createPlugin = module.default ?? module.createPlugin;
      if (!createPlugin) {
        console.error(`[plugin-runtime] ${manifest.id} entry does not export default/createPlugin — skipped`);
        this.markFailed(manifest.id);
        continue;
      }

      // 플러그인별 스코프된 HostApi 생성
      const pluginDataDir = this.ensurePluginDataDir(manifest.id, pluginRoot);
      const hostApi = this.createHostApi?.(manifest.id, manifest, pluginDataDir) ?? createNoopHostApi(manifest.id, pluginDataDir);
      // Defence-in-depth: PluginHostApi.storage is required, but partial
      // hostApi objects from test harnesses / external callers may omit it.
      // Fall back to the sandboxed storage rooted at pluginDataDir so plugins
      // never see `undefined` here.
      if (!hostApi.storage) {
        hostApi.storage = createPluginStorage(manifest.id, pluginDataDir);
      }

      const instance = await createPlugin({
        pluginId: manifest.id,
        pluginRoot,
        hostRoot: this.hostRoot,
        pluginDataDir,
        config: {
          ...(manifest.config ?? {}),
          ...(this.configOverrides["*"] ?? {}),       // 와일드카드: 모든 플러그인에 적용
          ...(this.configOverrides[manifest.id] ?? {}), // 플러그인별 오버라이드
        },
        log: (message, meta) => {
          if (meta !== undefined) {
            console.log(`[plugin:${manifest.id}] ${message}`, meta);
            return;
          }
          console.log(`[plugin:${manifest.id}] ${message}`);
        },
        hostApi,
      });

      const methods = new Map<string, PluginToolHandler>();
      for (const toolName of manifest.tools) {
        const handler = instance.handlers[toolName];
        if (!handler) {
          // Fail-soft: skip this tool but keep the plugin loaded so its other
          // tools stay usable. Silent full-plugin drop misleads users into
          // thinking the whole plugin is broken.
          console.warn(`[plugin:${manifest.id}] missing handler '${toolName}' — tool disabled`);
          continue;
        }
        methods.set(toolName, handler);
        if (this.methodMap.has(toolName)) {
          throw new Error(`Duplicate plugin method registered: ${toolName}`);
        }
        this.methodMap.set(toolName, { pluginId: manifest.id, handler });
      }

      // 매니페스트에 선언된 키워드 자동 등록
      if (manifest.keywords && manifest.keywords.length > 0) {
        hostApi.registerKeywords(manifest.keywords);
      }

      this.plugins.set(manifest.id, {
        manifest,
        pluginRoot,
        instance,
        methods,
        approvedPluginAccess: plan.approvedPluginAccess,
      });
      this.failedPluginIds.delete(manifest.id);
      this.disabledPluginIds.delete(manifest.id);
    }
    this.loaded = true;
  }

  async startAll(): Promise<void> {
    await this.load();
    // Sprint 1-A A1 — parallel start with slow-plugin warning and optional
    // hard timeout. handler Map is already registered in load() so method
    // availability is not gated by slow starts.
    const SLOW_THRESHOLD_MS = 5000;
    const failed: Array<{ id: string; reason: string }> = [];

    const tasks = [...this.plugins.values()].map((plugin) => {
      const { id } = plugin.manifest;
      const startedAt = Date.now();
      const slowTimer = setTimeout(() => {
        console.warn(`[plugin-runtime] slow plugin: ${id} (>${SLOW_THRESHOLD_MS}ms)`);
      }, SLOW_THRESHOLD_MS);

      const startPromise = (async () => {
        // Initialize perf stats entry before start attempt.
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
            // Promise.race enforces the timeout. The underlying start() is NOT
            // cancelled — no AbortController is wired through; the host simply
            // drops the plugin fail-soft once the timer rejects. Adding an
            // AbortSignal would require a PluginRuntimeContext change.
            let timer: NodeJS.Timeout | undefined;
            const timeout = new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                reject(new Error(`startup timeout (>${hardTimeoutMs}ms)`));
              }, hardTimeoutMs);
            });
            try {
              await Promise.race([
                Promise.resolve(plugin.instance.start()),
                timeout,
              ]);
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
        // Record startup duration in perf stats.
        const stats = this.perfStats.get(id);
        if (stats) stats.startupMs = elapsed;
        if (elapsed > SLOW_THRESHOLD_MS) {
          console.warn(`[plugin-runtime] slow plugin: ${id} finished in ${elapsed}ms`);
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
      console.error(`[plugin:${id}] start failed (non-fatal): ${reason}`);
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

  setConfigOverride(pluginId: string, config: Record<string, unknown>): void {
    if (Object.keys(config).length === 0) {
      delete this.configOverrides[pluginId];
      return;
    }
    this.configOverrides[pluginId] = { ...config };
  }

  /**
   * I2 — Plugin live-reload (dev only).
   *
   * Safely tears down a single loaded plugin (stop → scrub methods/disposers →
   * fire onDisable hook so host-side state is cleaned) and re-invokes its
   * createPlugin factory with a cache-busted `import()` URL so the fresh
   * `dist/` bundle is picked up without restarting the Electron process.
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
      console.error(`[plugin:${pluginId}] stop during reload failed:`, (err as Error).message);
    }

    for (const method of plugin.methods.keys()) {
      this.methodMap.delete(method);
    }
    this.plugins.delete(pluginId);
    const pluginDisposers = this.disposers.get(pluginId);
    if (pluginDisposers) {
      for (const d of pluginDisposers) {
        try { d(); } catch (err) {
          console.error(`[plugin:${pluginId}] disposer failed during reload:`, (err as Error).message);
        }
      }
      this.disposers.delete(pluginId);
    }

    this.onDisable?.(pluginId);

    const entryPath = this.resolveEntryPath(pluginRoot, manifest.entry);
    // Resolve 8.3 short-names / symlinks (Windows) before constructing the file:// URL.
    // Fall back to the raw path if realpathSync throws (entry doesn't exist yet).
    let resolvedEntryPath: string;
    try {
      resolvedEntryPath = realpathSync(entryPath);
    } catch {
      resolvedEntryPath = entryPath;
    }
    const importUrl = `${pathToFileURL(resolvedEntryPath).href}?reload=${Date.now()}`;
    const module = (await import(importUrl)) as {
      default?: RuntimePluginFactory;
      createPlugin?: RuntimePluginFactory;
    };
    const createPlugin = module.default ?? module.createPlugin;
    if (!createPlugin) {
      throw new Error(`Plugin entry does not export default/createPlugin: ${pluginId}`);
    }

    const pluginDataDir = this.ensurePluginDataDir(pluginId, pluginRoot);
    const hostApi = this.createHostApi?.(pluginId, manifest, pluginDataDir) ?? createNoopHostApi(pluginId, pluginDataDir);
    // Defence-in-depth: ensure storage is wired even if a partial hostApi was
    // returned (test harnesses, embedders). See loadAll() for rationale.
    if (!hostApi.storage) {
      hostApi.storage = createPluginStorage(pluginId, pluginDataDir);
    }
    const instance = await createPlugin({
      pluginId,
      pluginRoot,
      hostRoot: this.hostRoot,
      pluginDataDir,
      config: {
        ...(manifest.config ?? {}),
        ...(this.configOverrides["*"] ?? {}),
        ...(this.configOverrides[pluginId] ?? {}),
      },
      log: (message, meta) => {
        if (meta !== undefined) {
          console.log(`[plugin:${pluginId}] ${message}`, meta);
          return;
        }
        console.log(`[plugin:${pluginId}] ${message}`);
      },
      hostApi,
    });

    const methods = new Map<string, PluginToolHandler>();
    for (const toolName of manifest.tools) {
      const handler = instance.handlers[toolName];
      if (!handler) {
        console.warn(`[plugin:${pluginId}] missing handler '${toolName}' after reload — tool disabled`);
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
      console.error(`[plugin:${pluginId}] start after reload failed:`, (err as Error).message);
      throw err;
    }
  }

  /**
   * Disable a loaded plugin at runtime — stops the instance, removes its method
   * handlers, and marks enabled=false in registry.json.
   *
   * §7.2 / §7.3: 기본 actor는 "user". managed 플러그인은 guard가 차단.
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
      console.error(`[plugin:${pluginId}] stop during disable failed:`, (err as Error).message);
    }

    for (const method of plugin.methods.keys()) {
      this.methodMap.delete(method);
    }
    this.plugins.delete(pluginId);

    // Flush per-plugin disposers (event handlers etc.) before notifying host.
    const pluginDisposers = this.disposers.get(pluginId);
    if (pluginDisposers) {
      for (const d of pluginDisposers) {
        try { d(); } catch (err) {
          console.error(`[plugin:${pluginId}] disposer failed:`, (err as Error).message);
        }
      }
      this.disposers.delete(pluginId);
    }
    this.disabledPluginIds.add(pluginId);
    this.failedPluginIds.delete(pluginId);

    if (this.registryPath) {
      // §M1 F-round: atomic update under registry lock.
      await updatePluginRegistry(this.registryPath, (registry) => {
        const entry = registry.plugins.find((p) => p.id === pluginId);
        if (entry) {
          entry.enabled = false;
        }
      });
    }

    // HIGH-1: keyword / tool / scope state 정리
    this.onDisable?.(pluginId);
  }

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
   * Return a snapshot of per-plugin performance statistics.
   * Keys are pluginIds; values contain startup time, call counts, error counts,
   * total execution time, and last call timestamp.
   */
  getPerfStats(): Record<string, PluginPerfStats> {
    const result: Record<string, PluginPerfStats> = {};
    for (const [id, stats] of this.perfStats) {
      result[id] = { ...stats };
    }
    return result;
  }

  /**
   * H2: Renderer-originated plugin invocation. Restricted to the method list
   * each plugin declares in manifest.uiCallable. Everything else must go
   * through ConversationLoop so MAX_PLUGIN_EXPANSION / PermissionManager /
   * ApprovalGate / scope filters are enforced.
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

  /**
   * Register a disposer to run when `pluginId` is disabled. Used by boot's
   * HostApi.onEvent wrapper to clean up host-side event handlers.
   */
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

  /**
   * Phase 1.5 Option C — listPluginCards()
   *
   * LLM 판단 기반 lazy-load 요청을 위한 카탈로그. 각 loaded plugin의
   * pluginId, name, 1-line description, 샘플 tool names (최대 3개)를 반환한다.
   * SystemPromptBuilder가 비활성 plugin 목록을 렌더할 때 사용.
   */
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
      console.warn(
        `[plugin-runtime] Multiple plugins declare capability '${capability}': ${matches.join(", ")}. ` +
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

  /**
   * Retrieve a loaded plugin's instance by id.
   * Returns undefined when the plugin failed to load or is not registered.
   * Public accessor so callers (e.g. boot.ts knowledge-tools DI) do not
   * reach into the private `plugins` Map via `as any` casts.
   */
  getPluginInstance<T = unknown>(pluginId: string): T | undefined {
    return this.plugins.get(pluginId)?.instance as T | undefined;
  }

  /**
   * I2 — Return the absolute directory containing a loaded plugin's entry
   * bundle (typically `<pluginRoot>/dist`). Used by the dev watcher to
   * fs.watch a single directory per plugin. Returns `undefined` when the
   * plugin is not loaded or its entry is invalid.
   */
  getPluginEntryDir(pluginId: string): string | undefined {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return undefined;
    try {
      const entryPath = this.resolveEntryPath(plugin.pluginRoot, plugin.manifest.entry);
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
            entryPath = this.resolveEntryPath(plugin.pluginRoot, entrySource);
          } catch (err) {
            console.warn(
              `[plugin-runtime] ui entry rejected for '${pluginId}': ${(err as Error).message}`,
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
          entryUrl: entryPath ? pathToFileURL(entryPath).href : undefined,
        });
      }
    }
    return result;
  }

  private async readManifest(path: string): Promise<PluginManifest> {
    // Sprint 1-A A4 — detailed, per-field error messages shaped as
    //   "Invalid plugin manifest '<pluginId>' at '<fieldPath>': <reason>. Example: <correction>"
    // so operators can fix manifests without re-reading the loader.
    const raw = await readFile(path, "utf-8");
    let parsed: PluginManifest;
    try {
      parsed = JSON.parse(raw) as PluginManifest;
    } catch (err) {
      throw new Error(
        `Invalid plugin manifest '<unknown>' at '${path}': JSON parse error (${(err as Error).message}). ` +
        `Example: {"id":"com.lge.sample","name":"Sample","version":"1.0.0","entry":"dist/index.js","tools":["sample_ping"]}`,
      );
    }
    parsed.installPolicy = normalizeInstallPolicy(parsed);
    const pid = typeof parsed?.id === "string" && parsed.id.length > 0 ? parsed.id : "<unknown>";
    const fail = (fieldPath: string, reason: string, example: string): never => {
      throw new Error(
        `Invalid plugin manifest '${pid}' at '${fieldPath}' (${path}): ${reason}. Example: ${example}`,
      );
    };

    // Phase 5 §4 — ui[] kind-specific required-field soft fallback.
    // Runs BEFORE AJV so a single bad ui entry does not drop the whole
    // plugin. Each invalid entry is stripped out + console.warn'd; other ui
    // entries survive. AJV still enforces the generic `required` block
    // (id/slot/kind/title) and the `kind` enum.
    if (Array.isArray(parsed.ui)) {
      const keep: typeof parsed.ui = [];
      for (let i = 0; i < parsed.ui.length; i += 1) {
        const ext = parsed.ui[i] as unknown as Record<string, unknown> | undefined;
        if (!ext || typeof ext !== "object" || Array.isArray(ext)) {
          console.warn(`[manifest:${pid}] ui[${i}] is not an object — dropped`);
          continue;
        }
        const kind = ext.kind;
        const missing: string[] = [];
        if (kind === "embedded-module") {
          if (typeof ext.entry !== "string" || ext.entry.length === 0) missing.push("entry");
          if (typeof ext.exportName !== "string" || ext.exportName.length === 0) missing.push("exportName");
        } else if (kind === "embedded-page") {
          if (typeof ext.page !== "string" || ext.page.length === 0) missing.push("page");
        }
        if (missing.length > 0) {
          for (const f of missing) {
            console.warn(
              `[manifest:${pid}] ui[${i}] kind="${String(kind)}" missing required field "${f}" — dropped`,
            );
          }
          continue;
        }
        keep.push(parsed.ui[i]);
      }
      parsed.ui = keep;
    }

    // Sprint 4-B §B-1 — AJV validation against schemas/plugin.schema.json.
    // Surfaces every violation prefixed with `[manifest:<pluginId>]` so the
    // operator sees all errors at once. Hand-rolled cross-field checks below
    // remain authoritative for fields AJV cannot express.
    const validator = await this.getManifestValidator();
    if (validator && !validator(parsed)) {
      const errs = (validator.errors ?? [])
        .map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim())
        .join("; ");
      throw new Error(
        `[manifest:${pid}] schema validation failed (${path}): ${errs}`,
      );
    }

    if (typeof parsed.id !== "string" || parsed.id.length === 0) {
      fail("id", "must be a non-empty string", `"id": "com.lge.meeting-recorder"`);
    }
    if (typeof parsed.version !== "string" || !/^\d+\.\d+\.\d+/.test(parsed.version)) {
      fail("version", "must be a semver string like 'MAJOR.MINOR.PATCH'", `"version": "1.0.0"`);
    }
    if (typeof parsed.entry !== "string" || parsed.entry.length === 0) {
      fail("entry", "must be a non-empty relative path to the plugin ESM entry", `"entry": "dist/index.js"`);
    }
    if (!Array.isArray(parsed.tools)) {
      fail("tools", "must be an array of tool name strings", `"tools": ["sample_ping"]`);
    }

    // Tool names exposed to LLMs must satisfy ^[a-zA-Z_][a-zA-Z0-9_]*$ (vendor requirement).
    // Plugin id is the package identity and may contain dots (e.g. com.lge.meeting-recorder),
    // but tools are LLM tool names — no dots allowed, no runtime conversion is performed.
    const TOOL_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
    for (let i = 0; i < parsed.tools.length; i += 1) {
      const method = parsed.tools[i];
      if (typeof method !== "string") {
        fail(`tools[${i}]`, "must be a string", `"tools": ["meeting_start"]`);
      }
      if (!TOOL_NAME_PATTERN.test(method)) {
        // Backwards-compat: older tests match /Invalid tool name '...'/ — keep that
        // substring so the fresh error message still triggers the same assertion.
        throw new Error(
          `Invalid tool name '${method}' in plugin '${pid}' at 'tools[${i}]' (${path}): ` +
          `tool names must match ^[a-zA-Z_][a-zA-Z0-9_]*$ (start with letter/underscore, then letters/digits/underscores). ` +
          `Example: "tools": ["meeting_start"] (not "meeting.start")`,
        );
      }
    }

    if (parsed.startupTools !== undefined && !Array.isArray(parsed.startupTools)) {
      fail(
        "startupTools",
        "must be an array of strings (each value must appear in tools[])",
        `"startupTools": ["meeting_watch"]`,
      );
    }
    const startupTools = parsed.startupTools ?? [];
    for (let i = 0; i < startupTools.length; i += 1) {
      const startupMethod = startupTools[i];
      if (typeof startupMethod !== "string") {
        fail(
          `startupTools[${i}]`,
          "must be a string",
          `"startupTools": ["meeting_watch"]`,
        );
      }
      if (!parsed.tools.includes(startupMethod)) {
        fail(
          `startupTools[${i}]`,
          `entry '${startupMethod}' is not declared in tools[]`,
          `add "${startupMethod}" to tools[] or remove it from startupTools[]`,
        );
      }
    }

    // Sprint 4-A — surface any remaining testMode flag in a protected plugin
    // manifest. testMode may legitimately appear in dev/fixture builds but
    // should NEVER ship inside a protected deployment install.
    if (
      normalizeInstallPolicy(parsed) === "admin" &&
      parsed.config &&
      typeof parsed.config === "object" &&
      (parsed.config as Record<string, unknown>).testMode === true
    ) {
      console.warn(
        `[plugin-runtime] protected plugin '${pid}' has config.testMode=true (${path}). ` +
        `testMode is a development flag and must not ship in production installs — please remove it from the installed manifest.`,
      );
    }

    if (parsed.startupTimeoutMs !== undefined) {
      // Schema declares integer; runtime enforces matching constraint.
      if (typeof parsed.startupTimeoutMs !== "number" || !Number.isInteger(parsed.startupTimeoutMs) || parsed.startupTimeoutMs <= 0) {
        fail(
          "startupTimeoutMs",
          "must be a positive integer (ms)",
          `"startupTimeoutMs": 8000`,
        );
      }
    }

    // Sprint 4-B §B-3 — uiCallable ⊂ tools validation.
    // uiCallable is the renderer IPC allowlist (lvis:plugins:call); every
    // entry must be a string declared in manifest.tools[]. Security relies on
    // code review + marketplace approval + signature verification — NOT on
    // naming patterns. Destructive-action confirmation is the plugin
    // developer's responsibility in their own UI (see email_reply precedent).
    const uiCallable = Array.isArray(parsed.uiCallable) ? parsed.uiCallable : [];
    for (let i = 0; i < uiCallable.length; i += 1) {
      const method = uiCallable[i];
      if (typeof method !== "string") {
        fail(
          `uiCallable[${i}]`,
          "must be a string",
          `"uiCallable": ["meeting_summary_get"]`,
        );
      }
      if (!parsed.tools.includes(method)) {
        fail(
          `uiCallable[${i}]`,
          `entry '${method}' is not declared in tools[]`,
          `add "${method}" to tools[] or remove it from uiCallable[]`,
        );
      }
    }

    // Phase 5 §1 — keywords[].skillId must be in tools[]. Fail-load when the
    // declared skill refers to a non-existent tool so routing errors surface
    // at boot, not during user interaction.
    const kw = Array.isArray(parsed.keywords) ? parsed.keywords : [];
    for (let i = 0; i < kw.length; i += 1) {
      const sk = kw[i]?.skillId;
      if (typeof sk !== "string" || !parsed.tools.includes(sk)) {
        fail(
          `keywords[${i}].skillId`,
          `"${String(sk)}" not in tools[]`,
          `add '${String(sk)}' to tools[] or fix the skillId`,
        );
      }
    }

    // Phase 5 §2 — toolSchemas keys must be a subset of tools[]. Schema
    // descriptions for non-existent tools would never be surfaced to the LLM
    // and usually indicate a rename drift.
    const schemaKeys = parsed.toolSchemas ? Object.keys(parsed.toolSchemas) : [];
    for (const k of schemaKeys) {
      if (!parsed.tools.includes(k)) {
        fail(
          `toolSchemas['${k}']`,
          `key not in tools[]`,
          `remove the key or add '${k}' to tools[]`,
        );
      }
    }

    // Phase 5 §3 — notificationEvents[i].event should be in
    // eventSubscriptions (otherwise the notification never fires). Soft
    // warn — do not fail the load.
    const subs = Array.isArray(parsed.eventSubscriptions) ? parsed.eventSubscriptions : [];
    const subsTypes = new Set(subs.map((s) => (typeof s === "string" ? s : (s as { type: string }).type)));
    const notifEvents = Array.isArray(parsed.notificationEvents) ? parsed.notificationEvents : [];
    for (let i = 0; i < notifEvents.length; i += 1) {
      const e = notifEvents[i]?.event;
      if (typeof e === "string" && !subsTypes.has(e)) {
        console.warn(
          `[manifest:${pid}] notificationEvents[${i}].event '${e}' not declared in eventSubscriptions — OS notification will still fire, but plugin won't receive the event via hostApi.onEvent`,
        );
      }
    }

    return parsed;
  }

  /**
   * Sprint 4-B §B-1 — lazy-load + compile plugin.schema.json into an AJV
   * validator. AJV is configured with `strict: true` + `allErrors: true` so
   * every violation surfaces in one pass. Compilation failure is logged and
   * returns `null`; readManifest falls back to hand-rolled checks to stay
   * operational.
   */
  private async getManifestValidator(): Promise<ValidateFunction | null> {
    if (this.manifestValidator) return this.manifestValidator;
    try {
      const hereDir = dirname(fileURLToPath(import.meta.url));
      // dist/src/plugins -> ../../../schemas, src/plugins -> ../../schemas
      const candidates = [
        resolve(hereDir, "../../../schemas/plugin.schema.json"),
        resolve(hereDir, "../../schemas/plugin.schema.json"),
      ];
      let schemaBytes: string | null = null;
      for (const candidate of candidates) {
        try {
          schemaBytes = await readFile(candidate, "utf-8");
          break;
        } catch {
          // try next
        }
      }
      if (!schemaBytes) {
        console.warn("[plugin-runtime] plugin.schema.json not found — AJV validation disabled");
        return null;
      }
      const schema = JSON.parse(schemaBytes);
      // Ajv default export compat for ESM/CJS interop.
      const AjvAny = AjvModule as unknown as { default?: unknown };
      const AjvCtor = (AjvAny.default ?? AjvModule) as new (opts?: unknown) => {
        compile: (schema: unknown) => ValidateFunction;
      };
      // strictRequired=false — if/then branches reference properties declared
      // on the outer `properties` block; AJV's strict mode otherwise flags
      // these as "property not defined inside the same schema object".
      const ajv = new AjvCtor({
        strict: true,
        strictRequired: false,
        allErrors: true,
        allowUnionTypes: true,
      });
      const AddAny = AddFormatsModule as unknown as { default?: unknown };
      const addFormatsFn = (AddAny.default ?? AddFormatsModule) as (a: unknown) => void;
      addFormatsFn(ajv);
      this.manifestValidator = ajv.compile(schema);
      return this.manifestValidator;
    } catch (err) {
      console.warn(
        "[plugin-runtime] AJV compile failed — falling back to hand-rolled checks:",
        (err as Error).message,
      );
      return null;
    }
  }

  private resolveDevLinkedPackageEntry(entry: string): string | undefined {
    const normalized = entry.replaceAll("\\", "/");
    const match = normalized.match(/(?:^|\/+)node_modules\/@lvis\/(plugin-[^/]+)\/(.+)$/);
    if (!match) return undefined;
    const [, packageName, packageSubpath] = match;
    const siblingRepoEntry = resolve(this.hostRoot, "..", `lvis-${packageName}`, packageSubpath);
    if (!existsSync(siblingRepoEntry)) return undefined;
    return siblingRepoEntry;
  }

  /**
   * Compute and ensure the plugin's writable data directory at
   * `<pluginsRoot>/<pluginId>/data/`. The plugin install root holds plugin.json
   * + dist/ which gets overwritten on update; runtime state must live in
   * `data/` so it survives reinstalls. Falls back to `<pluginRoot>/data` when
   * `pluginsRoot` is not configured (test harnesses, isolated installs).
   */
  private ensurePluginDataDir(pluginId: string, pluginRoot: string): string {
    const baseRoot = this.pluginsRoot ?? dirname(pluginRoot);
    const dataDir = resolve(baseRoot, pluginId, "data");
    mkdirSync(dataDir, { recursive: true });
    return dataDir;
  }

  private resolveEntryPath(pluginRoot: string, entry: string): string {
    // Dev mode: allow entries that traverse outside the plugin directory
    // (e.g., ../../../node_modules/@lvis/plugin-*/dist/hostPlugin.js).
    // Mirrors the signature-check bypass introduced in PR #171.
    // Phase 1 §Step 4 — gate hard-anchored to !app.isPackaged via dev-flags.
    if (devLinkedEntryAllowed() && !isAbsolute(entry)) {
      const resolved = resolve(pluginRoot, entry);
      if (existsSync(resolved)) return resolved;
      return this.resolveDevLinkedPackageEntry(entry) ?? resolved;
    }
    return resolvePluginEntryPath(pluginRoot, entry);
  }

  /**
   * Trust-root containment check for registry-recorded manifest paths.
   *
   * A registry entry's manifestPath is trusted iff its `realpathSync()`
   * (symlinks resolved) is contained under `realpathSync(pluginsRoot)`.
   * Single source of truth — every install lives at
   * `<pluginsRoot>/<id>/plugin.json`, so the trust root is one path.
   *
   * Why the realpath + path.relative shape:
   *   1. Symlink defeat — without realpath, an attacker who controls HOME
   *      could plant `~/.lvis/plugins/foo -> /some/sensitive/dir` and a
   *      registry entry under `pluginsRoot` would naively pass.
   *   2. `path.relative` instead of `startsWith` — the prefix variant has
   *      trailing-separator pitfalls (`/foo` would falsely match `/foobar`).
   *   3. Roots realpath-resolved — keeps the check symmetric so a root
   *      that itself contains a symlink (common on macOS where `/var` ->
   *      `/private/var`) still works.
   *
   * Failures (manifestPath missing, realpath EACCES, etc.) are REJECTED
   * rather than allowed-by-default: a missing or unreadable file is not a
   * path the host should `import()`. pluginsRoot itself is mkdir'd at boot
   * so realpath(pluginsRoot) succeeds even on first run with no installs.
   */
  private isTrustedRegistryManifestPath(
    manifestPath: string,
    pluginsRoot: string,
  ): boolean {
    if (!isAbsolute(manifestPath)) return true;
    let realManifest: string;
    let realRoot: string;
    try {
      realManifest = realpathSync(manifestPath);
      realRoot = realpathSync(pluginsRoot);
    } catch {
      return false;
    }
    return this.isPathContained(realRoot, realManifest);
  }

  /**
   * Containment via `path.relative` — null/empty/`..`/absolute means the
   * candidate is outside `parent`. Equality is treated as "outside" because a
   * registry entry pointing AT the trust root itself is degenerate (it's a
   * directory, not a manifest file).
   */
  private isPathContained(parent: string, candidate: string): boolean {
    const rel = relative(parent, candidate);
    if (rel === "" || rel === ".") return false;
    if (rel.startsWith("..")) return false;
    if (isAbsolute(rel)) return false;
    return true;
  }

  private async resolveManifestLoadPlan(): Promise<ManifestLoadPlan[]> {
    const plans: ManifestLoadPlan[] = this.manifestPaths.map((manifestPath) => ({
      manifestPath,
      enabled: true,
    }));
    if (!this.registryPath) {
      if (plans.length > 0) return plans;
      throw new Error("Either manifestPaths or registryPath must be provided.");
    }
    const registry = await readPluginRegistry(this.registryPath);
    plans.push(
      ...registry.plugins.flatMap((entry) => {
        const manifestPath = isAbsolute(entry.manifestPath)
          ? entry.manifestPath
          : resolve(dirname(this.registryPath!), entry.manifestPath);
        if (!this.pluginsRoot || !this.isTrustedRegistryManifestPath(manifestPath, this.pluginsRoot)) {
          console.warn(`[plugin-runtime] ignoring untrusted registry manifest path for ${entry.id}: ${manifestPath}`);
          return [];
        }
        return [{
          pluginIdHint: entry.id,
          manifestPath,
          enabled: entry.enabled !== false,
          approvedPluginAccess: entry.approvedPluginAccess,
          devLinked: entry._devLinked === true,
        }];
      }),
    );
    return plans;
  }

  private resetLoadedState(): void {
    // Flush every plugin's disposers before clearing maps.
    for (const [pluginId, list] of this.disposers) {
      for (const d of list) {
        try { d(); } catch (err) {
          console.error(`[plugin:${pluginId}] disposer failed:`, (err as Error).message);
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
    // Note: 호스트의 keywordEngine/toolRegistry는 boot.ts의 createHostApi에서
    // pluginId 기반으로 정리됨 (restartAll → 새로 load 시 재등록)
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

  private async readEnabledManifestSnapshots(
    loadPlan: Array<{ pluginIdHint?: string; manifestPath: string; enabled: boolean; approvedPluginAccess?: PluginAccessSpec }>,
  ): Promise<Map<string, { manifest: PluginManifest; approvedPluginAccess?: PluginAccessSpec }>> {
    const snapshots = new Map<string, { manifest: PluginManifest; approvedPluginAccess?: PluginAccessSpec }>();
    for (const plan of loadPlan) {
      if (!plan.enabled) continue;
      try {
        const manifest = await this.readManifest(plan.manifestPath);
        snapshots.set(manifest.id, {
          manifest,
          approvedPluginAccess: plan.approvedPluginAccess,
        });
      } catch {
        continue;
      }
    }
    return snapshots;
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
      loadStatus,
      version: manifest.version,
      publisher: manifest.publisher,
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

/** 폴백: HostApi 없이 동작하는 noop 구현. `storage` 만큼은 실제 동작해야 한다 — 플러그인은 noop 컨텍스트에서도 자기 데이터를 읽고 쓸 수 있어야 한다. */
function createNoopHostApi(pluginId: string, pluginDataDir: string): PluginHostApi {
  return {
    storage: createPluginStorage(pluginId, pluginDataDir),
    registerKeywords: () => {},
    emitEvent: () => {},
    onEvent: () => () => {},
    addTask: () => {},
    getSecret: () => null,
    callTool: async () => {
      throw new Error("Plugin tool invocation not available in noop context");
    },
    callLlm: async () => { throw new Error("LLM not available in noop context"); },
    logEvent: () => {},
    onShutdown: () => {},
    openAuthWindow: async () => { throw new Error("openAuthWindow not available in noop context"); },
    triggerConversation: async (spec) => ({
      accepted: false,
      reason: "loop_unavailable",
      source: typeof spec?.source === "string" ? spec.source : "",
    }),
  };
}
