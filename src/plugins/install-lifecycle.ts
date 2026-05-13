import type { BrowserWindow } from "electron";
import path from "node:path";
import type { PythonRuntimeBootstrapper } from "../main/python-runtime.js";
import { resolvePluginPaths } from "./plugin-paths.js";
import { readPluginRegistry } from "./registry.js";
import type { PluginRuntime } from "./runtime.js";

const inflightInstallLocks = new Map<string, Promise<unknown>>();

/**
 * Per-pluginId in-flight install mutex. Serializes the full install ->
 * addPlugin -> rollback-if-needed sequence for a plugin across IPC and
 * protocol install paths.
 */
export async function withPluginInstallLock<T>(
  pluginId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = inflightInstallLocks.get(pluginId) ?? Promise.resolve();
  let release: () => void = () => {};
  const next = new Promise<void>((resolveNext) => {
    release = resolveNext;
  });
  const tail = prev.then(() => next);
  inflightInstallLocks.set(pluginId, tail);
  try {
    await prev;
    return await fn();
  } finally {
    release();
    if (inflightInstallLocks.get(pluginId) === tail) {
      inflightInstallLocks.delete(pluginId);
    }
  }
}

async function resolveInstalledManifestPath(pluginId: string): Promise<string | undefined> {
  const pluginPaths = resolvePluginPaths();
  const registry = await readPluginRegistry(pluginPaths.registryPath);
  const entry = registry.plugins.find((candidate) => candidate.id === pluginId && candidate.enabled !== false);
  if (!entry) return undefined;
  return path.isAbsolute(entry.manifestPath)
    ? entry.manifestPath
    : path.resolve(path.dirname(pluginPaths.registryPath), entry.manifestPath);
}

export async function preparePythonRuntimeForInstalledPlugin(
  pluginId: string,
  deps: {
    pythonRuntime?: PythonRuntimeBootstrapper;
    pluginRuntime: Pick<PluginRuntime, "mergeConfigOverride">;
    getMainWindow: () => BrowserWindow | null;
  },
): Promise<void> {
  if (!deps.pythonRuntime) return;
  const manifestPath = await resolveInstalledManifestPath(pluginId);
  if (!manifestPath) return;
  const win = deps.getMainWindow();
  if (!win) return;
  const runtime = await deps.pythonRuntime.ensureReadyForPluginManifest(manifestPath, win);
  if (!runtime) return;
  deps.pluginRuntime.mergeConfigOverride("*", { pythonExecutable: runtime.pythonPath });
}
