



import { resolve } from "node:path";
import { lvisHome } from "../shared/lvis-home.js";

export interface PluginPaths {
  /** Absolute path to `registry.json` — sits at the root of `pluginsRoot`. */
  registryPath: string;
  /**
   * Directory where every plugin lives — `<pluginsRoot>/<id>/plugin.json`.
   * `installSource` is metadata only; admin / user / local-dev entries
   * all share this root (no physical user/managed split).
   */
  pluginsRoot: string;
  /** Per-plugin version cache for rollback (§9.6). */
  cacheRoot: string;
}

export interface ResolvePluginPathsInput {
  /**
   * Override for the plugins root. When omitted, defaults to
   * `lvisHome()/plugins`.
   *
   * Tests use this for sandbox isolation. There is no env fallback —
   * if an override is needed, callers must pass it explicitly.
   */
  pluginsRoot?: string;
  /** Optional cache root override. Defaults to `<pluginsRoot>/.cache`. */
  cacheRoot?: string;
}

/**
 * Resolve the plugin path layout.
 *
 * Final shape:
 *   - `lvisHome()/plugins/registry.json`
 *   - `lvisHome()/plugins/<id>/plugin.json`
 *   - `lvisHome()/plugins/.cache/`
 *
 * Override is via the `pluginsRoot` argument only (constructor injection).
 * By design `registryPath` is always `pluginsRoot/registry.json` so registry
 * entries can hold paths relative to `dirname(registryPath)`.
 */
export function resolvePluginPaths(input: ResolvePluginPathsInput = {}): PluginPaths {
  const pluginsRoot = resolve(
    input.pluginsRoot ?? resolve(lvisHome(), "plugins"),
  );
  const cacheRoot = resolve(input.cacheRoot ?? resolve(pluginsRoot, ".cache"));
  return {
    registryPath: resolve(pluginsRoot, "registry.json"),
    pluginsRoot,
    cacheRoot,
  };
}

/**
 * Normalize a `manifestPath` registry entry value into the registry-relative
 * form every install writes. POSIX-style separators.
 *
 * Behaviour:
 *  - input may be absolute or relative to `dirname(registryPath)`
 *  - returns POSIX-separated relative path when the manifest lives under
 *    the registry's directory tree (the only valid shape)
 *  - returns the absolute path with POSIX separators otherwise — runtime
 *    will reject those entries via the trust-root check
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
