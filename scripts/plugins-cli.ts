import { readPluginRegistry } from "../src/plugins/registry.js";
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
      "",
      "Note: 'install' is no longer offered here — installs flow through the",
      "marketplace API (Settings UI, lvis://install/<slug>, or the managed",
      "bootstrap). For local development, use Settings > Plugin Config > Developer tools",
      "> Install from local folder and select the build folder containing plugin.json.",
      "Direct registry mutations are intentionally unsupported: use the running host UI/API",
      "so durable registry state and live plugin state cannot diverge.",
      "",
      "Optional:",
      "  --plugins-root <path>   Override the canonical ~/.lvis/plugins/ root",
    ].join("\n"),
  );
}

async function run() {
  const command = cliArgs[0];
  if (!command) usage();

  if (["add", "remove", "enable", "disable"].includes(command)) {
    throw new Error(
      `Direct plugin registry mutation '${command}' is disabled; use the running LVIS host UI/API`,
    );
  }

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

  usage();
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
