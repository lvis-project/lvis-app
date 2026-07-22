import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  readPluginRegistry,
  updatePluginRegistry,
} from "../src/plugins/registry.js";
import { resolvePluginPaths } from "../src/plugins/plugin-paths.js";

// Round-3: env-tier override removed. Use the explicit `--plugins-root <path>`
// flag for portable installs / CI sandbox isolation. Default is
// `~/.lvis/plugins/` — same as the Electron host (single source of truth).
function extractPluginsRootFlag(argv: string[]): { pluginsRoot?: string; rest: string[] } {
  const rest: string[] = [];
  let pluginsRoot: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--plugins-root") {
      const value = argv[i + 1];
      if (typeof value !== "string" || value.length === 0) {
        throw new Error("--plugins-root requires a path argument");
      }
      pluginsRoot = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--plugins-root=")) {
      const value = arg.slice("--plugins-root=".length);
      if (value.length === 0) {
        throw new Error("--plugins-root requires a path argument");
      }
      pluginsRoot = value;
      continue;
    }
    rest.push(arg);
  }
  return { pluginsRoot, rest };
}

const { pluginsRoot, rest: cliArgs } = extractPluginsRootFlag(process.argv.slice(2));
const pluginPaths = resolvePluginPaths(pluginsRoot ? { pluginsRoot } : {});
const registryPath = pluginPaths.registryPath;

function usage(): never {
  throw new Error(
    [
      "Usage:",
      "  bun run plugins:list",
      "  bun run plugins:add <plugin-id> <manifest-path>",
      "  bun run plugins:remove <plugin-id>",
      "  bun run plugins:enable <plugin-id>",
      "  bun run plugins:disable <plugin-id>",
      "",
      "Note: 'install' is no longer offered here — installs flow through the",
      "marketplace API (Settings UI, lvis://install/<slug>, or the managed",
      "bootstrap). Local sibling-repo dev installs use 'lvis-cli install file://<path-to-dist.zip>'.",
      "",
      "Optional:",
      "  --plugins-root <path>   Override the canonical ~/.lvis/plugins/ root",
    ].join("\n"),
  );
}

async function run() {
  const command = cliArgs[0];
  if (!command) usage();

  if (command === "list") {
    const registry = await readPluginRegistry(registryPath);
    const rows = registry.plugins.map((plugin) => ({
      id: plugin.id,
      enabled: plugin.enabled !== false,
      manifestPath: plugin.manifestPath,
    }));
    console.log(JSON.stringify({ registryPath, plugins: rows }, null, 2));
    return;
  }

  if (command === "add") {
    const id = cliArgs[1];
    const manifestPath = cliArgs[2];
    if (!id || !manifestPath) usage();
    const absoluteManifestPath = resolve(dirname(registryPath), manifestPath);
    await access(absoluteManifestPath);
    await updatePluginRegistry(registryPath, (registry) => {
      if (registry.plugins.some((plugin) => plugin.id === id)) {
        throw new Error(`Plugin already exists: ${id}`);
      }
      registry.plugins.push({ id, manifestPath, enabled: true });
    });
    console.log(`Added plugin '${id}' -> ${manifestPath}`);
    return;
  }

  if (command === "remove") {
    const id = cliArgs[1];
    if (!id) usage();
    await updatePluginRegistry(registryPath, (registry) => {
      const before = registry.plugins.length;
      registry.plugins = registry.plugins.filter((plugin) => plugin.id !== id);
      if (registry.plugins.length === before) {
        throw new Error(`Plugin not found: ${id}`);
      }
    });
    console.log(`Removed plugin '${id}'`);
    return;
  }

  if (command === "enable" || command === "disable") {
    const id = cliArgs[1];
    if (!id) usage();
    await updatePluginRegistry(registryPath, (registry) => {
      const target = registry.plugins.find((plugin) => plugin.id === id);
      if (!target) {
        throw new Error(`Plugin not found: ${id}`);
      }
      target.enabled = command === "enable";
    });
    console.log(`${command === "enable" ? "Enabled" : "Disabled"} plugin '${id}'`);
    return;
  }

  usage();
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
