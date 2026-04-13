import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { readPluginRegistry, updatePluginRegistry, withRegistryLock, writePluginRegistry } from "./registry.js";
import type { PluginDeploymentGuard } from "./deployment-guard.js";
import type { PluginMarketplaceItem, PluginUiExtension } from "./types.js";

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

export class PluginMarketplaceService {
  private readonly appRoot: string;
  private readonly registryPath: string;
  private readonly marketplacePath: string;
  private readonly installedDir: string;
  private readonly deploymentGuard?: PluginDeploymentGuard;

  constructor(appRoot: string, deploymentGuard?: PluginDeploymentGuard) {
    this.appRoot = resolve(appRoot);
    this.registryPath = resolve(this.appRoot, "plugins/registry.json");
    this.marketplacePath = resolve(this.appRoot, "plugins/marketplace.json");
    this.installedDir = resolve(this.appRoot, "plugins/installed");
    this.deploymentGuard = deploymentGuard;
  }

  async list(): Promise<MarketplaceListItem[]> {
    const [catalog, registry] = await Promise.all([this.readCatalog(), readPluginRegistry(this.registryPath)]);
    const items: MarketplaceListItem[] = [];
    for (const plugin of catalog.plugins) {
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
    const catalog = await this.readCatalog();
    const plugin = catalog.plugins.find((x) => x.id === pluginId);
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

    await this.runNpmInstall(plugin.packageSpec);
    const manifestPath = await this.writeInstalledManifest(plugin);

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

  private async readCatalog(): Promise<MarketplaceCatalog> {
    const raw = await readFile(this.marketplacePath, "utf-8");
    const parsed = JSON.parse(raw) as MarketplaceCatalog;
    if (!Array.isArray(parsed.plugins)) {
      throw new Error(`Invalid marketplace catalog: ${this.marketplacePath}`);
    }
    return parsed;
  }

  private async writeInstalledManifest(plugin: PluginMarketplaceItem): Promise<string> {
    const pluginDir = resolve(this.installedDir, plugin.id);
    await mkdir(pluginDir, { recursive: true });
    const manifestFile = resolve(pluginDir, "plugin.json");
    const entryAbsPath = resolve(this.appRoot, "node_modules", plugin.packageName, "dist/hostPlugin.js");
    const entryRelPath = relative(pluginDir, entryAbsPath).split("\\").join("/");
    const resolvedUi = (plugin.ui ?? []).map((extension) => this.resolveUiExtension(plugin, pluginDir, extension));
    const manifest: Record<string, unknown> = {
      id: plugin.id,
      name: plugin.name,
      version: "1.0.0",
      entry: entryRelPath,
      methods: plugin.methods,
      config: plugin.defaultConfig ?? {},
      ui: resolvedUi,
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
    const catalog = await this.readCatalog().catch(() => ({ version: 1, plugins: [] as PluginMarketplaceItem[] }));
    const targetFromCatalog = catalog.plugins.find((x) => x.id === pluginId);
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
    const catalog = await this.readCatalog().catch(() => ({ version: 1, plugins: [] as PluginMarketplaceItem[] }));
    const remaining = new Set(remainingPluginIds);
    return catalog.plugins.some((plugin) => plugin.packageName === packageName && remaining.has(plugin.id));
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

