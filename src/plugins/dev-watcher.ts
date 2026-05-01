/**
 * I2 — Plugin live-reload watcher (dev mode only).
 *
 * Watches each loaded plugin's `dist/` directory via Node's built-in
 * fs.watch (recursive on macOS/Windows; best-effort fallback elsewhere) and
 * triggers `PluginRuntime.reloadPlugin()` when changes settle.
 *
 * Debounced (default 500ms) so a typical `bun run build` burst fires exactly
 * one reload per plugin. Activation is gated by `LVIS_DEV_RELOAD=1` so this
 * is impossible to leave on in packaged builds.
 */
import { watch, type FSWatcher } from "node:fs";
import { resolve } from "node:path";
import type { PluginRuntime } from "./runtime.js";
import { devPluginReloadEnabled } from "../boot/dev-flags.js";
import { createLogger } from "../lib/logger.js";
const log = createLogger("dev-watcher");

export interface PluginDevWatcherOptions {
  pluginRuntime: PluginRuntime;
  /** Override debounce ms (default 500). */
  debounceMs?: number;
  /** Optional re-register hook invoked after a successful reload. */
  onReloaded?: (pluginId: string) => void;
  /** Logger sink — defaults to console. */
  log?: (level: "info" | "warn" | "error", message: string) => void;
}

export interface PluginDevWatcherHandle {
  /** Stop all watchers. Idempotent. */
  stop(): void;
}

/**
 * Start a dev-mode plugin watcher. No-op (returns an empty handle) when
 * `LVIS_DEV_RELOAD` is not set to "1".
 */
export function startPluginDevWatcher(
  opts: PluginDevWatcherOptions,
): PluginDevWatcherHandle {
  // Phase 1 §Step 4 — gate hard-anchored to !app.isPackaged via dev-flags.
  if (!devPluginReloadEnabled()) {
    return { stop: () => {} };
  }

  const debounceMs = opts.debounceMs ?? 500;
  const localLog = opts.log ?? ((level: "info" | "warn" | "error", msg: string) => {
    if (level === "error") log.error(msg);
    else if (level === "warn") log.warn(msg);
    else log.info(msg);
  });

  const watchers = new Map<string, FSWatcher>();
  const pending = new Map<string, NodeJS.Timeout>();
  let stopped = false;

  const scheduleReload = (pluginId: string): void => {
    if (stopped) return;
    const existing = pending.get(pluginId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      pending.delete(pluginId);
      localLog("info", `[plugin-dev-watcher] reloading ${pluginId}`);
      opts.pluginRuntime
        .reloadPlugin(pluginId)
        .then(() => {
          localLog("info", `[plugin-dev-watcher] reloaded ${pluginId}`);
          opts.onReloaded?.(pluginId);
        })
        .catch((err: Error) => {
          localLog("error", `[plugin-dev-watcher] reload failed for ${pluginId}: ${err.message}`);
        });
    }, debounceMs);
    pending.set(pluginId, timer);
  };

  for (const pluginId of opts.pluginRuntime.listPluginIds()) {
    const manifest = opts.pluginRuntime.getPluginManifest(pluginId);
    if (!manifest) continue;
    // Watch the dist directory (parent of manifest.entry). Reuse entry to
    // derive plugin root via runtime's internal paths is not exposed; instead
    // we derive dist path from entry relative to a host-known plugin root by
    // letting fs.watch accept the absolute entry directory.
    // Callers wire pluginRuntime so getPluginInstance carries root info via
    // manifest.entry; we use the runtime's resolvePluginEntry helper through
    // a lookup on plugins. Simpler: watch the directory containing the entry.
    const entryDir = opts.pluginRuntime.getPluginEntryDir(pluginId);
    if (!entryDir) {
      localLog("warn", `[plugin-dev-watcher] skip ${pluginId}: no entryDir`);
      continue;
    }
    try {
      const watcher = watch(
        resolve(entryDir),
        { recursive: true },
        (_eventType, filename) => {
          if (!filename) return;
          // Only trigger on JS/MJS changes so source-map + non-code writes
          // don't double-fire.
          if (!/\.(m?js|cjs)$/i.test(String(filename))) return;
          scheduleReload(pluginId);
        },
      );
      watcher.on("error", (err) => {
        localLog("error", `[plugin-dev-watcher] ${pluginId} watcher error: ${err.message}`);
      });
      watchers.set(pluginId, watcher);
      localLog("info", `[plugin-dev-watcher] watching ${pluginId} at ${entryDir}`);
    } catch (err) {
      localLog("warn", `[plugin-dev-watcher] failed to watch ${pluginId}: ${(err as Error).message}`);
    }
  }

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
      for (const w of watchers.values()) {
        try { w.close(); } catch { /* ignore */ }
      }
      watchers.clear();
    },
  };
}
