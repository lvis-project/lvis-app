import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, posix, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { readPluginRegistry, updatePluginRegistry, withRegistryLock, writePluginRegistry } from "./registry.js";
import type { PluginDeploymentGuard } from "./deployment-guard.js";
import type { MarketplaceFetcher } from "./marketplace-fetcher.js";
import type { PluginManifest, PluginMarketplaceItem, PluginUiExtension } from "./types.js";
import { MissingDependenciesError } from "./types.js";
import { resolveDependencies } from "./dependency-resolver.js";
import AdmZip from "adm-zip";
import { getCachedCatalog, isOfflineCacheEnabled, setCachedCatalog } from "./offline-cache.js";
import { installFromMarketplace, type MarketplaceHttp } from "./marketplace-installer.js";
import { getBundledPublicKeys } from "./publisher-keys.js";
import type { InstallPolicy, PluginRegistryEntry } from "./types.js";

export type { MarketplaceFetcher } from "./marketplace-fetcher.js";

function normalizeInstallPolicy(source: {
  installPolicy?: InstallPolicy;
  deployment?: "managed" | "user";
}): InstallPolicy {
  if (source.installPolicy === "admin" || source.deployment === "managed") {
    return "admin";
  }
  return "user";
}

function normalizeDeliveryMode(
  deliveryMode: PluginMarketplaceItem["deliveryMode"] | "bundled" | undefined,
): PluginMarketplaceItem["deliveryMode"] | undefined {
  if (deliveryMode === "bundled") return "bundle";
  return deliveryMode;
}

function normalizeBundleDependencies(
  plugin: Pick<PluginMarketplaceItem, "bundleDependencies">,
): Array<{ pluginId: string; versionRange?: string; required: boolean }> {
  const result: Array<{ pluginId: string; versionRange?: string; required: boolean }> = [];
  for (const dependency of plugin.bundleDependencies ?? []) {
    if (typeof dependency === "string") {
      result.push({ pluginId: dependency, required: true });
      continue;
    }
    if (!dependency?.pluginId) continue;
    result.push({
      pluginId: dependency.pluginId,
      versionRange: dependency.versionRange,
      required: dependency.required ?? true,
    });
  }
  return result;
}

type MarketplaceCatalog = {
  version: number;
  plugins: PluginMarketplaceItem[];
};

type InstallOperationState = {
  installedPluginIds: string[];
  touchedEntries: Map<
    string,
    {
      enabled: boolean | undefined;
      bundleRefs: string[] | undefined;
      installedBy: "admin" | "user" | undefined;
      approvedPluginAccess: PluginRegistryEntry["approvedPluginAccess"];
    }
  >;
};

type VerifiedMarketplaceFetcher = MarketplaceFetcher & MarketplaceHttp;

export interface MarketplaceListItem extends PluginMarketplaceItem {
  installed: boolean;
  enabled: boolean;
  /** Phase 1.5 §9.6: true if protected (managed) — used by UI to show lock icon */
  isManaged: boolean;
}

/**
 * @internal Test-only fetcher. Reads a local JSON catalog file.
 * Production code must use {@link RealCloudMarketplaceFetcher} instead.
 * Note: downloadVersion() is not supported.
 */
export class MockMarketplaceFetcher implements MarketplaceFetcher {
  constructor(private readonly marketplacePath: string) {}

  async listPlugins(): Promise<PluginMarketplaceItem[]> {
    const catalog = await this.readCatalog();
    return catalog.plugins;
  }

  async getPluginDetail(slug: string): Promise<PluginMarketplaceItem | null> {
    const catalog = await this.readCatalog();
    return catalog.plugins.find((p) => p.id === slug) ?? null;
  }

  async downloadVersion(
    _slug: string,
    _version: string,
  ): Promise<{ zipBuffer: Buffer; sha256: string }> {
    throw new Error(
      "MockMarketplaceFetcher does not support downloadVersion(); use RealCloudMarketplaceFetcher",
    );
  }

  async readCatalog(): Promise<MarketplaceCatalog> {
    const raw = await readFile(this.marketplacePath, "utf-8");
    const parsed = JSON.parse(raw) as MarketplaceCatalog;
    if (!Array.isArray(parsed.plugins)) {
      throw new Error(`Invalid marketplace catalog: ${this.marketplacePath}`);
    }
    return parsed;
  }
}

function buildPinnedSpec(packageName: string, version: string): string {
  // Scoped packages: @scope/name@version. Unscoped: name@version.
  return `${packageName}@${version}`;
}

/** Sprint 3-B §9.6 / PR#44 HIGH — per-plugin install/rollback history. */
interface PluginHistoryEntry {
  version: string;
  installedAt: string; // ISO timestamp
}

export class PluginMarketplaceService {
  private readonly appRoot: string;
  private readonly registryPath: string;
  private readonly marketplacePath: string;
  private readonly installedDir: string;
  private readonly deploymentGuard?: PluginDeploymentGuard;
  private readonly fetcher: MarketplaceFetcher;
  /** Sprint 3-B §9.6: per-plugin version cache for rollback. */
  private readonly cacheRoot: string;
  /**
   * S9: base directory for the catalog cache. `null` disables catalog caching
   * (used when the fetcher is the bundled mock / local-file path).
   * `undefined` uses the default global path under `~/.lvis/marketplace-cache/`.
   */
  private readonly catalogCacheBase: string | null | undefined;
  /**
   * PR#44 HIGH: per-plugin in-process mutex. Concurrent install/rollback
   * calls for the same pluginId are serialized to protect the cache
   * breadcrumb + history.json from corruption.
   */
  private readonly locks = new Map<string, Promise<void>>();
  /** Optional diagnostic logger. Injected in tests; no-op in production. */
  readonly log?: (message: string, ...args: unknown[]) => void;

  constructor(
    appRoot: string,
    deploymentGuard?: PluginDeploymentGuard,
    fetcher?: MarketplaceFetcher,
    cacheRoot?: string,
  ) {
    this.appRoot = resolve(appRoot);
    this.registryPath = resolve(this.appRoot, "plugins/registry.json");
    this.marketplacePath = resolve(this.appRoot, "plugins/marketplace.json");
    this.installedDir = resolve(homedir(), ".lvis/plugins");
    this.deploymentGuard = deploymentGuard;
    // When no external fetcher is provided we fall back to the bundled local
    // marketplace.json mock — catalog caching makes no sense for local files.
    const usingMockFetcher = !fetcher;
    this.fetcher = fetcher ?? new MockMarketplaceFetcher(this.marketplacePath);
    this.cacheRoot = cacheRoot ?? resolve(homedir(), ".lvis/plugins/.cache");
    this.catalogCacheBase = usingMockFetcher ? null : undefined;
  }

