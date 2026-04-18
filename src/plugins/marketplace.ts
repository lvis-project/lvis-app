import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { readPluginRegistry, updatePluginRegistry, withRegistryLock, writePluginRegistry } from "./registry.js";
import type { PluginDeploymentGuard } from "./deployment-guard.js";
import type { MarketplaceFetcher } from "./marketplace-fetcher.js";
import type { PluginMarketplaceItem, PluginUiExtension } from "./types.js";

export type { MarketplaceFetcher } from "./marketplace-fetcher.js";

type MarketplaceCatalog = {
  version: number;
  plugins: PluginMarketplaceItem[];
};

export interface MarketplaceListItem extends PluginMarketplaceItem {
  installed: boolean;
  enabled: boolean;
  /** Phase 1.5 §9.6: true if protected (managed) — used by UI to show lock icon */
  isManaged: boolean;
}

/**
 * Default fetcher that reads the bundled `plugins/marketplace.json`
 * catalog file. Preserves the pre-M4 behavior — install/uninstall and
 * existing tests continue to work unchanged.
 *
 * Note: download/detail operations are not supported by this fetcher
 * because the local catalog does not carry version binaries; callers
 * that need those must use {@link RealCloudMarketplaceFetcher}.
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
   * PR#44 HIGH: per-plugin in-process mutex. Concurrent install/rollback
   * calls for the same pluginId are serialized to protect the cache
   * breadcrumb + history.json from corruption.
   */
  private readonly locks = new Map<string, Promise<void>>();

  constructor(
    appRoot: string,
    deploymentGuard?: PluginDeploymentGuard,
    fetcher?: MarketplaceFetcher,
    cacheRoot?: string,
  ) {
    this.appRoot = resolve(appRoot);
    this.registryPath = resolve(this.appRoot, "plugins/registry.json");
    this.marketplacePath = resolve(this.appRoot, "plugins/marketplace.json");
    this.installedDir = resolve(this.appRoot, "plugins/installed");
    this.deploymentGuard = deploymentGuard;
    this.fetcher = fetcher ?? new MockMarketplaceFetcher(this.marketplacePath);
    this.cacheRoot = cacheRoot ?? resolve(homedir(), ".lvis/plugins/.cache");
  }

  async list(): Promise<MarketplaceListItem[]> {
    const [plugins, registry] = await Promise.all([
      this.fetcher.listPlugins(),
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
    if (catalogItem.deployment === "managed") return true;
    if (!installedManifestPath) return false;
    const abs = isAbsolute(installedManifestPath)
      ? installedManifestPath
      : resolve(dirname(this.registryPath), installedManifestPath);
    try {
      const raw = await readFile(abs, "utf-8");
      const parsed = JSON.parse(raw) as { deployment?: string };
      return parsed.deployment === "managed";
    } catch {
      return false;
    }
  }

  async install(pluginId: string): Promise<{ pluginId: string; installed: true }> {
    const plugins = await this.fetcher.listPlugins();
    const plugin = plugins.find((x) => x.id === pluginId);
    if (!plugin) {
      throw new Error(`Plugin not found in marketplace: ${pluginId}`);
    }

    // §7.2 canInstall — managed 카탈로그 항목은 user actor 차단 (defense-in-depth).
    // UI 잠금은 이미 disabled지만 IPC 경유 직접 호출도 봉쇄.
    if (this.deploymentGuard) {
      const guardResult = await this.deploymentGuard.canInstall(pluginId, "user", plugin.deployment);
      if (!guardResult.allowed) {
        throw new Error(guardResult.reason ?? `Plugin install denied: ${pluginId}`);
      }
    }

    // §3-B rollback support — snapshot the currently-installed manifest
    // before it gets overwritten so rollbackPlugin() can restore it.
    await this.cacheCurrentVersion(pluginId);

    await this.runNpmInstall(plugin.packageSpec);
    const manifestPath = await this.writeInstalledManifest(plugin);
    // Cache the freshly-installed version too so rollback targets don't
    // include the version we just promoted to "current".
    await this.cacheVersionFromManifest(pluginId, resolve(dirname(this.registryPath), manifestPath));

    // §M1 F-round: atomic read-modify-write under registry lock.
    await updatePluginRegistry(this.registryPath, (registry) => {
      const existing = registry.plugins.find((x) => x.id === plugin.id);
      if (existing) {
        existing.manifestPath = manifestPath;
        existing.enabled = true;
      } else {
        registry.plugins.push({ id: plugin.id, manifestPath, enabled: true });
      }
    });
    return { pluginId: plugin.id, installed: true };
  }

  async uninstall(pluginId: string): Promise<{ pluginId: string; uninstalled: true }> {
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

      const remainingEntries = registry.plugins.filter((x) => x.id !== pluginId);
      const manifestPath = isAbsolute(target.manifestPath)
        ? target.manifestPath
        : resolve(dirname(this.registryPath), target.manifestPath);
      const packageName = await this.resolvePackageName(pluginId, manifestPath);
      const shouldUninstallPackage =
        packageName && !(await this.isPackageUsedByRemainingPlugins(packageName, remainingEntries.map((entry) => entry.id)));

      if (shouldUninstallPackage && packageName) {
        await this.runNpmUninstall(packageName);
      }

      const installedManifestDir = dirname(manifestPath);
      if (this.isWithin(this.installedDir, installedManifestDir)) {
        await rm(installedManifestDir, { recursive: true, force: true });
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
        const guardResult = await this.deploymentGuard.canInstall(pluginId, "user", plugin.deployment);
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
        } else {
          registry.plugins.push({ id: plugin.id, manifestPath, enabled: true });
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
        } else {
          registry.plugins.push({ id: pluginId, manifestPath: registryRelativePath, enabled: true });
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
      if (candidate === currentVersion) continue;
      const cachedManifest = resolve(this.cacheRoot, pluginId, candidate, "plugin.json");
      try {
        await readFile(cachedManifest, "utf-8");
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
    const entryRelPath = relative(pluginDir, entryAbsPath).split("\\").join("/");
    const resolvedUi = (plugin.ui ?? []).map((extension) => this.resolveUiExtension(plugin, pluginDir, extension));
    const manifest: Record<string, unknown> = {
      id: plugin.id,
      name: plugin.name,
      version: version ?? "1.0.0",
      entry: entryRelPath,
      tools: plugin.tools,
      config: plugin.defaultConfig ?? {},
      ui: resolvedUi,
      // §3-B rollback: persist the npm package name into the installed manifest
      // so rollbackPlugin() can reinstall cached versions without consulting
      // the live marketplace catalog.
      packageName: plugin.packageName,
    };
    if (plugin.deployment) manifest.deployment = plugin.deployment;
    if (plugin.publisher) manifest.publisher = plugin.publisher;
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
    const registryRelativePath = relative(dirname(this.registryPath), manifestFile).split("\\").join("/");
    return registryRelativePath;
  }

  private resolveUiExtension(
    plugin: PluginMarketplaceItem,
    pluginDir: string,
    extension: PluginUiExtension,
  ): PluginUiExtension {
    const entrySource = extension.entry ?? extension.page;
    if (!entrySource) return extension;
    const entryAbsPath = resolve(this.appRoot, "node_modules", plugin.packageName, entrySource);
    const entryRelPath = relative(pluginDir, entryAbsPath).split("\\").join("/");
    return {
      ...extension,
      entry: entryRelPath,
      page: extension.page ? entryRelPath : undefined,
    };
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
  private async runNpmInstall(packageSpec: string): Promise<void> {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const child = spawn("npm", ["install", "--prefix", this.appRoot, packageSpec], {
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
      const child = spawn("npm", ["uninstall", "--prefix", this.appRoot, packageName], {
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

