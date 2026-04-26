/**
 * Plugin path single source of truth (Phase 0 of the path-migration plan).
 *
 * Currently the plugin filesystem layout is hardcoded across `marketplace.ts`,
 * `boot/steps/plugin-runtime.ts`, and `boot/steps/post-boot.ts` with the same
 * `homedir()` / `resolve(projectRoot, "plugins/...")` literals duplicated three
 * times. That duplication blocks:
 *
 *  - Phase 1 (security): widening the registry trust gate to a second root.
 *  - Phase 2 (path split): moving managed plugins into app resources and
 *    user installs into `app.getPath('userData')`.
 *  - Phase 4 (tests): injecting a tmp-dir installedDir without polluting the
 *    real user `~/.lvis/`.
 *
 * This module consolidates the layout into a single resolver. Behaviour is
 * intentionally preserved bit-for-bit with the prior hardcoding so that this
 * phase ships zero behavioural change. Subsequent phases mutate only the
 * default values returned here.
 *
 * Override hooks:
 *  - `LVIS_PLUGINS_DIR` env var — points the user-installed dir at an
 *    arbitrary location. Required for portable / CI / corp-roaming-profile
 *    scenarios and used by tests to redirect away from `~/.lvis/`.
 *
 * Electron is intentionally NOT imported here so this module can be used in
 * non-Electron unit tests (vitest in `node` environment). Callers that have
 * Electron available should still pass `appRoot` / `userDataDir` so the
 * resolver can compose them without re-reaching for `app.getPath()`.
 */
import { homedir } from "node:os";
import { resolve } from "node:path";

export interface PluginPaths {
  /** Absolute path to `registry.json` (currently under appRoot/plugins/). */
  registryPath: string;
  /** Absolute path to the read-only marketplace catalog (`marketplace.json`). */
  marketplacePath: string;
  /** Directory where user-installed plugin manifests + bundles live. */
  userInstalledDir: string;
  /** Per-plugin version cache for rollback (Sprint 3-B §9.6). */
  cacheRoot: string;
}

export interface ResolvePluginPathsInput {
  /** App root — typically `projectRoot` in dev, `process.resourcesPath/app` in production. */
  appRoot: string;
  /**
   * Override for the user-installed directory. When omitted, falls back to
   * `LVIS_PLUGINS_DIR` env var, then to `homedir()/.lvis/plugins`.
   *
   * Tests should always pass an explicit value here to avoid touching the
   * real user `~/.lvis/`.
   */
  userInstalledDir?: string;
  /** Optional cache root override. Defaults to a sibling of userInstalledDir. */
  cacheRoot?: string;
}

/**
 * Resolve the plugin path layout for the current host process.
 *
 * Behaviour today (preserved from the prior inline literals):
 *  - registryPath / marketplacePath live under `appRoot/plugins/`
 *  - userInstalledDir defaults to `~/.lvis/plugins/`
 *  - cacheRoot defaults to `~/.lvis/plugins/.cache/`
 *
 * Phase 2 will switch the user-side defaults to `app.getPath('userData')/plugins/`,
 * but that change is gated behind explicit decisions documented in the
 * migration plan.
 */
export function resolvePluginPaths(input: ResolvePluginPathsInput): PluginPaths {
  const appRoot = resolve(input.appRoot);
  const envOverride = process.env.LVIS_PLUGINS_DIR;
  const userInstalledDir = resolve(
    input.userInstalledDir ?? envOverride ?? resolve(homedir(), ".lvis/plugins"),
  );
  const cacheRoot = resolve(input.cacheRoot ?? resolve(userInstalledDir, ".cache"));
  return {
    registryPath: resolve(appRoot, "plugins/registry.json"),
    marketplacePath: resolve(appRoot, "plugins/marketplace.json"),
    userInstalledDir,
    cacheRoot,
  };
}
