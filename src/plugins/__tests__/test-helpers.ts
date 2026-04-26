/**
 * Phase 2a — shared helpers for marketplace test fixtures.
 *
 * Tests construct `PluginMarketplaceService` with the new (paths, fetcher,
 * deploymentGuard?) shape. The Phase 2a invariant is that registry.json
 * lives under `userInstalledDir`, so tests can pick a single tmp root and
 * the helper derives the rest.
 */
import type { PluginPaths } from "../plugin-paths.js";
import { resolvePluginPaths } from "../plugin-paths.js";

export interface TestPluginPathsInput {
  /** A tmp directory; the helper anchors plugin paths under it. */
  rootDir: string;
  /** Optional override — defaults to `<rootDir>/plugins`. */
  userInstalledDir?: string;
  /** Optional override — defaults to `<userInstalledDir>/.cache`. */
  cacheRoot?: string;
}

/**
 * Build a fully-formed `PluginPaths` for a test. Mirrors the production
 * resolver shape so any future PluginPaths field addition flows through
 * here without 20-site updates.
 */
export function makeTestPluginPaths(input: TestPluginPathsInput): PluginPaths {
  return resolvePluginPaths({
    userDataDir: input.rootDir,
    userInstalledDir: input.userInstalledDir,
    cacheRoot: input.cacheRoot,
  });
}