  async list(): Promise<MarketplaceListItem[]> {
    // Catalog cache is disabled when using MockMarketplaceFetcher (local files).
    const cacheBase = this.catalogCacheBase;
    const useCache = cacheBase !== null && isOfflineCacheEnabled();
    const cacheBaseArg = typeof cacheBase === "string" ? cacheBase : undefined;
    let catalogPlugins: PluginMarketplaceItem[] | null = null;

    if (useCache) {
      catalogPlugins = await getCachedCatalog(cacheBaseArg);
    }

    let fetchedFromNetwork = false;
    if (!catalogPlugins) {
      try {
        catalogPlugins = await this.fetcher.listPlugins();
        fetchedFromNetwork = true;
      } catch (err) {
        // Network failure — fall back to stale cache if available (TTL bypassed
        // intentionally: any cached data is better than a hard failure offline).
        const stale = useCache ? await getCachedCatalog(cacheBaseArg, { allowStale: true }) : null;
        if (stale) {
          console.warn("[marketplace] network fetch failed, using stale cache:", (err as Error).message);
          catalogPlugins = stale;
        } else {
          throw err;
        }
      }
    }

    if (fetchedFromNetwork && useCache) {
      await setCachedCatalog(catalogPlugins, cacheBaseArg);
    }

    const [plugins, registry] = await Promise.all([
      Promise.resolve(catalogPlugins),
      readPluginRegistry(this.registryPath),
    ]);
    const items: MarketplaceListItem[] = [];
    for (const plugin of plugins) {
      const entry = registry.plugins.find((x) => x.id === plugin.id);
      const isManaged = await this.resolveIsManaged(plugin, entry?.manifestPath);
      items.push({
        ...plugin,
        installed: !!entry,
        enabled: entry?.enabled !== false,
        isManaged,
      });
    }
    return items;
  }

  private async resolveIsManaged(
    catalogItem: PluginMarketplaceItem,
    installedManifestPath?: string,
  ): Promise<boolean> {
    if (normalizeInstallPolicy(catalogItem) === "admin") return true;
    if (!installedManifestPath) return false;
    const abs = isAbsolute(installedManifestPath)
      ? installedManifestPath
      : resolve(dirname(this.registryPath), installedManifestPath);
    try {
      const raw = await readFile(abs, "utf-8");
      const parsed = JSON.parse(raw) as { installPolicy?: InstallPolicy; deployment?: "managed" | "user" };
      return normalizeInstallPolicy(parsed) === "admin";
    } catch {
      return false;
    }
  }

  async install(
    pluginId: string,
    actor: "user" | "it-admin" = "user",
  ): Promise<{ pluginId: string; installed: true }> {
    const state: InstallOperationState = {
      installedPluginIds: [],
      touchedEntries: new Map(),
    };
    try {
      return await this.installWithBundleDependencies(pluginId, actor, new Set<string>(), null, state);
    } catch (error) {
      await this.rollbackInstallOperation(state);
      throw error;
    }
  }

  private async installWithBundleDependencies(
    pluginId: string,
    actor: "user" | "it-admin",
    seen: Set<string>,
    bundleRootId: string | null,
    state: InstallOperationState,
  ): Promise<{ pluginId: string; installed: true }> {
    if (seen.has(pluginId)) {
      return { pluginId, installed: true };
    }
    seen.add(pluginId);
    const plugins = await this.fetcher.listPlugins();
    const plugin = plugins.find((x) => x.id === pluginId || x.slug === pluginId);
    if (!plugin) {
      throw new Error(`Plugin not found in marketplace: ${pluginId}`);
    }

    // §7.2 canInstall — managed 카탈로그 항목은 user actor 차단 (defense-in-depth).
    // Boot-time force-install uses actor="it-admin" to bypass this guard for
    // mandatory enterprise plugins (see ensureManagedInstalled).
    if (this.deploymentGuard) {
      const guardResult = await this.deploymentGuard.canInstall(
        pluginId,
        actor,
        plugin.deployment,
        plugin.installPolicy,
      );
      if (!guardResult.allowed) {
        throw new Error(guardResult.reason ?? `Plugin install denied: ${pluginId}`);
      }
    }

    const activeBundleRootId =
      bundleRootId ?? (normalizeDeliveryMode(plugin.deliveryMode as PluginMarketplaceItem["deliveryMode"] | "bundled" | undefined) === "bundle"
        ? plugin.id
        : null);

    for (const dependency of normalizeBundleDependencies(plugin)) {
      await this.installWithBundleDependencies(
        dependency.pluginId,
        actor,
        seen,
        activeBundleRootId,
        state,
      );
    }

    const existingEntry = await this.getInstalledRegistryEntry(plugin.id);
    if (existingEntry) {
      // If the requested version matches the currently-installed version (or
      // neither specifies a concrete semver version) treat this as a no-op so
      // repeated installs of the same release are idempotent.  When the catalog
      // advertises a DIFFERENT version we fall through to re-install so that an
      // "install" call can act as an in-place upgrade and stale files from the
      // old release do not survive.
      const installedVersion = await this.getInstalledVersion(plugin.id);
      const isSameVersion =
        !plugin.version ||
        !installedVersion ||
        plugin.version === installedVersion;
      if (isSameVersion) {
        await this.touchInstalledRegistryEntry(plugin.id, activeBundleRootId, actor, plugin.pluginAccess, state);
        return { pluginId: plugin.id, installed: true };
      }
    }

    // S14: dependency preflight — evaluate after any managed bundle dependencies
    // have been auto-installed so bundled providers can satisfy their own
    // requires.capabilities through the companion plugins they bring along.
    if (plugin.requires && plugin.requires.capabilities.length > 0) {
      const installedManifests = await this.loadInstalledManifests();
      const result = resolveDependencies(plugin.requires.capabilities, installedManifests);
      if (!result.ok) {
        throw new MissingDependenciesError(result.missing);
      }
    }

    // §3-B rollback support — snapshot the currently-installed manifest
    // before it gets overwritten so rollbackPlugin() can restore it.
    await this.cacheCurrentVersion(pluginId);

    const dlVersion = plugin.version ?? "latest";
    const manifestPath = await this.installArtifact(plugin, dlVersion);
    const manifestAbsPath = isAbsolute(manifestPath)
      ? manifestPath
      : resolve(dirname(this.registryPath), manifestPath);
    await this.cacheVersionFromManifest(pluginId, manifestAbsPath);

    // §M1 F-round: atomic read-modify-write under registry lock.
    await updatePluginRegistry(this.registryPath, (registry) => {
      const existing = registry.plugins.find((x) => x.id === plugin.id);
      if (existing) {
        existing.manifestPath = manifestPath;
        existing.enabled = true;
        existing.installedBy = actor === "it-admin" ? "admin" : "user";
        existing.bundleRefs = this.mergeBundleRefs(existing.bundleRefs, activeBundleRootId, plugin.id);
        existing.approvedPluginAccess = plugin.pluginAccess;
      } else {
        registry.plugins.push({
          id: plugin.id,
          manifestPath,
          enabled: true,
          installedBy: actor === "it-admin" ? "admin" : "user",
          bundleRefs: this.mergeBundleRefs([], activeBundleRootId, plugin.id),
          approvedPluginAccess: plugin.pluginAccess,
        });
      }
    });
    state.installedPluginIds.push(plugin.id);
    return { pluginId: plugin.id, installed: true };
  }

