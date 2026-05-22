/**
 * Shared helpers for marketplace test fixtures.
 *
 * Tests construct `PluginMarketplaceService` with the (paths, fetcher,
 * deploymentGuard?) shape. registry.json lives at the root of pluginsRoot,
 * so tests pick a single tmp root and the helper derives the rest.
 */
import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { PluginPaths } from "../plugin-paths.js";
import { resolvePluginPaths } from "../plugin-paths.js";
import { PluginMarketplaceService } from "../marketplace.js";
import type { MarketplaceFetcher } from "../marketplace-fetcher.js";
import { PluginRuntime, type PluginRuntimeOptions } from "../runtime.js";
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

export interface TestPluginRuntimeFixture {
  rootDir: string;
  pluginsRoot: string;
  registryPath: string;
}

export interface TestPluginRuntimeFixtureOptions {
  /** Prefix passed to `mkdtempSync`; defaults to `lvis-plugin-test-`. */
  prefix?: string;
  /** Optional plugin root override relative to `rootDir`; defaults to `plugins/installed`. */
  pluginsRootRelative?: string;
}

export async function makeTestPluginRuntimeFixture(
  options: TestPluginRuntimeFixtureOptions = {},
): Promise<TestPluginRuntimeFixture> {
  const rootDir = mkdtempSync(join(tmpdir(), options.prefix ?? "lvis-plugin-test-"));
  const pluginsRoot = join(rootDir, options.pluginsRootRelative ?? "plugins/installed");
  const registryPath = join(rootDir, "plugins", "registry.json");
  await mkdir(pluginsRoot, { recursive: true });
  await mkdir(dirname(registryPath), { recursive: true });
  return { rootDir, pluginsRoot, registryPath };
}

export interface WriteTestPluginOptions {
  id: string;
  entry?: string;
  entrySource?: string;
  tools?: string[];
  manifest?: Partial<PluginManifest> & Record<string, unknown>;
}

export interface WrittenTestPlugin {
  pluginDir: string;
  manifestPath: string;
  manifest: PluginManifest;
}

export function makeTestPluginEntrySource(
  handlers: Record<string, string> = {},
): string {
  const handlerEntries = Object.entries(handlers)
    .map(([name, body]) => `${JSON.stringify(name)}: async () => ${body}`)
    .join(", ");
  return `export default async function createPlugin() {
  return { handlers: { ${handlerEntries} }, start: async () => {}, stop: async () => {} };
}
`;
}

export async function writeTestPlugin(
  fixture: TestPluginRuntimeFixture,
  options: WriteTestPluginOptions,
): Promise<WrittenTestPlugin> {
  const entry = options.entry ?? "entry.mjs";
  const tools = options.tools ?? [];
  const pluginDir = join(fixture.pluginsRoot, options.id);
  await mkdir(pluginDir, { recursive: true });
  if (options.entrySource !== undefined) {
    await writeFile(join(pluginDir, entry), options.entrySource, "utf-8");
  }
  const manifest = makeTestManifest({
    id: options.id,
    entry,
    tools,
    ...options.manifest,
  });
  const manifestPath = join(pluginDir, "plugin.json");
  await writeFile(manifestPath, JSON.stringify(manifest), "utf-8");
  return { pluginDir, manifestPath, manifest };
}

export interface TestRegistryEntry {
  id: string;
  manifestPath: string;
  enabled?: boolean;
  approvedPluginAccess?: unknown;
  installSource?: "admin" | "user" | "local-dev";
  installedBy?: "admin" | "user";
  _devLinked?: boolean;
}

export async function writeTestPluginRegistry(
  fixture: Pick<TestPluginRuntimeFixture, "registryPath">,
  entries: TestRegistryEntry[],
): Promise<void> {
  await mkdir(dirname(fixture.registryPath), { recursive: true });
  await writeFile(
    fixture.registryPath,
    JSON.stringify({ version: 1, plugins: entries }),
    "utf-8",
  );
}

export function makeTestPluginRuntime(
  fixture: TestPluginRuntimeFixture,
  options: Partial<PluginRuntimeOptions> = {},
): PluginRuntime {
  return new PluginRuntime({
    hostRoot: fixture.rootDir,
    registryPath: fixture.registryPath,
    pluginsRoot: fixture.pluginsRoot,
    ...options,
  });
}

export function makeTestPluginMarketplaceService(
  rootDir: string,
  fetcher: MarketplaceFetcher,
): PluginMarketplaceService {
  return new PluginMarketplaceService(
    makeTestPluginPaths({ rootDir }),
    fetcher,
  );
}
