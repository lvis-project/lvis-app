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
 * Usage: node scripts/dev-link-plugins.mjs [--dry-run] [--force]
 *   --force  Replace real dist/ directories with symlinks (destructive)
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const workspaceRoot = resolve(repoRoot, "..");
const userPluginsRoot = resolve(homedir(), ".lvis", "plugins");
const registryPath = resolve(userPluginsRoot, "registry.json");
const dryRun = process.argv.includes("--dry-run");
const force = process.argv.includes("--force");
const disabledPluginIds = (process.env.LVIS_DEV_DISABLED_PLUGINS ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);

function log(msg) { console.log(`[dev:link] ${msg}`); }

/** Validate that pluginId is a safe directory name (no path traversal). */
function isSafePluginId(id) {
  return typeof id === "string" && id.length > 0 && /^[a-zA-Z0-9_.\-]+$/.test(id) && !id.includes("..");
}

function forceSymlink(linkPath, target) {
  try {
    const st = lstatSync(linkPath);
    if (st.isSymbolicLink() || st.isFile()) {
      unlinkSync(linkPath);
    } else if (st.isDirectory()) {
      if (!force) {
        log(`warn: ${linkPath} is a real directory — run with --force to replace it`);
        return false;
      }
      rmSync(linkPath, { recursive: true, force: true });
    }
  } catch { /* doesn't exist — fine */ }
  if (process.platform === "win32") symlinkSync(target, linkPath, "junction");
  else symlinkSync(target, linkPath);
  return true;
}

// Read existing registry, keep non-devLinked entries (user-installed).
// Abort on parse error to avoid silently dropping user-installed entries.
let existingPlugins = [];
if (existsSync(registryPath)) {
  try {
    const reg = JSON.parse(readFileSync(registryPath, "utf-8"));
    existingPlugins = (reg.plugins ?? []).filter(p => !p._devLinked);
  } catch (err) {
    log(`error: failed to read or parse registry at ${registryPath} — aborting to avoid data loss`);
    throw err;
  }
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

  // Skip template repos: match only the generated placeholder pattern, not all com.example.*
  const hasTemplatePlaceholderId =
    typeof pluginId === "string" && /^com\.example\.__[A-Z0-9_]+__$/.test(pluginId);
  if (!pluginId || typeof pluginId !== "string" || hasTemplatePlaceholderId) {
    log(`skip: ${repo.name} (template/placeholder id: ${pluginId})`);
    continue;
  }

  // Validate pluginId is a safe directory name (no path traversal)
  if (!isSafePluginId(pluginId)) {
    log(`skip: ${repo.name} (unsafe plugin id: ${pluginId})`);
    continue;
  }

  // Skip plugins explicitly disabled in this dev session
  if (disabledPluginIds.includes(pluginId)) {
    log(`skip: ${pluginId} (disabled by LVIS_DEV_DISABLED_PLUGINS)`);
    continue;
  }

  // Don't clobber a user-installed (non-_devLinked) entry with the same id
  if (existingPlugins.some(p => p.id === pluginId)) {
    log(`skip: ${pluginId} (already user-installed; remove it first to dev-link)`);
    continue;
  }

  if (typeof manifest.entry !== "string" || !manifest.entry) {
    log(`skip: ${pluginId} (manifest.entry missing or not a string)`);
    continue;
  }
  const entryRelative = manifest.entry;
  const builtEntry = resolve(pluginRepoDir, entryRelative);
  if (!existsSync(builtEntry)) { log(`skip: ${pluginId} (not built: ${entryRelative})`); continue; }

  const installDir = resolve(userPluginsRoot, pluginId);
  const distTarget = resolve(pluginRepoDir, "dist");
  const distLink = resolve(installDir, "dist");

  if (!dryRun) {
    mkdirSync(installDir, { recursive: true });
    // Write real plugin.json (entry stays as declared in manifest)
    writeFileSync(resolve(installDir, "plugin.json"), JSON.stringify(manifest, null, 2) + "\n", "utf-8");
    // Symlink dist/ directory — skip registration when symlink cannot be created
    if (existsSync(distTarget)) {
      const ok = forceSymlink(distLink, distTarget);
      if (ok) log(`linked: ${pluginId}  dist/ → ${distTarget}`);
      else { log(`skip registry: ${pluginId} (dist/ symlink failed — run with --force to replace real dir)`); continue; }
    } else {
      log(`warn: ${pluginId} dist/ not found at ${distTarget} — skipping registration`);
      continue;
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