  /**
   * Boot-time admin plugin bootstrap. Queries the marketplace catalog for
   * every admin-policy plugin and force-installs any that are
   * missing from the local registry. Runs as actor="it-admin" so the deployment
   * guard permits the install.
   *
   * Failure modes are intentionally graceful — marketplace unreachable or a
   * single plugin failing to install must NOT brick boot. Errors are logged
   * and the app continues without the failed plugins.
   */
  async ensureManagedInstalled(): Promise<{
    installed: string[];
    failed: Array<{ id: string; error: string }>;
  }> {
    const result = { installed: [] as string[], failed: [] as Array<{ id: string; error: string }> };
    let plugins: PluginMarketplaceItem[];
    try {
      plugins = await this.fetcher.listPlugins();
    } catch (err) {
      console.warn(
        `[marketplace] ensureManagedInstalled: catalog unreachable — skipping: ${(err as Error).message}`,
      );
      return result;
    }
    const managed = plugins.filter((p) => normalizeInstallPolicy(p) === "admin");
    if (managed.length === 0) return result;
    const registry = await readPluginRegistry(this.registryPath).catch(() => ({
      version: 1,
      plugins: [],
    }));
    const installedIds = await this.resolveInstalledIds(registry.plugins);
    for (const plugin of managed) {
      if (installedIds.has(plugin.id)) continue;
      try {
        await this.install(plugin.id, "it-admin");
        result.installed.push(plugin.id);
      } catch (err) {
        const msg = (err as Error).message;
        result.failed.push({ id: plugin.id, error: msg });
        console.warn(`[marketplace] managed plugin '${plugin.id}' install failed: ${msg}`);
      }
    }
    return result;
  }

  async uninstall(
    pluginId: string,
    options?: { removeBundleMembers?: boolean },
  ): Promise<{ pluginId: string; uninstalled: true }> {
    // §7.2 PluginDeploymentGuard — managed 플러그인은 user actor에게 차단.
    if (this.deploymentGuard) {
      const guardResult = await this.deploymentGuard.canUninstall(pluginId, "user");
      if (!guardResult.allowed) {
        throw new Error(guardResult.reason ?? `Plugin uninstall denied: ${pluginId}`);
      }
    }

    // §M1 F-round: serialize read-remove-write through the registry lock.
    return withRegistryLock(this.registryPath, async () => {
      const registry = await readPluginRegistry(this.registryPath);
      const target = registry.plugins.find((x) => x.id === pluginId);
      if (!target) {
        throw new Error(`Plugin not installed: ${pluginId}`);
      }
      const idsToRemove = new Set<string>([pluginId]);
      for (const entry of registry.plugins) {
        if (entry.id === pluginId) continue;
        const withoutRoot = (entry.bundleRefs ?? []).filter((bundleId) => bundleId !== pluginId);
        const referencedByRoot = withoutRoot.length !== (entry.bundleRefs ?? []).length;
        if (!referencedByRoot) continue;
        if (options?.removeBundleMembers && withoutRoot.length === 0 && entry.installedBy !== "admin") {
          idsToRemove.add(entry.id);
          continue;
        }
        entry.bundleRefs = withoutRoot;
      }

      const remainingEntries = registry.plugins.filter((x) => !idsToRemove.has(x.id));
      for (const entry of registry.plugins) {
        if (!idsToRemove.has(entry.id)) continue;
        await this.removeInstalledEntry(entry, remainingEntries);
      }
      registry.plugins = remainingEntries;
      await writePluginRegistry(this.registryPath, registry);
      return { pluginId, uninstalled: true as const };
    });
  }

  /**
   * Sprint 3-B §9.6 — versioned install path. Thin wrapper around `install()`
   * that pins `packageSpec` to a specific version (npm semver) and leaves a
   * rollback breadcrumb. Callers can pass any marketplace pluginId; version
   * is used as the npm install target (e.g. `@lvis/foo@1.2.3`).
   */
  async installPlugin(
    pluginId: string,
    version: string,
  ): Promise<{ pluginId: string; installed: true; version: string }> {
    return this.withPluginLock(pluginId, async () => {
      const plugins = await this.fetcher.listPlugins();
      const plugin = plugins.find((x) => x.id === pluginId);
      if (!plugin) {
        throw new Error(`Plugin not found in marketplace: ${pluginId}`);
      }
      if (this.deploymentGuard) {
        const guardResult = await this.deploymentGuard.canInstall(
          pluginId,
          "user",
          plugin.deployment,
          plugin.installPolicy,
        );
        if (!guardResult.allowed) {
          throw new Error(guardResult.reason ?? `Plugin install denied: ${pluginId}`);
        }
      }

      await this.cacheCurrentVersion(pluginId);

      // Override packageSpec to pin the requested version. Preserve registry semantics.
      const pinnedSpec = buildPinnedSpec(plugin.packageName, version);
      await this.runNpmInstall(pinnedSpec);
      const manifestPath = await this.writeInstalledManifest(plugin, version);
      await this.cacheVersionFromManifest(pluginId, resolve(dirname(this.registryPath), manifestPath));
      // PR#44 HIGH: record install in per-plugin history.json (replaces the
      // mtime-based rollback target selection, which is unreliable across
      // filesystems that round mtimes and cache writes).
      await this.appendHistoryEntry(pluginId, { version, installedAt: new Date().toISOString() });

      await updatePluginRegistry(this.registryPath, (registry) => {
        const existing = registry.plugins.find((x) => x.id === plugin.id);
        if (existing) {
          existing.manifestPath = manifestPath;
          existing.enabled = true;
          existing.installedBy = "user";
          existing.approvedPluginAccess = plugin.pluginAccess;
        } else {
          registry.plugins.push({
            id: plugin.id,
            manifestPath,
            enabled: true,
            installedBy: "user",
            bundleRefs: [],
            approvedPluginAccess: plugin.pluginAccess,
          });
        }
      });
      return { pluginId: plugin.id, installed: true, version };
    });
  }

