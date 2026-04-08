import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { readPluginRegistry, writePluginRegistry } from "./registry.js";
import type { PluginMarketplaceItem, PluginUiExtension } from "./types.js";

type MarketplaceCatalog = {
  version: number;
  plugins: PluginMarketplaceItem[];
};

export interface MarketplaceListItem extends PluginMarketplaceItem {
  installed: boolean;
  enabled: boolean;
}

export class PluginMarketplaceService {
  private readonly appRoot: string;
  private readonly registryPath: string;
  private readonly marketplacePath: string;
  private readonly installedDir: string;

  constructor(appRoot: string) {
    this.appRoot = resolve(appRoot);
    this.registryPath = resolve(this.appRoot, "plugins/registry.json");
    this.marketplacePath = resolve(this.appRoot, "plugins/marketplace.json");
    this.installedDir = resolve(this.appRoot, "plugins/installed");
  }

  async list(): Promise<MarketplaceListItem[]> {
    const [catalog, registry] = await Promise.all([this.readCatalog(), readPluginRegistry(this.registryPath)]);
    return catalog.plugins.map((plugin) => {
      const entry = registry.plugins.find((x) => x.id === plugin.id);
      return {
        ...plugin,
        installed: !!entry,
        enabled: entry?.enabled !== false,
      };
    });
  }

  async install(pluginId: string): Promise<{ pluginId: string; installed: true }> {
    const catalog = await this.readCatalog();
    const plugin = catalog.plugins.find((x) => x.id === pluginId);
    if (!plugin) {
      throw new Error(`Plugin not found in marketplace: ${pluginId}`);
    }

    await this.runNpmInstall(plugin.packageSpec);
    const manifestPath = await this.writeInstalledManifest(plugin);
    const registry = await readPluginRegistry(this.registryPath);
    const existing = registry.plugins.find((x) => x.id === plugin.id);
    if (existing) {
      existing.manifestPath = manifestPath;
      existing.enabled = true;
    } else {
      registry.plugins.push({ id: plugin.id, manifestPath, enabled: true });
    }
    await writePluginRegistry(this.registryPath, registry);
    return { pluginId: plugin.id, installed: true };
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
    const manifest = {
      id: plugin.id,
      name: plugin.name,
      version: "1.0.0",
      entry: entryRelPath,
      methods: plugin.methods,
      config: plugin.defaultConfig ?? {},
      ui: resolvedUi,
    };
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
    const registryRelativePath = relative(dirname(this.registryPath), manifestFile).split("\\").join("/");
    return registryRelativePath;
  }

  private resolveUiExtension(
    plugin: PluginMarketplaceItem,
    pluginDir: string,
    extension: PluginUiExtension,
  ): PluginUiExtension {
    if (!extension.page) return extension;
    const pageAbsPath = resolve(this.appRoot, "node_modules", plugin.packageName, extension.page);
    const pageRelPath = relative(pluginDir, pageAbsPath).split("\\").join("/");
    return {
      ...extension,
      page: pageRelPath,
    };
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
}

