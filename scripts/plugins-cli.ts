import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readPluginRegistry,
  writePluginRegistry,
} from "../src/plugins/registry.js";
import { MockMarketplaceFetcher, PluginMarketplaceService } from "../src/plugins/marketplace.js";
import { resolvePluginPaths } from "../src/plugins/plugin-paths.js";
import { setIsPackaged } from "../src/boot/dev-flags.js";
import type { PluginRegistry } from "../src/plugins/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, "..");
// CLI is a dev-only tool — flip the dev-flag gate so resolvePluginPaths()
// honors `LVIS_PLUGINS_DIR` env override (test/portable installs). Without
// the override, defaults to `~/.lvis/plugins/` — same as the Electron host
// because both share the user-anchored plugin root.
setIsPackaged(false);
const pluginPaths = resolvePluginPaths();
const registryPath = pluginPaths.registryPath;

function usage(): never {
  throw new Error(
    [
      "Usage:",
      "  npm run plugins:list",
      "  npm run plugins:install -- <plugin-id>",
      "  npm run plugins:add -- <plugin-id> <manifest-path>",
      "  npm run plugins:remove -- <plugin-id>",
      "  npm run plugins:enable -- <plugin-id>",
      "  npm run plugins:disable -- <plugin-id>",
    ].join("\n"),
  );
}

async function loadRegistry(): Promise<PluginRegistry> {
  try {
    return await readPluginRegistry(registryPath);
  } catch {
    const initial: PluginRegistry = { version: 1, plugins: [] };
    await writePluginRegistry(registryPath, initial);
    return initial;
  }
}

async function saveRegistry(registry: PluginRegistry): Promise<void> {
  registry.plugins.sort((a, b) => a.id.localeCompare(b.id));
  await writePluginRegistry(registryPath, registry);
}

async function run() {
  const command = process.argv[2];
  if (!command) usage();
  if (command === "install") {
    const id = process.argv[3];
    if (!id) usage();
    const fetcher = new MockMarketplaceFetcher(
      resolve(projectRoot, "plugins/marketplace.json"),
    );
    const marketplace = new PluginMarketplaceService(pluginPaths, fetcher);
    await marketplace.install(id);
    console.log(`Installed plugin '${id}' from marketplace`);
    return;
  }

  const registry = await loadRegistry();

  if (command === "list") {
    const rows = registry.plugins.map((plugin) => ({
      id: plugin.id,
      enabled: plugin.enabled !== false,
      manifestPath: plugin.manifestPath,
    }));
    console.log(JSON.stringify({ registryPath, plugins: rows }, null, 2));
    return;
  }

  if (command === "add") {
    const id = process.argv[3];
    const manifestPath = process.argv[4];
    if (!id || !manifestPath) usage();
    if (registry.plugins.some((plugin) => plugin.id === id)) {
      throw new Error(`Plugin already exists: ${id}`);
    }

    const absoluteManifestPath = resolve(dirname(registryPath), manifestPath);
    await access(absoluteManifestPath);
    registry.plugins.push({ id, manifestPath, enabled: true });
    await saveRegistry(registry);
    console.log(`Added plugin '${id}' -> ${manifestPath}`);
    return;
  }

  if (command === "remove") {
    const id = process.argv[3];
    if (!id) usage();
    const before = registry.plugins.length;
    registry.plugins = registry.plugins.filter((plugin) => plugin.id !== id);
    if (registry.plugins.length === before) {
      throw new Error(`Plugin not found: ${id}`);
    }
    await saveRegistry(registry);
    console.log(`Removed plugin '${id}'`);
    return;
  }

  if (command === "enable" || command === "disable") {
    const id = process.argv[3];
    if (!id) usage();
    const target = registry.plugins.find((plugin) => plugin.id === id);
    if (!target) {
      throw new Error(`Plugin not found: ${id}`);
    }
    target.enabled = command === "enable";
    await saveRegistry(registry);
    console.log(`${command === "enable" ? "Enabled" : "Disabled"} plugin '${id}'`);
    return;
  }

  usage();
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

