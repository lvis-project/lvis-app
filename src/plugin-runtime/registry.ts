import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { PluginRegistry, PluginRegistryEntry } from "./types.js";

export async function readPluginRegistry(registryPath: string): Promise<PluginRegistry> {
  const raw = await readFile(registryPath, "utf-8");
  const parsed = JSON.parse(raw) as PluginRegistry;
  if (!Array.isArray(parsed.plugins)) {
    throw new Error(`Invalid plugin registry: ${registryPath}`);
  }
  return {
    version: parsed.version ?? 1,
    plugins: parsed.plugins,
  };
}

export async function writePluginRegistry(registryPath: string, registry: PluginRegistry): Promise<void> {
  await mkdir(dirname(registryPath), { recursive: true });
  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf-8");
}

export function resolveManifestPathsFromRegistry(
  registryPath: string,
  entries: PluginRegistryEntry[],
): string[] {
  const baseDir = dirname(registryPath);
  return entries
    .filter((entry) => entry.enabled !== false)
    .map((entry) => (isAbsolute(entry.manifestPath) ? entry.manifestPath : resolve(baseDir, entry.manifestPath)));
}