  /**
   * Sprint 3-B §9.6 — rollback to the prior cached version for `pluginId`.
   * Throws when no prior version is available.
   * PR#44 HIGH: guarded by per-plugin mutex to avoid racing with installPlugin.
   */
  async rollbackPlugin(pluginId: string): Promise<{ pluginId: string; rolledBackTo: string }> {
    return this.withPluginLock(pluginId, async () => {
      const priorVersion = await this.findRollbackTargetVersion(pluginId);
      if (!priorVersion) {
        throw new Error(`No prior version cached for plugin: ${pluginId}`);
      }

      const cachedManifestPath = resolve(this.cacheRoot, pluginId, priorVersion, "plugin.json");
      const raw = await readFile(cachedManifestPath, "utf-8");
      const cachedManifest = JSON.parse(raw) as { packageName?: string };
      if (cachedManifest.packageName) {
        // Reinstall the cached npm package at the prior version. npm resolves
        // `name@version` from the registry the host is configured against.
        await this.runNpmInstall(buildPinnedSpec(cachedManifest.packageName, priorVersion));
      }

      // Restore the cached plugin.json into the live installed dir.
      const liveDir = resolve(this.installedDir, pluginId);
      await mkdir(liveDir, { recursive: true });
      const liveManifest = resolve(liveDir, "plugin.json");
      await writeFile(liveManifest, raw, "utf-8");

      // Record the rollback as a new history entry so subsequent rollbacks
      // pick the correct prior version.
      await this.appendHistoryEntry(pluginId, { version: priorVersion, installedAt: new Date().toISOString() });

      const registryRelativePath = relative(dirname(this.registryPath), liveManifest).split("\\").join("/");
      await updatePluginRegistry(this.registryPath, (registry) => {
        const existing = registry.plugins.find((x) => x.id === pluginId);
        if (existing) {
          existing.manifestPath = registryRelativePath;
          existing.enabled = true;
          existing.installedBy = existing.installedBy ?? "user";
          existing.bundleRefs = existing.bundleRefs ?? [];
        } else {
          registry.plugins.push({
            id: pluginId,
            manifestPath: registryRelativePath,
            enabled: true,
            installedBy: "user",
            bundleRefs: [],
          });
        }
      });
      return { pluginId, rolledBackTo: priorVersion };
    });
  }

  /**
   * PR#44 HIGH: per-plugin serialization. Concurrent callers for the same
   * pluginId queue behind each other; callers for different plugins run
   * concurrently. We keep the map entry only while the promise is pending.
   */
  private async withPluginLock<T>(pluginId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(pluginId) ?? Promise.resolve();
    let release: () => void = () => {};
    const next = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    this.locks.set(pluginId, prev.then(() => next));
    try {
      await prev;
      return await fn();
    } finally {
      release();
      // Clean up the map entry if this is still the tail of the queue.
      if (this.locks.get(pluginId) === prev.then(() => next)) {
        this.locks.delete(pluginId);
      }
    }
  }

  private historyPath(pluginId: string): string {
    return resolve(this.cacheRoot, pluginId, "history.json");
  }

  private async readHistory(pluginId: string): Promise<PluginHistoryEntry[]> {
    try {
      const raw = await readFile(this.historyPath(pluginId), "utf-8");
      const parsed = JSON.parse(raw) as { entries?: PluginHistoryEntry[] };
      return Array.isArray(parsed.entries) ? parsed.entries : [];
    } catch {
      return [];
    }
  }

  private async appendHistoryEntry(pluginId: string, entry: PluginHistoryEntry): Promise<void> {
    try {
      const dir = resolve(this.cacheRoot, pluginId);
      await mkdir(dir, { recursive: true });
      const entries = await this.readHistory(pluginId);
      entries.push(entry);
      await writeFile(this.historyPath(pluginId), `${JSON.stringify({ entries }, null, 2)}\n`, "utf-8");
    } catch (err) {
      console.warn(`[marketplace] appendHistoryEntry failed for ${pluginId}:`, (err as Error).message);
    }
  }

  /**
   * Reads the currently-installed manifest for `pluginId` (if any) and
   * snapshots it under `{cacheRoot}/{pluginId}/{version}/plugin.json`.
   * No-op when the plugin is not yet installed.
   */
  private async cacheCurrentVersion(pluginId: string): Promise<void> {
    const registry = await readPluginRegistry(this.registryPath).catch(() => null);
    const entry = registry?.plugins.find((p) => p.id === pluginId);
    if (!entry) return;
    const manifestAbs = isAbsolute(entry.manifestPath)
      ? entry.manifestPath
      : resolve(dirname(this.registryPath), entry.manifestPath);
    await this.cacheVersionFromManifest(pluginId, manifestAbs);
  }

  private async cacheVersionFromManifest(pluginId: string, manifestPath: string): Promise<void> {
    try {
      const raw = await readFile(manifestPath, "utf-8");
      const parsed = JSON.parse(raw) as { version?: string };
      const version = parsed.version ?? "unknown";
      const dir = resolve(this.cacheRoot, pluginId, version);
      await mkdir(dir, { recursive: true });
      await writeFile(resolve(dir, "plugin.json"), raw, "utf-8");
    } catch (err) {
      console.warn(`[marketplace] cacheVersion failed for ${pluginId}:`, (err as Error).message);
    }
  }

  /**
   * PR#44 HIGH: use persisted history.json (install order-of-record) rather
   * than filesystem mtimes. Picks the most recent history entry whose version
   * differs from the currently-installed one. Falls back to `null` when no
   * suitable prior version exists.
   */
  private async findRollbackTargetVersion(pluginId: string): Promise<string | null> {
    const entries = await this.readHistory(pluginId);
    if (entries.length === 0) return null;
    // Determine the current version so we don't select it as the rollback target.
    const registry = await readPluginRegistry(this.registryPath).catch(() => null);
    const current = registry?.plugins.find((p) => p.id === pluginId);
    let currentVersion: string | undefined;
    if (current) {
      const manifestAbs = isAbsolute(current.manifestPath)
        ? current.manifestPath
        : resolve(dirname(this.registryPath), current.manifestPath);
      try {
        const raw = await readFile(manifestAbs, "utf-8");
        currentVersion = (JSON.parse(raw) as { version?: string }).version;
      } catch {
        /* ignore */
      }
    }
    // Walk history from newest → oldest, return first non-current version
    // whose cached manifest still exists on disk.
    for (let i = entries.length - 1; i >= 0; i--) {
      const candidate = entries[i].version;
      // PR#44 Copilot: guard against empty/whitespace/invalid version dirs —
      // they must be non-empty strings and the cached manifest must exist and
      // parse as JSON with a matching `version` field. Invalid entries are
      // skipped rather than treated as missing.
      if (!candidate || typeof candidate !== "string" || candidate.trim().length === 0) continue;
      if (candidate === currentVersion) continue;
      const cachedManifest = resolve(this.cacheRoot, pluginId, candidate, "plugin.json");
      try {
        const raw = await readFile(cachedManifest, "utf-8");
        const parsed = JSON.parse(raw) as { version?: string };
        if (!parsed.version) continue;
        return candidate;
      } catch {
        continue;
      }
    }
    return null;
  }

