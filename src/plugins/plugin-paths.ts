/**
 * Plugin path single source of truth — Phase 2a layout.
 *
 * The path layout for managed and user-installed plugins is anchored at
 * `app.getPath('userData')/plugins/`. There is no fallback to
 * `<appRoot>/plugins/` — that location is being retired entirely (Phase 2e
 * deletes it from the repo). The Phase 0 transitional resolver had three
 * separate path roots (appRoot for registry/marketplace, homedir for user
 * installs); Phase 2a collapses them to one.
 *
 * **Status: in-development (Phase 2a of 2a-2e migration). Not for legacy
 * compatibility.** The resolver only emits the new layout. Reading the old
 * `<appRoot>/plugins/registry.json` is the responsibility of the Phase 2c
 * migration shim (one-shot, idempotent, not a permanent fallback).
 *
 * Why required `userDataDir`:
 *  - The previous resolver defaulted `userInstalledDir` to
 *    `homedir()/.lvis/plugins`. Electron's canonical answer is
 *    `app.getPath('userData')` — `%APPDATA%/lvis`, `~/Library/Application
 *    Support/lvis`, `~/.config/lvis`. Forcing the caller to supply this
 *    keeps the resolver testable (vitest passes a tmpdir) without leaking
 *    Electron into this module.
 *
 * Marketplace catalog:
 *  - Production catalog is the marketplace server (single source of truth).
 *    LVIS no longer ships a local `marketplace.json`; the field is removed
 *    from `PluginPaths` and dev's `MockMarketplaceFetcher` takes its path
 *    argument directly from boot wiring.
 *
 * Override hooks:
 *  - `LVIS_PLUGINS_DIR` env — points the user-installed dir at an arbitrary
 *    location. Used by tests, portable installs, and CI sandbox isolation.
 *
 * Electron is intentionally NOT imported here so this module remains
 * unit-testable in node (vitest) without an electron stub. Boot wires
 * `app.getPath('userData')` in.
 */
import { resolve } from "node:path";

export interface PluginPaths {
  /** Absolute path to `registry.json` (under userInstalledDir). */
  registryPath: string;
  /** Directory where managed + user-installed plugin manifests + bundles live. */
  userInstalledDir: string;
  /** Per-plugin version cache for rollback (Sprint 3-B §9.6). */
  cacheRoot: string;
}

export interface ResolvePluginPathsInput {
  /**
   * Electron `app.getPath('userData')` — required. Tests pass a tmpdir.
   * No default; callers that don't have a userDataDir don't have a layout.
   */
  userDataDir: string;
  /**
   * Override for the user-installed directory. When omitted, falls back to
   * `LVIS_PLUGINS_DIR` env var, then to `userDataDir/plugins`.
   *
   * Tests and portable installs use this to redirect away from the real
   * userData location.
   */
  userInstalledDir?: string;
  /** Optional cache root override. Defaults to a sibling of userInstalledDir. */
  cacheRoot?: string;
}

/**
 * Resolve the plugin path layout.
 *
 * Phase 2a layout (final shape):
 *   - `userDataDir/plugins/registry.json`
 *   - `userDataDir/plugins/<id>/plugin.json`
 *   - `userDataDir/plugins/.cache/`
 *
 * `LVIS_PLUGINS_DIR` env (when set) overrides `userInstalledDir` and the
 * derived registry/cache. By design `registryPath` is always
 * `userInstalledDir/registry.json` so registry entries can hold paths
 * relative to `dirname(registryPath)`.
 */
export function resolvePluginPaths(input: ResolvePluginPathsInput): PluginPaths {
  if (!input.userDataDir) {
    throw new Error("resolvePluginPaths: userDataDir is required");
  }
  const envOverride = process.env.LVIS_PLUGINS_DIR;
  const userInstalledDir = resolve(
    input.userInstalledDir ?? envOverride ?? resolve(input.userDataDir, "plugins"),
  );
  const cacheRoot = resolve(input.cacheRoot ?? resolve(userInstalledDir, ".cache"));
  return {
    registryPath: resolve(userInstalledDir, "registry.json"),
    userInstalledDir,
    cacheRoot,
  };
}

/**
 * Normalize a `manifestPath` registry entry value into the registry-relative
 * form Phase 2a writes for every new install. POSIX-style separators.
 *
 * Why a helper: the Phase 2c migration shim runs this against legacy
 * absolute and `installed/<id>/...` style paths from old `<appRoot>/plugins/
 * registry.json` so they all collapse to `<id>/plugin.json`-style entries
 * before being written into the new userData registry.
 *
 * Behaviour:
 *  - input may be absolute or relative to `dirname(registryPath)`
 *  - returns POSIX-separated relative path when the manifest lives under
 *    the registry's directory tree (the only valid Phase 2a shape)
 *  - returns the absolute path with POSIX separators otherwise — the
 *    migration shim will reject those entries; production install paths
 *    must always be under userInstalledDir
 */
export function toRegistryRelativeManifestPath(
  registryPath: string,
  manifestPath: string,
): string {
  const registryDir = resolve(registryPath, "..");
  const absolute = resolve(registryDir, manifestPath);
  if (!absolute.startsWith(registryDir + "\\") && !absolute.startsWith(registryDir + "/") && absolute !== registryDir) {
    return absolute.split("\\").join("/");
  }
  const rel = absolute.slice(registryDir.length).replace(/^[\\/]+/, "");
  return rel.split("\\").join("/");
}
