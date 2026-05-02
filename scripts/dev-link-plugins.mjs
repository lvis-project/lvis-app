#!/usr/bin/env node
/**
 * dev-link-plugins.mjs — Install dev-built sibling plugins into ~/.lvis/plugins/
 *
 * Trust-boundary convergence (PR #460, supersedes the regression in PR #458):
 *   The plugin runtime's `isTrustedRegistryManifestPath` check resolves
 *   `manifestPath` via `realpathSync()` and rejects anything whose realpath
 *   escapes `pluginsRoot`. Earlier revisions of this script symlinked
 *   `~/.lvis/plugins/<id>/plugin.json` directly at the workspace
 *   `<repo>/plugin.json`; that symlink's realpath escapes pluginsRoot and
 *   the registry entry was correctly filtered with
 *   "ignoring untrusted registry manifest path for <id>".
 *
 *   The convergence rule is: developer installs MUST also live under
 *   `~/.lvis/plugins/<id>/`. We achieve that by copying `plugin.json`
 *   (small, edited rarely) into pluginsRoot as a real file, and keeping
 *   `dist/` as a symlink so plugin build:watch + host LVIS_DEV_RELOAD hot
 *   reload still sees fresh bytes without copy-on-rebuild churn. The
 *   manifest's realpath now stays inside pluginsRoot, so the trust check
 *   passes WITHOUT any dev-link bypass — see snapshots.ts and the
 *   trust-boundary tests for the strict containment rule.
 *
 *   Manifest staleness: re-run `bun run dev:link` (or just `bun run dev`,
 *   which auto-runs this script) after editing the workspace plugin.json.
 *
 * For each lvis-plugin-* sibling repo that has a built dist/:
 *   - Creates ~/.lvis/plugins/<id>/plugin.json  (real file, copied each run)
 *   - Creates ~/.lvis/plugins/<id>/dist/        (symlink → <repo>/dist/)
 *   - Registers in ~/.lvis/plugins/registry.json with installSource:"dev-link"
 *
 * Existing user-installed entries (no _devLinked flag) are preserved.
 * Run after `bun run prepare:plugins` to refresh.
 *
 * Usage: node scripts/dev-link-plugins.mjs [--dry-run] [--force]
 *   --force  Replace real dist/ directories with symlinks (destructive)
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const workspaceRoot = resolve(repoRoot, "..");
// Hardcoded canonical default — must match `resolvePluginPaths()`'s default
// in `src/plugins/plugin-paths.ts`. This script is a .mjs runtime tool that
// runs before any TypeScript compile step, so importing the resolver would
// require either a parallel .mjs constants module or a ts-loader hop. Keeping
// it duplicated with this comment is simpler; if the canonical root ever
// changes in plugin-paths.ts, update this line in lockstep.
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

/**
 * Copy a file into pluginsRoot, replacing any prior file/symlink at the
 * destination. We DON'T allow replacing a real directory (caller error).
 *
 * Why copy instead of symlink: the host's `isTrustedRegistryManifestPath`
 * resolves `realpathSync(manifestPath)` and rejects anything whose realpath
 * escapes `pluginsRoot`. A symlink at `<id>/plugin.json` pointing into the
 * workspace would be filtered as "untrusted registry manifest path" — that
 * is the regression PR #458 tried to paper over by adding a dev-link
 * trust-bypass; the correct fix (per the convergence rule) is to keep the
 * artifact inside pluginsRoot as a real file.
 */
function forceCopy(destPath, srcPath) {
  try {
    const st = lstatSync(destPath);
    if (st.isSymbolicLink() || st.isFile()) {
      unlinkSync(destPath);
    } else if (st.isDirectory()) {
      log(`warn: ${destPath} is a real directory — refusing to overwrite with copy`);
      return false;
    }
  } catch { /* doesn't exist — fine */ }
  copyFileSync(srcPath, destPath);
  return true;
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

// Read existing registry, keep non-devLinked entries (user/marketplace-installed).
// Abort on parse error to avoid silently dropping user-installed entries.
let existingPlugins = [];
if (existsSync(registryPath)) {
  try {
    const reg = JSON.parse(readFileSync(registryPath, "utf-8"));
    existingPlugins = (reg.plugins ?? []).filter(p => p.installSource !== "dev-link" && !p._devLinked);
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

  // Don't clobber a user/marketplace-installed entry with the same id
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
    // plugin.json: copy as a real file. Was previously symlinked back to the
    // workspace manifest, but `realpathSync(<id>/plugin.json)` then escaped
    // pluginsRoot and the trust-root check filtered the entry. Copying
    // converges the install under pluginsRoot (matching the marketplace /
    // user-install layout) and the trust check passes without a dev-link
    // bypass. Re-running `bun run dev:link` (or `bun run dev`) re-syncs.
    const manifestCopy = resolve(installDir, "plugin.json");
    const okManifest = forceCopy(manifestCopy, manifestPath);
    if (!okManifest) {
      log(`skip registry: ${pluginId} (plugin.json copy failed — refusing to clobber a real directory at ${manifestCopy})`);
      continue;
    }
    log(`copied: ${pluginId}  plugin.json ← ${manifestPath}`);
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
    installSource: "dev-link",
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