  private async writeInstalledManifest(plugin: PluginMarketplaceItem, version?: string): Promise<string> {
    const pluginDir = resolve(this.installedDir, plugin.id);
    await mkdir(pluginDir, { recursive: true });
    const manifestFile = resolve(pluginDir, "plugin.json");
    const entryAbsPath = resolve(this.appRoot, "node_modules", plugin.packageName, "dist/hostPlugin.js");
    this.assertPathWithinNodeModules(plugin.id, entryAbsPath, "package");
    const entryRelPath = relative(pluginDir, entryAbsPath).split("\\").join("/");
    const resolvedUi = (plugin.ui ?? []).map((extension) => this.resolveUiExtension(plugin, pluginDir, extension));
    const manifest = this.buildInstalledManifest(plugin, {
      version: version ?? "1.0.0",
      entry: entryRelPath,
      ui: resolvedUi,
    });
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
    // Use absolute path when installedDir is outside appRoot (e.g. ~/.lvis/plugins/)
    // so the registry entry remains valid regardless of where registry.json lives.
    const isOutsideApp = !this.isPathWithinAppRoot(manifestFile);
    const registryPath = isOutsideApp
      ? manifestFile
      : relative(dirname(this.registryPath), manifestFile).split("\\").join("/");
    return registryPath;
  }

  private resolveUiExtension(
    plugin: PluginMarketplaceItem,
    pluginDir: string,
    extension: PluginUiExtension,
  ): PluginUiExtension {
    const entrySource = extension.entry ?? extension.page;
    if (!entrySource) return extension;
    const entryAbsPath = resolve(this.appRoot, "node_modules", plugin.packageName, entrySource);
    this.assertPathWithinNodeModules(plugin.id, entryAbsPath, "UI entry");
    const entryRelPath = relative(pluginDir, entryAbsPath).split("\\").join("/");
    return {
      ...extension,
      entry: entryRelPath,
      page: extension.page ? entryRelPath : undefined,
    };
  }

  private async getInstalledRegistryEntry(pluginId: string): Promise<PluginRegistryEntry | null> {
    const registry = await readPluginRegistry(this.registryPath).catch(() => null);
    if (!registry) return null;
    const entry = registry.plugins.find((candidate) => candidate.id === pluginId);
    if (!entry) return null;
    const manifestPath = isAbsolute(entry.manifestPath)
      ? entry.manifestPath
      : resolve(dirname(this.registryPath), entry.manifestPath);
    try {
      await readFile(manifestPath, "utf-8");
      return entry;
    } catch {
      return null;
    }
  }

  /** Returns the version string from the currently-installed manifest, or null. */
  private async getInstalledVersion(pluginId: string): Promise<string | null> {
    const registry = await readPluginRegistry(this.registryPath).catch(() => null);
    if (!registry) return null;
    const entry = registry.plugins.find((c) => c.id === pluginId);
    if (!entry) return null;
    const manifestPath = isAbsolute(entry.manifestPath)
      ? entry.manifestPath
      : resolve(dirname(this.registryPath), entry.manifestPath);
    try {
      const raw = await readFile(manifestPath, "utf-8");
      const parsed = JSON.parse(raw) as { version?: unknown };
      return typeof parsed.version === "string" ? parsed.version : null;
    } catch {
      return null;
    }
  }

  private mergeBundleRefs(
    bundleRefs: string[] | undefined,
    bundleRootId: string | null,
    pluginId: string,
  ): string[] {
    if (!bundleRootId || bundleRootId === pluginId) {
      return bundleRefs ?? [];
    }
    return [...new Set([...(bundleRefs ?? []), bundleRootId])];
  }

  private async touchInstalledRegistryEntry(
    pluginId: string,
    bundleRootId: string | null,
    actor: "user" | "it-admin",
    approvedPluginAccess: PluginRegistryEntry["approvedPluginAccess"],
    state?: InstallOperationState,
  ): Promise<void> {
    await updatePluginRegistry(this.registryPath, (registry) => {
      const entry = registry.plugins.find((candidate) => candidate.id === pluginId);
      if (!entry) return;
      if (state && !state.touchedEntries.has(pluginId)) {
        state.touchedEntries.set(pluginId, {
          enabled: entry.enabled,
          bundleRefs: entry.bundleRefs ? [...entry.bundleRefs] : undefined,
          installedBy: entry.installedBy,
          approvedPluginAccess: entry.approvedPluginAccess,
        });
      }
      entry.enabled = true;
      entry.installedBy = actor === "it-admin" ? "admin" : entry.installedBy ?? "user";
      entry.bundleRefs = this.mergeBundleRefs(entry.bundleRefs, bundleRootId, pluginId);
      entry.approvedPluginAccess = approvedPluginAccess;
    });
  }

  private async rollbackInstallOperation(state: InstallOperationState): Promise<void> {
    if (state.installedPluginIds.length === 0 && state.touchedEntries.size === 0) {
      return;
    }
    await withRegistryLock(this.registryPath, async () => {
      const registry = await readPluginRegistry(this.registryPath).catch(() => ({
        version: 1,
        plugins: [],
      }));
      for (const pluginId of [...state.installedPluginIds].reverse()) {
        const entry = registry.plugins.find((candidate) => candidate.id === pluginId);
        if (!entry) continue;
        registry.plugins = registry.plugins.filter((candidate) => candidate.id !== pluginId);
        await this.removeInstalledEntry(entry, registry.plugins);
      }
      for (const [pluginId, snapshot] of state.touchedEntries) {
        const entry = registry.plugins.find((candidate) => candidate.id === pluginId);
        if (!entry) continue;
        entry.enabled = snapshot.enabled;
        entry.bundleRefs = snapshot.bundleRefs;
        entry.installedBy = snapshot.installedBy;
        entry.approvedPluginAccess = snapshot.approvedPluginAccess;
      }
      await writePluginRegistry(this.registryPath, registry);
    });
  }

