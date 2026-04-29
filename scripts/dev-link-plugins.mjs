#!/usr/bin/env node
/**
 * dev-link-plugins.mjs — Install dev-built sibling plugins into ~/.lvis/plugins/
 *
 * For each lvis-plugin-* sibling repo that has a built dist/:
 *   - Creates ~/.lvis/plugins/<id>/plugin.json  (real file, entry untouched)
 *   - Creates ~/.lvis/plugins/<id>/dist/        (symlink → <repo>/dist/)
 *   - Registers in ~/.lvis/plugins/registry.json with _devLinked: true
 *
 * Existing user-installed entries (no _devLinked flag) are preserved.
 * Run after `bun run prepare:plugins` to refresh.
 *
 * Usage: node scripts/dev-link-plugins.mjs [--dry-run]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, unlinkSync, readdirSync } from "node:fs";
import { lstatSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const workspaceRoot = resolve(repoRoot, "..");
const userPluginsRoot = resolve(homedir(), ".lvis", "plugins");
const registryPath = resolve(userPluginsRoot, "registry.json");
const dryRun = process.argv.includes("--dry-run");

function log(msg) { console.log(`[dev:link] ${msg}`); }

function forceSymlink(linkPath, target) {
  try {
    const st = lstatSync(linkPath);
    if (st.isSymbolicLink() || st.isFile()) unlinkSync(linkPath);
    else { log(`warn: ${linkPath} is a real directory, skipping`); return false; }
  } catch { /* doesn't exist — fine */ }
  symlinkSync(target, linkPath);
  return true;
}

// Read existing registry, keep non-devLinked entries (user-installed)
let existingPlugins = [];
if (existsSync(registryPath)) {
  try {
    const reg = JSON.parse(readFileSync(registryPath, "utf-8"));
    existingPlugins = (reg.plugins ?? []).filter(p => !p._devLinked);
  } catch {}
}

const devPlugins = [];
const repos = readdirSync(workspaceRoot, { withFileTypes: true })
  .filter(e => e.isDirectory() && e.name.startsWith("lvis-plugin-"));

for (const repo of repos) {
  const pluginRepoDir = resolve(workspaceRoot, repo.name);
  const manifestPath = resolve(pluginRepoDir, "plugin.json");
  if (!existsSync(manifestPath)) continue;

  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, "utf-8")); }
  catch (e) { log(`skip: ${repo.name} (parse error: ${e.message})`); continue; }

  const pluginId = manifest.id;
  // Skip template repos (placeholder IDs like com.example.*)
  if (!pluginId || typeof pluginId !== "string" || pluginId.startsWith("com.example.")) {
    log(`skip: ${repo.name} (template/placeholder id: ${pluginId})`);
    continue;
  }

  const entryRelative = typeof manifest.entry === "string" ? manifest.entry : "dist/hostPlugin.js";
  const builtEntry = resolve(pluginRepoDir, entryRelative);
  if (!existsSync(builtEntry)) { log(`skip: ${pluginId} (not built: ${entryRelative})`); continue; }

  const installDir = resolve(userPluginsRoot, pluginId);
  const distTarget = resolve(pluginRepoDir, "dist");
  const distLink = resolve(installDir, "dist");

  if (!dryRun) {
    mkdirSync(installDir, { recursive: true });
    // Write real plugin.json (entry stays as "dist/hostPlugin.js")
    writeFileSync(resolve(installDir, "plugin.json"), JSON.stringify(manifest, null, 2) + "\n", "utf-8");
    // Symlink dist/ directory
    if (existsSync(distTarget)) {
      const ok = forceSymlink(distLink, distTarget);
      if (ok) log(`linked: ${pluginId}  dist/ → ${distTarget}`);
    } else {
      log(`warn: ${pluginId} dist/ not found at ${distTarget}`);
    }
  }

  devPlugins.push({
    id: pluginId,
    manifestPath: `${pluginId}/plugin.json`,
    enabled: true,
    installedBy: manifest.installPolicy === "admin" ? "admin" : "user",
    _devLinked: true,
    ...(manifest.pluginAccess ? { approvedPluginAccess: manifest.pluginAccess } : {}),
  });
  log(`${dryRun ? "[dry-run] " : ""}registered: ${pluginId}`);
}

if (!dryRun) {
  mkdirSync(userPluginsRoot, { recursive: true });
  writeFileSync(registryPath, JSON.stringify({ version: 1, plugins: [...existingPlugins, ...devPlugins] }, null, 2) + "\n", "utf-8");
}
log(`done: ${devPlugins.length} dev plugin(s) ${dryRun ? "would be" : ""} installed into ${userPluginsRoot}`);
