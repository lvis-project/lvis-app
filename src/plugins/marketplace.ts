import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, posix, relative, resolve } from "node:path";
import { readPluginRegistry, updatePluginRegistry, withRegistryLock, writePluginRegistry } from "./registry.js";
import type { PluginDeploymentGuard } from "./deployment-guard.js";
import type { MarketplaceFetcher } from "./marketplace-fetcher.js";
import { toRegistryRelativeManifestPath, type PluginPaths } from "./plugin-paths.js";
import { assertMockMarketplaceAllowed } from "../boot/dev-flags.js";
import type { PluginManifest, PluginMarketplaceItem, PluginUiExtension } from "./types.js";
import { MissingDependenciesError } from "./types.js";
import { resolveDependencies } from "./dependency-resolver.js";
import AdmZip from "adm-zip";
import { getCachedCatalog, isOfflineCacheEnabled, setCachedCatalog } from "./offline-cache.js";
import { installFromMarketplace, type InstallerProgressEvent, type MarketplaceHttp } from "./marketplace-installer.js";
import { getBundledPublicKeys } from "./publisher-keys.js";
import type { InstallPolicy, PluginRegistryEntry } from "./types.js";

export type { MarketplaceFetcher } from "./marketplace-fetcher.js";

function normalizeInstallPolicy(source: {
  installPolicy?: InstallPolicy;
}): InstallPolicy {
  if (source.installPolicy === "admin") {
    return "admin";
  }
  return "user";
}

