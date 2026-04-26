import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { PluginRegistry, PluginRegistryEntry } from "./types.js";

export async function readPluginRegistry(registryPath: string): Promise<PluginRegistry> {
  let raw: string;
  try {
    raw = await readFile(registryPath, "utf-8");
  } catch (err) {
    // First-boot path: PR #248 moved the registry from `lvis-app/plugins/`
    // into the user's `userData/plugins/` directory. On a fresh dev boot
    // (or a brand-new userData) the file simply doesn't exist yet —
    // return the empty default so PluginRuntime.startAll can proceed and
    // the registry will be lazily created by the first install/uninstall.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, plugins: [] };
    }
    throw err;
  }
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

// ─── Phase 1.5 F-round §M1: in-process async mutex ──────────────────
//
// Serialize read-modify-write cycles on registry.json to prevent TOCTOU
// races between concurrent install / uninstall / disable paths. Keyed by
// registryPath so tests with tmp paths do not interfere with production.
// Scope is intentionally in-process only — cross-process locking is Phase 2+
// (requires file locks or IPC serialization).

const registryLocks = new Map<string, Promise<void>>();

export async function withRegistryLock<T>(
  registryPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = resolve(registryPath);
  const prev = registryLocks.get(key) ?? Promise.resolve();
  const next = prev.then(() => fn());
  // Next acquirer chains off this turn's completion, regardless of success.
  registryLocks.set(key, next.then(() => undefined, () => undefined));
  return next;
}

/**
 * Atomic read → mutate → write helper. Use this from any code path that
 * modifies the registry to ensure serialization with concurrent writers.
 *
 * Example:
 *   await updatePluginRegistry(path, (reg) => {
 *     const entry = reg.plugins.find(...);
 *     if (entry) entry.enabled = false;
 *   });
 */
export async function updatePluginRegistry(
  registryPath: string,
  mutator: (registry: PluginRegistry) => void | Promise<void>,
): Promise<void> {
  await withRegistryLock(registryPath, async () => {
    const registry = await readPluginRegistry(registryPath);
    await mutator(registry);
    await writePluginRegistry(registryPath, registry);
  });
}