  private async removeInstalledEntry(
    entry: PluginRegistryEntry,
    remainingEntries: PluginRegistryEntry[],
  ): Promise<void> {
    const manifestPath = isAbsolute(entry.manifestPath)
      ? entry.manifestPath
      : resolve(dirname(this.registryPath), entry.manifestPath);
    const installedManifestDir = dirname(manifestPath);
    const isZipInstalled = this.isWithin(this.installedDir, installedManifestDir);
    if (!isZipInstalled) {
      const packageName = await this.resolvePackageName(entry.id, manifestPath);
      const shouldUninstallPackage =
        packageName && !(await this.isPackageUsedByRemainingPlugins(packageName, remainingEntries.map((candidate) => candidate.id)));
      if (shouldUninstallPackage && packageName) {
        await this.runNpmUninstall(packageName);
      }
    }
    if (isZipInstalled) {
      await rm(installedManifestDir, { recursive: true, force: true });
    }
  }

  private async resolvePackageName(pluginId: string, manifestPath: string): Promise<string | undefined> {
    const plugins = await this.fetcher.listPlugins().catch(() => [] as PluginMarketplaceItem[]);
    const targetFromCatalog = plugins.find((x) => x.id === pluginId);
    if (targetFromCatalog?.packageName) {
      return targetFromCatalog.packageName;
    }

    try {
      const rawManifest = await readFile(manifestPath, "utf-8");
      const parsed = JSON.parse(rawManifest) as { entry?: string };
      return this.extractPackageNameFromEntry(parsed.entry);
    } catch {
      return undefined;
    }
  }

  private extractPackageNameFromEntry(entry?: string): string | undefined {
    if (!entry) return undefined;
    const normalized = entry.split("\\").join("/");
    const matched = normalized.match(/node_modules\/((?:@[^/]+\/[^/]+)|(?:[^/]+))/);
    return matched?.[1];
  }

  private async isPackageUsedByRemainingPlugins(packageName: string, remainingPluginIds: string[]): Promise<boolean> {
    const plugins = await this.fetcher.listPlugins().catch(() => [] as PluginMarketplaceItem[]);
    const remaining = new Set(remainingPluginIds);
    return plugins.some((plugin) => plugin.packageName === packageName && remaining.has(plugin.id));
  }

  private isWithin(basePath: string, targetPath: string): boolean {
    const rel = relative(basePath, targetPath);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  }

  /**
   * S14: load manifests for all currently-installed plugins so the dependency
   * resolver can inspect their `capabilities[]`.  Skips entries whose manifest
   * cannot be read or parsed (fail-open — a corrupt manifest must not block
   * unrelated installs).
   */
  private async loadInstalledManifests(): Promise<PluginManifest[]> {
    const registry = await readPluginRegistry(this.registryPath).catch(() => null);
    if (!registry) return [];
    const manifests: PluginManifest[] = [];
    for (const entry of registry.plugins) {
      if (entry.enabled === false) continue;
      const abs = isAbsolute(entry.manifestPath)
        ? entry.manifestPath
        : resolve(dirname(this.registryPath), entry.manifestPath);
      try {
        const raw = await readFile(abs, "utf-8");
        manifests.push(JSON.parse(raw) as PluginManifest);
      } catch {
        // skip unreadable manifest
      }
    }
    return manifests;
  }

  private async installArtifact(
    plugin: PluginMarketplaceItem,
    version: string,
  ): Promise<string> {
    if (plugin.packageSpec.startsWith("file:") || this.fetcher instanceof MockMarketplaceFetcher) {
      const packageSpec = this.resolveLocalPackageSpec(plugin.packageSpec);
      await this.runNpmInstall(packageSpec);
      return this.writeInstalledManifest(plugin, version);
    }

    const pluginDir = resolve(this.installedDir, plugin.id);
    const zipBuffer = await this.downloadVerifiedMarketplaceZip(plugin, version);
    await this.extractMarketplaceZip(plugin.id, zipBuffer, pluginDir);

    const manifestFile = resolve(pluginDir, "plugin.json");
    let zipHasManifest = false;
    try {
      await readFile(manifestFile, "utf-8");
      zipHasManifest = true;
    } catch {
      // not in zip
    }
    if (!zipHasManifest) {
      const safeVersion = /^\d+\.\d+\.\d+/.test(version) ? version : "0.0.0";
      const manifest = this.buildInstalledManifest(plugin, {
        version: safeVersion,
        entry: "./dist/hostPlugin.js",
      });
      await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    } else {
      await this.assertInstalledManifestMatchesCatalog(plugin, version, manifestFile, pluginDir);
    }
    return manifestFile;
  }

  private buildInstalledManifest(
    plugin: PluginMarketplaceItem,
    options: {
      version: string;
      entry: string;
      ui?: PluginUiExtension[];
    },
  ): Record<string, unknown> {
    const manifest: Record<string, unknown> = {
      id: plugin.id,
      name: plugin.name,
      version: options.version,
      entry: options.entry,
      tools: plugin.tools,
      config: plugin.defaultConfig ?? {},
      // §3-B rollback: persist the npm package name into the installed manifest
      // so rollbackPlugin() can reinstall cached versions without consulting
      // the live marketplace catalog.
      packageName: plugin.packageName,
    };
    if (plugin.description) manifest.description = plugin.description;
    if (options.ui && options.ui.length > 0) manifest.ui = options.ui;
    if (plugin.capabilities && plugin.capabilities.length > 0) manifest.capabilities = plugin.capabilities;
    if (plugin.startupTools && plugin.startupTools.length > 0) manifest.startupTools = plugin.startupTools;
    if (plugin.keywords && plugin.keywords.length > 0) manifest.keywords = plugin.keywords;
    if (plugin.uiCallable && plugin.uiCallable.length > 0) manifest.uiCallable = plugin.uiCallable;
    if (plugin.emittedEvents && plugin.emittedEvents.length > 0) manifest.emittedEvents = plugin.emittedEvents;
    if (plugin.notificationEvents && plugin.notificationEvents.length > 0) manifest.notificationEvents = plugin.notificationEvents;
    if (plugin.toolSchemas && Object.keys(plugin.toolSchemas).length > 0) manifest.toolSchemas = plugin.toolSchemas;
    if (plugin.installPolicy) manifest.installPolicy = plugin.installPolicy;
    if (plugin.deployment) manifest.deployment = plugin.deployment;
    const normalizedDeliveryMode = normalizeDeliveryMode(
      plugin.deliveryMode as PluginMarketplaceItem["deliveryMode"] | "bundled" | undefined,
    );
    if (normalizedDeliveryMode) manifest.deliveryMode = normalizedDeliveryMode;
    if (plugin.bundleDependencies && plugin.bundleDependencies.length > 0) manifest.bundleDependencies = plugin.bundleDependencies;
    if (plugin.pluginAccess) manifest.pluginAccess = plugin.pluginAccess;
    if (plugin.requires && plugin.requires.capabilities.length > 0) manifest.requires = plugin.requires;
    if (plugin.publisher) manifest.publisher = plugin.publisher;
    return manifest;
  }