function normalizeDependencies(
  plugin: Pick<PluginMarketplaceItem, "dependencies">,
): Array<{ pluginId: string; versionRange?: string; required: boolean }> {
  const result: Array<{ pluginId: string; versionRange?: string; required: boolean }> = [];
  for (const dependency of plugin.dependencies ?? []) {
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
 * Disabled fetcher — used when no real-cloud backend is configured in a
 * packaged build. Constructor is side-effect free so boot does not crash;
 * any actual marketplace method (list/install/download) throws a clear
 * `marketplace-disabled` error so callers can degrade gracefully. The
 * managed bootstrap (`resolveManagedPluginBootstrap`) short-circuits
 * before reaching this fetcher in the same conditions.
 */
export class DisabledMarketplaceFetcher implements MarketplaceFetcher {
  private static readonly ERR =
    "marketplace-disabled: no marketplace backend configured for this build";

  async listPlugins(): Promise<PluginMarketplaceItem[]> {
    throw new Error(DisabledMarketplaceFetcher.ERR);
  }

  async getPluginDetail(): Promise<PluginMarketplaceItem | null> {
    throw new Error(DisabledMarketplaceFetcher.ERR);
  }

  async downloadVersion(): Promise<{ zipBuffer: Buffer; sha256: string }> {
    throw new Error(DisabledMarketplaceFetcher.ERR);
  }
}

/**
 * @internal Dev/test-only fetcher. Reads a local JSON catalog file.
 *
 * Production / packaged builds MUST use {@link RealCloudMarketplaceFetcher}
 * — the constructor throws when invoked in a packaged build via the shared
 * dev-flags gate. The local `plugins/marketplace.json` is user-writable and
 * cannot serve as a trust anchor; any packaged binary that fell back to this
 * fetcher would let local users advertise their own plugins as
 * `installPolicy:"admin"` and get them auto-installed by the managed
 * bootstrap (security-reviewer H-1, pre-Phase-2 audit).
 *
 * Note: downloadVersion() is not supported regardless of build mode.
 */
export class MockMarketplaceFetcher implements MarketplaceFetcher {
  constructor(private readonly marketplacePath: string) {
    assertMockMarketplaceAllowed();
  }

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

/** Sprint 3-B §9.6 / PR#44 HIGH — per-plugin install/rollback history. */
interface PluginHistoryEntry {
  version: string;
  installedAt: string; // ISO timestamp
}

export class PluginMarketplaceService {
  private readonly registryPath: string;
  private readonly installedDir: string;
  private readonly deploymentGuard?: PluginDeploymentGuard;
  private readonly fetcher: MarketplaceFetcher;
  /** Sprint 3-B §9.6: per-plugin version cache for rollback. */
  private readonly cacheRoot: string;
  /**
   * S9: base directory for the catalog cache. `null` disables catalog caching
   * (used with the dev test fetcher). `undefined` uses the default global
   * path under `userData/marketplace-cache/`.
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

  /**
   * Phase 2-final constructor — `paths` is the single source of truth for
   * the registry / installed-dir / cache layout, and `fetcher` is required.
   * The pre-Phase-2b `appRoot` argument used by the npm-install branch is
   * gone; the only install path is the signed-zip download under
   * `paths.userInstalledDir`.
   */
  constructor(
    paths: PluginPaths,
    fetcher: MarketplaceFetcher,
    deploymentGuard?: PluginDeploymentGuard,
  ) {
    this.registryPath = paths.registryPath;
    this.installedDir = paths.userInstalledDir;
    this.cacheRoot = paths.cacheRoot;
    this.deploymentGuard = deploymentGuard;
    this.fetcher = fetcher;
    // Catalog caching is disabled for the test mock fetcher; production
    // fetchers (RealCloud, Disabled stub) get the default cache base under
    // userData.
    this.catalogCacheBase = fetcher instanceof MockMarketplaceFetcher ? null : undefined;
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
      const parsed = JSON.parse(raw) as { installPolicy?: InstallPolicy };
      return normalizeInstallPolicy(parsed) === "admin";
    } catch {
      return false;
    }
  }

  async install(
    pluginId: string,
    actor: "user" | "it-admin" = "user",
    onProgress?: (event: InstallerProgressEvent) => void,
  ): Promise<{ pluginId: string; installed: true }> {
    const state: InstallOperationState = {
      installedPluginIds: [],
      touchedEntries: new Map(),
    };
    try {
      return await this.installWithDependencies(pluginId, actor, new Set<string>(), null, state, onProgress);
    } catch (error) {
      await this.rollbackInstallOperation(state);
      throw error;
    }
  }

  private async installWithDependencies(
    pluginId: string,
    actor: "user" | "it-admin",
    seen: Set<string>,
    bundleRootId: string | null,
    state: InstallOperationState,
    onProgress?: (event: InstallerProgressEvent) => void,
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

    // §7.2 canInstall — admin-policy catalog entries block user actor installs.
    // Boot-time force-install uses actor="it-admin" to bypass this guard for
    // mandatory enterprise plugins (see ensureManagedInstalled).
    if (this.deploymentGuard) {
      const guardResult = await this.deploymentGuard.canInstall(
        pluginId,
        actor,
        plugin.installPolicy,
      );
      if (!guardResult.allowed) {
        throw new Error(guardResult.reason ?? `Plugin install denied: ${pluginId}`);
      }
    }

    const activeBundleRootId =
      bundleRootId ?? (normalizeDependencies(plugin).length > 0
        ? plugin.id
        : null);

    for (const dependency of normalizeDependencies(plugin)) {
      await this.installWithDependencies(
        dependency.pluginId,
        actor,
        seen,
        activeBundleRootId,
        state,
        onProgress,
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

    // S14: dependency preflight — evaluate after declared dependencies have
    // been auto-installed so providers can satisfy their own requires.capabilities.
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
    const manifestPath = await this.installArtifact(plugin, dlVersion, onProgress);
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
    * missing from the local registry. Runs as actor="it-admin" so the install-policy
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
          plugin.installPolicy,
        );
        if (!guardResult.allowed) {
          throw new Error(guardResult.reason ?? `Plugin install denied: ${pluginId}`);
        }
      }

      await this.cacheCurrentVersion(pluginId);

      const manifestPath = await this.installArtifact(plugin, version);
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
      // Phase 2-final rollback: re-run the verified-zip install path with
      // the prior version. The marketplace server retains every published
      // version; the client's `cacheRoot` only tracks history (which versions
      // we've used), the binary itself is fetched fresh each time. No npm.
      const plugin = await this.fetcher.getPluginDetail(pluginId);
      if (!plugin) {
        throw new Error(`Plugin not in marketplace catalog: ${pluginId}`);
      }
      const manifestPathRel = await this.installArtifact(plugin, priorVersion);

      await this.appendHistoryEntry(pluginId, { version: priorVersion, installedAt: new Date().toISOString() });

      await updatePluginRegistry(this.registryPath, (registry) => {
        const existing = registry.plugins.find((x) => x.id === pluginId);
        if (existing) {
          existing.manifestPath = manifestPathRel;
          existing.enabled = true;
          existing.installedBy = existing.installedBy ?? "user";
          existing.bundleRefs = existing.bundleRefs ?? [];
        } else {
          registry.plugins.push({
            id: pluginId,
            manifestPath: manifestPathRel,
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
    _remainingEntries: PluginRegistryEntry[],
  ): Promise<void> {
    // Phase 2-final: every install is a zip-extract under userInstalledDir,
    // so uninstall is a recursive rm of the plugin's directory. The
    // pre-Phase-2 npm-uninstall branch (`isZipInstalled === false`) is
    // gone with the install-side npm path.
    const manifestPath = isAbsolute(entry.manifestPath)
      ? entry.manifestPath
      : resolve(dirname(this.registryPath), entry.manifestPath);
    const installedManifestDir = dirname(manifestPath);
    if (this.isWithin(this.installedDir, installedManifestDir)) {
      await rm(installedManifestDir, { recursive: true, force: true });
    }
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

  /**
   * Phase 2-final install path — single source: download + verify + extract.
   *
   * The historical file:-spec / npm-install branch is gone. Production and
   * dev both fetch a signed zip from the marketplace API; the dev workflow
   * runs the marketplace server locally (default `http://localhost:8000`)
   * and publishes plugin artifacts via the server's CLI rather than
   * sideloading sibling-repo paths.
   */
  private async installArtifact(
    plugin: PluginMarketplaceItem,
    version: string,
    onProgress?: (event: InstallerProgressEvent) => void,
  ): Promise<string> {
    const pluginDir = resolve(this.installedDir, plugin.id);
    const zipBuffer = await this.downloadVerifiedMarketplaceZip(plugin, version, onProgress);
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
    // Phase 2a invariant: registry entries hold registry-relative POSIX
    // paths regardless of which install branch produced the manifest. The
    // file branch above already routes through writeInstalledManifest which
    // applies the same normalization.
    return toRegistryRelativeManifestPath(this.registryPath, manifestFile);
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
    if (plugin.dependencies && plugin.dependencies.length > 0) manifest.dependencies = plugin.dependencies;
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

      const expectedPluginAccess = plugin.pluginAccess ?? undefined;
      const actualPluginAccess = manifest.pluginAccess ?? undefined;
      if (JSON.stringify(actualPluginAccess) !== JSON.stringify(expectedPluginAccess)) {
        throw new Error(
          `plugin "${plugin.id}" artifact manifest pluginAccess does not match the catalog-approved grant`,
        );
      }

      const expectedDependencies = normalizeDependencies(plugin);
      const actualDependencies = normalizeDependencies(
        manifest as Pick<PluginManifest, "dependencies">,
      );
      if (JSON.stringify(actualDependencies) !== JSON.stringify(expectedDependencies)) {
        throw new Error(
          `plugin "${plugin.id}" artifact manifest dependencies do not match the catalog-approved dependencies`,
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
    onProgress?: (event: InstallerProgressEvent) => void,
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
      onProgress,
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
