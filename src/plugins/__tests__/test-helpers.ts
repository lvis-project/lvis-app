/**
 * Shared helpers for marketplace test fixtures.
 *
 * Tests construct `PluginMarketplaceService` with the (paths, fetcher,
 * deploymentGuard?) shape. registry.json lives at the root of pluginsRoot,
 * so tests pick a single tmp root and the helper derives the rest.
 */
import { resolve } from "node:path";
import type { PluginPaths } from "../plugin-paths.js";
import { resolvePluginPaths } from "../plugin-paths.js";

export interface TestPluginPathsInput {
  /** A tmp directory; the helper anchors plugin paths under it. */
  rootDir: string;
  /** Optional override — defaults to `<rootDir>/plugins`. */
  pluginsRoot?: string;
  /** Optional override — defaults to `<pluginsRoot>/.cache`. */
  cacheRoot?: string;
}

/**
 * Build a fully-formed `PluginPaths` for a test. Mirrors the production
 * resolver shape so any future PluginPaths field addition flows through
 * here without 20-site updates.
 */
export function makeTestPluginPaths(input: TestPluginPathsInput): PluginPaths {
  return resolvePluginPaths({
    pluginsRoot: input.pluginsRoot ?? resolve(input.rootDir, "plugins"),
    cacheRoot: input.cacheRoot,
  });
}