  private async assertInstalledManifestMatchesCatalog(
    plugin: PluginMarketplaceItem,
    version: string,
    manifestFile: string,
    pluginDir: string,
  ): Promise<void> {
    try {
      const raw = await readFile(manifestFile, "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`plugin "${plugin.id}" manifest must be a JSON object`);
      }

      const manifest = parsed as Partial<PluginManifest> & Record<string, unknown>;
      if (manifest.id !== plugin.id) {
        throw new Error(
          `plugin "${plugin.id}" artifact manifest id mismatch: expected "${plugin.id}", got "${String(manifest.id ?? "")}"`,
        );
      }

      if (/^\d+\.\d+\.\d+/.test(version) && manifest.version !== version) {
        throw new Error(
          `plugin "${plugin.id}" artifact manifest version mismatch: expected "${version}", got "${String(manifest.version ?? "")}"`,
        );
      }

      const expectedInstallPolicy = plugin.installPolicy ?? "user";
      const actualInstallPolicy = manifest.installPolicy ?? "user";
      if (actualInstallPolicy !== expectedInstallPolicy) {
        throw new Error(
          `plugin "${plugin.id}" artifact manifest installPolicy mismatch: expected "${expectedInstallPolicy}", got "${String(actualInstallPolicy)}"`,
        );
      }

      const expectedDeployment = plugin.deployment ?? "user";
      const actualDeployment = manifest.deployment ?? "user";
      if (actualDeployment !== expectedDeployment) {
        throw new Error(
          `plugin "${plugin.id}" artifact manifest deployment mismatch: expected "${expectedDeployment}", got "${String(actualDeployment)}"`,
        );
      }

      const expectedPluginAccess = plugin.pluginAccess ?? undefined;
      const actualPluginAccess = manifest.pluginAccess ?? undefined;
      if (JSON.stringify(actualPluginAccess) !== JSON.stringify(expectedPluginAccess)) {
        throw new Error(
          `plugin "${plugin.id}" artifact manifest pluginAccess does not match the catalog-approved grant`,
        );
      }

      const expectedDeliveryMode = normalizeDeliveryMode(
        plugin.deliveryMode as PluginMarketplaceItem["deliveryMode"] | "bundled" | undefined,
      ) ?? "marketplace";
      const actualDeliveryMode = normalizeDeliveryMode(
        manifest.deliveryMode as PluginManifest["deliveryMode"] | "bundled" | undefined,
      ) ?? "marketplace";
      if (actualDeliveryMode !== expectedDeliveryMode) {
        throw new Error(
          `plugin "${plugin.id}" artifact manifest deliveryMode mismatch: expected "${expectedDeliveryMode}", got "${String(actualDeliveryMode)}"`,
        );
      }

      const expectedBundleDependencies = normalizeBundleDependencies(plugin);
      const actualBundleDependencies = normalizeBundleDependencies(
        manifest as Pick<PluginManifest, "bundleDependencies">,
      );
      if (JSON.stringify(actualBundleDependencies) !== JSON.stringify(expectedBundleDependencies)) {
        throw new Error(
          `plugin "${plugin.id}" artifact manifest bundleDependencies does not match the catalog-approved bundle members`,
        );
      }
    } catch (err) {
      await rm(pluginDir, { recursive: true, force: true });
      throw err;
    }
  }

  private async downloadVerifiedMarketplaceZip(
    plugin: PluginMarketplaceItem,
    version: string,
  ): Promise<Buffer> {
    const slug = plugin.slug ?? plugin.id;
    if (!isVerifiedMarketplaceFetcher(this.fetcher)) {
      throw new Error(
        `remote marketplace fetcher for "${plugin.id}" does not support signed artifact verification`,
      );
    }
    const verified = await installFromMarketplace(slug, version, {
      http: this.fetcher,
      publicKeys: getBundledPublicKeys(),
      downloadRoot: resolve(this.cacheRoot, "verified-downloads"),
      cacheBase: null,
    });
    return readFile(verified.tarballPath);
  }

  private async extractMarketplaceZip(
    pluginId: string,
    zipBuffer: Buffer,
    pluginDir: string,
  ): Promise<void> {
    const stageDir = resolve(this.installedDir, `.${pluginId}.stage-${randomUUID()}`);
    await rm(stageDir, { recursive: true, force: true });
    await mkdir(stageDir, { recursive: true });

    try {
      let zip: AdmZip;
      try {
        zip = new AdmZip(zipBuffer);
      } catch (err) {
        throw new Error(`invalid zip format for plugin "${pluginId}": ${(err as Error).message}`);
      }

      for (const entry of zip.getEntries()) {
        const safeEntryPath = sanitizeZipEntryPath(pluginId, entry.entryName);
        if (!safeEntryPath) continue;
        const targetPath = resolve(stageDir, safeEntryPath);
        if (!this.isWithin(stageDir, targetPath)) {
          throw new Error(`plugin "${pluginId}" zip entry escapes install root: ${entry.entryName}`);
        }
        if (entry.isDirectory) {
          await mkdir(targetPath, { recursive: true });
          continue;
        }
        await mkdir(dirname(targetPath), { recursive: true });
        await writeFile(targetPath, entry.getData());
      }

      // Atomically swap stageDir → pluginDir.  On Windows, rename() refuses to
      // overwrite a non-empty directory, so we first rename the existing
      // pluginDir to a temporary name (which is always safe on the same volume)
      // and then rename stageDir into place.  Only after both renames succeed do
      // we remove the old directory, ensuring the live pluginDir is never in a
      // half-removed state if the process is killed between operations.
      const oldDir = resolve(this.installedDir, `.${pluginId}.old-${randomUUID()}`);
      let hadOldDir = false;
      try {
        await rename(pluginDir, oldDir);
        hadOldDir = true;
      } catch {
        // pluginDir did not exist yet (first install) — nothing to move aside.
      }
      try {
        await rename(stageDir, pluginDir);
      } catch (renameErr) {
        // Restore the old directory if the swap failed so we don't leave the
        // plugin in a broken state.
        if (hadOldDir) {
          await rename(oldDir, pluginDir).catch(() => undefined);
        }
        throw renameErr;
      }
      if (hadOldDir) {
        await rm(oldDir, { recursive: true, force: true }).catch(() => undefined);
      }
    } catch (err) {
      await rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }
  }

