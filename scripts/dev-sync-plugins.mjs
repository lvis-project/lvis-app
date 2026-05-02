#!/usr/bin/env node
/**
 * dev-sync-plugins.mjs — Sync dev-built sibling plugins into ~/.lvis/plugins/
 * as REAL files (no symlinks). Replaces the legacy dev-link workflow.
 *
 * Why this is the only dev path:
 *   The runtime trust boundary (`isTrustedRegistryManifestPath` in
 *   src/plugins/runtime/snapshots.ts) requires `realpathSync(manifestPath)`
 *   to be contained under `realpathSync(pluginsRoot)`. The old
 *   dev-link-plugins.mjs symlinked plugin.json/dist back to the workspace
 *   so realpath escaped the trust root, and registry entries got silently
 *   filtered. Copying real files keeps every plugin physically inside
 *   `~/.lvis/plugins/<id>/` so the same hardening that protects packaged
 *   builds also applies cleanly in dev. There is no trust-boundary bypass
 *   for dev installs — see PR #458 (superseded) for the rejected approach.
 *
 * For each lvis-plugin-* sibling repo that has a built dist/:
 *   - Removes any pre-existing symlinks (legacy state from dev-link).
 *   - Copies <repo>/plugin.json   → ~/.lvis/plugins/<id>/plugin.json   (real file)
 *   - Copies <repo>/dist/         → ~/.lvis/plugins/<id>/dist/         (real dir)
 *   - Copies <repo>/node_modules/ → ~/.lvis/plugins/<id>/node_modules/ (filtered)
 *     (skips electron / @electron / .bin / .git — same filter
 *      as marketplace installLocal in src/plugins/sideload-filter.ts).
 *      Any symlinked dependencies are dereferenced during copy so the
 *      runtime install tree stays real-file only.
 *   - Registers in ~/.lvis/plugins/registry.json with `installSource: "dev"`.
 *     The literal "dev" is the single registry signal that this entry was
 *     placed by the dev-sync workflow and is allowed to skip the
 *     install-receipt check ONLY when `devLinkedEntryAllowed()` is true
 *     (dev mode + non-packaged build). The trust-boundary check still runs.
 *     The legacy boolean `_devLinked` flag is no longer honored as a
 *     trust-bypass signal; only `installSource: "dev"` is.
 *
 * Existing non-dev entries are preserved. If a preserved entry still carries
 * the legacy cleanup-only `_devLinked` flag, dev-sync strips it while keeping
 * the authoritative non-dev `installSource`.
 *
 * Usage: node scripts/dev-sync-plugins.mjs [--dry-run]
 */
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, relative, resolve } from "node:path";
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
const disabledPluginIds = (process.env.LVIS_DEV_DISABLED_PLUGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function log(msg) {
  console.log(`[dev:sync] ${msg}`);
}

/** Validate that pluginId is a safe directory name (no path traversal). */
export function isSafePluginId(id) {
  if (typeof id !== "string") return false;
  // Registry/install paths are derived directly from pluginId, so require a
  // canonical single-line token: no empty/trimmed variants, no "."/"..", no
  // path separators, and only the separators used by existing plugin ids.
  if (id !== id.trim() || id.length === 0) return false;
  if (id === "." || id === "..") return false;
  if (/[\\/]/.test(id)) return false;
  return /^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/.test(id);
}

/**
 * Mirror of `buildSideloadCopyFilter` in src/plugins/sideload-filter.ts.
 * Skips trees hostile to recursive copy (Electron's bundled asar archives,
 * .bin symlinks) and unwanted metadata. Keeping this in sync with the TS
 * filter is important: dev-synced plugins must look the same on disk as
 * a marketplace `installLocal` would have produced.
 *
 * The filter is built relative to the plugin **repo root**, not the
 * `node_modules/` directory. When `cpSync(node_modules → dest)` runs, the
 * filter sees absolute paths under `<repo>/node_modules/...`; computing
 * `relative(repoRoot, src)` yields `node_modules/<pkg>/...` so the check
 * for `electron`/`@electron`/`.bin` immediately after `node_modules` works.
 * (Earlier the filter was constructed with `nodeModulesSrc` as the root,
 * which made the relative path start at the package name and the
 * `node_modules` segment was never seen — exclusions silently no-op'd.)
 */
export function buildCopyFilter(sourceRoot) {
  return (src) => {
    const rel = relative(sourceRoot, src);
    if (!rel) return true;
    const parts = rel.split(/[\\/]/);
    if (parts[0] === ".git") return false;
    // Two valid call shapes:
    //   1. sourceRoot = repoRoot          → parts = ["node_modules", "<pkg>", ...]
    //   2. sourceRoot = node_modules root → parts = ["<pkg>", ...]
    // Handle both so the filter is robust regardless of how the caller wires it.
    let nmIdx = parts.indexOf("node_modules");
    let pkgIdx = nmIdx >= 0 ? nmIdx + 1 : 0;
    const pkg = parts[pkgIdx];
    if (pkg === "electron" || pkg === "@electron" || pkg === ".bin") return false;
    return true;
  };
}

/**
 * Remove `target` whether it is a symlink (legacy dev-link state), file,
 * or real directory. Used to wipe the install path before copying real
 * files so a half-migrated user does not end up with a mix of symlinks
 * and real files. Idempotent.
 */
export function removeAny(target) {
  let st;
  try {
    st = lstatSync(target);
  } catch {
    return; // doesn't exist — nothing to do
  }
  if (st.isSymbolicLink() || st.isFile()) {
    rmSync(target, { force: true });
    return;
  }
  if (st.isDirectory()) {
    rmSync(target, { recursive: true, force: true });
  }
}

export function isDevRegistryEntry(entry) {
  return (
    entry?.installSource === "dev" ||
    entry?.installSource === "dev-link" ||
    (entry?._devLinked === true && entry?.installSource === undefined)
  );
}

export function normalizePreservedNonDevRegistryEntry(entry) {
  if (isDevRegistryEntry(entry)) {
    return null;
  }
  const preserved = { ...entry };
  // `_devLinked` is a cleanup-only legacy hint. When a non-dev entry still
  // carries it, strip it here so later consumers don't misclassify the entry.
  delete preserved._devLinked;
  return preserved;
}

// Read existing registry, keep non-dev entries (user/marketplace-installed).
// Abort on parse error to avoid silently dropping user-installed entries.
export function loadExistingNonDevPlugins() {
  if (!existsSync(registryPath)) return [];
  try {
    const reg = JSON.parse(readFileSync(registryPath, "utf-8"));
    return (reg.plugins ?? [])
      .map((entry) => normalizePreservedNonDevRegistryEntry(entry))
      .filter(Boolean);
  } catch (err) {
    log(
      `error: failed to read or parse registry at ${registryPath} — aborting to avoid data loss`,
    );
    throw err;
  }
}

/**
 * If `installDir` itself is a symlink (legacy `~/.lvis/plugins/<id> -> <workspace>`
 * dev-link layout), unlink the symlink so subsequent child-path deletions
 * (`removeAny(distDest)` etc.) operate on a fresh empty install dir, NOT
 * inside the developer's workspace. Real directories are left untouched —
 * the caller will then call removeAny on individual children to preserve
 * sibling artifacts (e.g. plugin data) that live alongside dist/plugin.json.
 *
 * Returns true when a legacy symlink was unlinked.
 */
export function neutralizeLegacyInstallDirSymlink(installDir) {
  let st;
  try {
    st = lstatSync(installDir);
  } catch {
    return false;
  }
  if (st.isSymbolicLink()) {
    rmSync(installDir, { force: true });
    return true;
  }
  return false;
}

export function buildDevRegistryEntry(pluginId, manifest) {
  return {
    id: pluginId,
    // Registry-relative manifest path — same shape as marketplace installs.
    // dirname(registryPath) === userPluginsRoot, so the runtime resolves
    // this to <userPluginsRoot>/<id>/plugin.json, whose realpath stays
    // contained under realpath(pluginsRoot). No symlink escape.
    manifestPath: `${pluginId}/plugin.json`,
    enabled: true,
    // installSource:"dev" is the single registry signal that the
    // install-receipt check may be skipped — but ONLY when
    // `devLinkedEntryAllowed()` is true (LVIS_DEV=1 + non-packaged build,
    // see src/boot/dev-flags.ts). The trust-boundary check is NOT
    // bypassed by this flag in any build. The legacy `_devLinked`
    // boolean is no longer written and is no longer honored as a
    // trust-bypass signal anywhere in the runtime.
    installSource: "dev",
    ...(manifest.pluginAccess
      ? { approvedPluginAccess: manifest.pluginAccess }
      : {}),
  };
}

/**
 * Materialise `src` at `dest` as a real file even when the source manifest is
 * itself a symlink in the developer workspace. dev:sync's contract is "real
 * files under ~/.lvis/plugins" — leaving a symlinked plugin.json behind would
 * reintroduce the legacy trust-boundary escape.
 */
export function copyFileAsRealFile(src, dest) {
  writeFileSync(dest, readFileSync(src));
}

export function syncDevPlugins() {
  const existingPlugins = loadExistingNonDevPlugins();
  const devPlugins = [];
  const repos = readdirSync(workspaceRoot, { withFileTypes: true }).filter(
    (e) => e.isDirectory() && e.name.startsWith("lvis-plugin-"),
  );

  for (const repo of repos) {
    const pluginRepoDir = resolve(workspaceRoot, repo.name);
    const manifestSrc = resolve(pluginRepoDir, "plugin.json");
    if (!existsSync(manifestSrc)) continue;

    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestSrc, "utf-8"));
    } catch (e) {
      log(`skip: ${repo.name} (parse error: ${e.message})`);
      continue;
    }

    const pluginId = manifest.id;

    // Skip template repos: match only the generated placeholder pattern, not all com.example.*
    const hasTemplatePlaceholderId =
      typeof pluginId === "string" && /^com\.example\.__[A-Z0-9_]+__$/.test(pluginId);
    if (!pluginId || typeof pluginId !== "string" || hasTemplatePlaceholderId) {
      log(`skip: ${repo.name} (template/placeholder id: ${pluginId})`);
      continue;
    }

    if (!isSafePluginId(pluginId)) {
      log(`skip: ${repo.name} (unsafe plugin id: ${pluginId})`);
      continue;
    }

    if (disabledPluginIds.includes(pluginId)) {
      log(`skip: ${pluginId} (disabled by LVIS_DEV_DISABLED_PLUGINS)`);
      continue;
    }

    // Don't clobber a user/marketplace-installed entry with the same id.
    if (existingPlugins.some((p) => p.id === pluginId)) {
      log(`skip: ${pluginId} (already user-installed; remove it first to dev-sync)`);
      continue;
    }

    if (typeof manifest.entry !== "string" || !manifest.entry) {
      log(`skip: ${pluginId} (manifest.entry missing or not a string)`);
      continue;
    }
    const entryRelative = manifest.entry;
    const builtEntry = resolve(pluginRepoDir, entryRelative);
    if (!existsSync(builtEntry)) {
      log(`skip: ${pluginId} (not built: ${entryRelative})`);
      continue;
    }

    const installDir = resolve(userPluginsRoot, pluginId);
    const distSrc = resolve(pluginRepoDir, "dist");
    const distDest = resolve(installDir, "dist");
    const manifestDest = resolve(installDir, "plugin.json");
    const nodeModulesSrc = resolve(pluginRepoDir, "node_modules");
    const nodeModulesDest = resolve(installDir, "node_modules");

    if (!existsSync(distSrc)) {
      log(`warn: ${pluginId} dist/ not found at ${distSrc} — skipping registration`);
      continue;
    }

    if (!dryRun) {
      // CRITICAL: Before removing any *child* path under installDir, detect
      // and unlink a legacy symlinked installDir. Without this guard, if a
      // user is migrating from the old `~/.lvis/plugins/<id> -> <workspace>`
      // dev-link layout, `removeAny(distDest)` would resolve through the
      // symlink and recursively delete `<workspace>/dist`, destroying the
      // developer's repo contents. After unlinking the symlink we recreate
      // an empty real directory so subsequent cpSync targets a clean dir.
      const wasLegacySymlink = neutralizeLegacyInstallDirSymlink(installDir);
      if (wasLegacySymlink) {
        log(`migrate: ${pluginId} unlinked legacy symlinked installDir`);
      }
      mkdirSync(installDir, { recursive: true });
      // Wipe any pre-existing entries (legacy symlinks or stale real files) so
      // the install path is a clean copy of the workspace artifacts. Only
      // child paths the script writes are removed — sibling files such as
      // plugin data directories under installDir are preserved.
      removeAny(manifestDest);
      removeAny(distDest);
      removeAny(nodeModulesDest);

      copyFileAsRealFile(manifestSrc, manifestDest);
      log(`synced: ${pluginId}  plugin.json (real file)`);
      cpSync(distSrc, distDest, { recursive: true, dereference: true });
      log(`synced: ${pluginId}  dist/ (${countEntries(distDest)} entries)`);
      if (existsSync(nodeModulesSrc)) {
        cpSync(nodeModulesSrc, nodeModulesDest, {
          recursive: true,
          // Materialise any package-manager symlinks as real files/dirs inside
          // the install tree. This keeps dev-sync output aligned with the
          // "real files under ~/.lvis/plugins/<id>" contract and avoids leaving
          // runtime-visible symlinks behind in node_modules.
          dereference: true,
          // Build the filter against the plugin **repo root** so the
          // relative path includes the literal `node_modules` segment,
          // making the electron/@electron/.bin exclusions actually fire.
          filter: buildCopyFilter(pluginRepoDir),
        });
        log(`synced: ${pluginId}  node_modules/ (filtered)`);
      }
    }

    devPlugins.push(buildDevRegistryEntry(pluginId, manifest));
    log(`${dryRun ? "[dry-run] " : ""}registered: ${pluginId}`);
  }

  if (!dryRun) {
    mkdirSync(userPluginsRoot, { recursive: true });
    writeFileSync(
      registryPath,
      JSON.stringify(
        { version: 1, plugins: [...existingPlugins, ...devPlugins] },
        null,
        2,
      ) + "\n",
      "utf-8",
    );
  }
  log(
    `done: ${devPlugins.length} dev plugin(s) ${
      dryRun ? "would be" : ""
    } synced into ${userPluginsRoot}`,
  );
  return devPlugins;
}

export function countEntries(dir) {
  try {
    return countEntriesRecursive(dir);
  } catch {
    return 0;
  }
}

function countEntriesRecursive(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    total += 1;
    if (entry.isDirectory()) {
      total += countEntriesRecursive(resolve(dir, entry.name));
    }
  }
  return total;
}

// Run only when invoked as a script (`node scripts/dev-sync-plugins.mjs`).
// Guarding lets vitest import the helpers above without firing the workspace
// scan / registry rewrite as a side effect of `import`.
const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  syncDevPlugins();
}
