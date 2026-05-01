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
import type { PluginManifest } from "../types.js";

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

/**
 * Build a schema-valid PluginManifest for tests. All required fields are
 * pre-filled with sensible defaults; callers only need to supply an id and
 * any overrides. Type-checked at build time — if the schema adds a new
 * required field this factory will surface a TS error at every test that
 * uses it, rather than a runtime AJV failure with an opaque fixture path.
 */
export function makeTestManifest(
  overrides: Partial<PluginManifest> & Pick<PluginManifest, "id">,
): PluginManifest {
  return {
    name: overrides.id,
    version: "0.0.0",
    description: "test fixture",
    publisher: "tests",
    entry: "dist/hostPlugin.js",
    tools: [],
    ...overrides,
  };
}