  private async resolveInstalledIds(
    entries: Array<{ id: string; manifestPath: string }>,
  ): Promise<Set<string>> {
    const installedIds = new Set<string>();
    for (const entry of entries) {
      const manifestPath = isAbsolute(entry.manifestPath)
        ? entry.manifestPath
        : resolve(dirname(this.registryPath), entry.manifestPath);
      try {
        await readFile(manifestPath, "utf-8");
        installedIds.add(entry.id);
      } catch {
        console.warn(
          `[marketplace] stale registry entry ignored during managed bootstrap: ${entry.id}`,
        );
      }
    }
    return installedIds;
  }

  private resolveLocalPackageSpec(packageSpec: string): string {
    if (!packageSpec.startsWith("file:")) {
      return packageSpec;
    }
    const target = packageSpec.slice("file:".length).trim();
    if (!target) {
      throw new Error("local plugin packageSpec is empty");
    }
    const workspaceRoot = resolve(this.appRoot, "..");
    const resolvedTarget = isAbsolute(target)
      ? target
      : resolve(this.appRoot, target);
    if (!existsSync(resolvedTarget)) {
      throw new Error(`local plugin package not found: ${packageSpec}`);
    }
    const realWorkspaceRoot = realpathSync(workspaceRoot);
    const realTarget = realpathSync(resolvedTarget);
    if (!this.isWithin(realWorkspaceRoot, realTarget)) {
      throw new Error(`local plugin package escapes workspace root: ${packageSpec}`);
    }
    return `file:${realTarget}`;
  }

  private assertPathWithinNodeModules(
    pluginId: string,
    targetPath: string,
    label: string,
  ): void {
    const nodeModulesRoot = resolve(this.appRoot, "node_modules");
    const realNodeModulesRoot = existsSync(nodeModulesRoot)
      ? realpathSync(nodeModulesRoot)
      : nodeModulesRoot;
    const resolvedTarget = existsSync(targetPath)
      ? realpathSync(targetPath)
      : targetPath;
    if (!this.isWithin(realNodeModulesRoot, resolvedTarget)) {
      throw new Error(`plugin "${pluginId}" ${label} path escapes node_modules`);
    }
  }

  private isPathWithinAppRoot(targetPath: string): boolean {
    const realAppRoot = existsSync(this.appRoot)
      ? realpathSync(this.appRoot)
      : this.appRoot;
    const resolvedTarget = existsSync(targetPath)
      ? realpathSync(targetPath)
      : targetPath;
    return this.isWithin(realAppRoot, resolvedTarget);
  }

  private async runNpmInstall(packageSpec: string): Promise<void> {
    if (packageSpec.startsWith("file:")) {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        const child = spawn("npm", ["install", "--prefix", this.appRoot, "--", packageSpec], {
          stdio: "pipe",
          shell: false,
          cwd: this.appRoot,
        });
        let stderr = "";
        child.stdout.on("data", (chunk) => {
          process.stdout.write(chunk);
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk.toString("utf-8");
          process.stderr.write(chunk);
        });
        const timeout = setTimeout(() => {
          child.kill("SIGTERM");
          rejectPromise(new Error(`npm install timeout for ${packageSpec}`));
        }, 60_000);
        child.on("exit", (code) => {
          clearTimeout(timeout);
          if (code === 0) {
            resolvePromise();
            return;
          }
          rejectPromise(new Error(stderr || `npm install failed (${code})`));
        });
      });
      return;
    }
    // M4 defence-in-depth: refuse unpinned package specs to prevent unintended
    // installs of "latest" from the public npm registry. The version portion
    // (after the last '@') must start with a digit, '^', or '~'.
    const lastAt = packageSpec.lastIndexOf("@");
    const versionPart = lastAt > 0 ? packageSpec.slice(lastAt + 1) : "";
    if (!versionPart || !/^[\d^~]/.test(versionPart)) {
      throw new Error(
        `refusing unpinned npm install for "${packageSpec}" — version must be pinned`,
      );
    }
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const child = spawn("npm", ["install", "--prefix", this.appRoot, "--", packageSpec], {
        stdio: "pipe",
        shell: false,
        cwd: this.appRoot,
      });
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        process.stdout.write(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf-8");
        process.stderr.write(chunk);
      });
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        rejectPromise(new Error(`npm install timeout for ${packageSpec}`));
      }, 60_000);
      child.on("exit", (code) => {
        clearTimeout(timeout);
        if (code === 0) {
          resolvePromise();
          return;
        }
        rejectPromise(new Error(stderr || `npm install failed (${code})`));
      });
    });
  }

  private async runNpmUninstall(packageName: string): Promise<void> {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const child = spawn("npm", ["uninstall", "--prefix", this.appRoot, "--", packageName], {
        stdio: "pipe",
        shell: false,
        cwd: this.appRoot,
      });
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        process.stdout.write(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf-8");
        process.stderr.write(chunk);
      });
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        rejectPromise(new Error(`npm uninstall timeout for ${packageName}`));
      }, 60_000);
      child.on("exit", (code) => {
        clearTimeout(timeout);
        if (code === 0) {
          resolvePromise();
          return;
        }
        rejectPromise(new Error(stderr || `npm uninstall failed (${code})`));
      });
    });
  }
}

function isVerifiedMarketplaceFetcher(fetcher: MarketplaceFetcher): fetcher is VerifiedMarketplaceFetcher {
  return (
    typeof (fetcher as Partial<VerifiedMarketplaceFetcher>).downloadArtifact === "function" &&
    typeof (fetcher as Partial<VerifiedMarketplaceFetcher>).fetchSignatureEnvelope === "function"
  );
}

function sanitizeZipEntryPath(pluginId: string, entryName: string): string | null {
  const normalized = entryName.split("\\").join("/").replace(/^\/+/, "");
  if (!normalized || normalized === ".") return null;
  if (normalized.includes("\u0000")) {
    throw new Error(`plugin "${pluginId}" zip entry contains NUL byte`);
  }
  if (/^[A-Za-z]:/.test(normalized)) {
    throw new Error(`plugin "${pluginId}" zip entry uses absolute drive path: ${entryName}`);
  }
  const collapsed = posix.normalize(normalized);
  if (!collapsed || collapsed === ".") return null;
  if (collapsed === ".." || collapsed.startsWith("../")) {
    throw new Error(`plugin "${pluginId}" zip entry escapes install root: ${entryName}`);
  }
  return collapsed.endsWith("/") ? collapsed.slice(0, -1) : collapsed;
}
