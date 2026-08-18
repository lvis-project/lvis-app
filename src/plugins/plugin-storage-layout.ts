/**
 * Storage layout inside a single plugin root (`~/.lvis/plugins/<id>/`).
 *
 * A plugin root mixes three kinds of content with very different trust:
 *   - INSTALLED PAYLOAD (`plugin.json`, `dist/`, assets) — covered file by file
 *     by the install receipt and re-verified before every load;
 *   - the plugin's own WRITABLE STATE (`data/`) — created by
 *     `ensurePluginDataDir`, exposed as `hostApi.storage`, outside the receipt;
 *   - HOST-allocated worker control sockets (`run/<workerId>/`) — created by
 *     `permissions/worker-spawn.ts`, never plugin-written, outside the receipt.
 *
 * The split is a security boundary, not a convention: the OS write-jail grants
 * the plugin `data/` only, so plugin code cannot rewrite the bundle the next
 * load imports into the Electron main process.
 *
 * Deliberately a dependency-free leaf so the receipt verifier, the permission
 * layer, and the tool executor can all agree on the same directory names.
 */
import { resolve } from "node:path";
import { lvisHome } from "../shared/lvis-home.js";

/**
 * Directory under a plugin root holding the plugin's own writable runtime
 * state. Created by `ensurePluginDataDir` (plugins/runtime/sandbox.ts).
 */
export const PLUGIN_DATA_DIR_NAME = "data";

/**
 * Directory under a plugin root holding HOST-allocated worker control sockets
 * (`run/<workerId>/control.sock`, see permissions/worker-spawn.ts).
 */
export const PLUGIN_WORKER_RUN_DIR_NAME = "run";

/**
 * The absolute directory a plugin-owned tool may write into without escaping
 * its storage namespace: `~/.lvis/plugins/<pluginId>/data`.
 *
 * Deliberately NOT the plugin root. The root holds the plugin's own executable
 * bundle (`dist/`) and its manifest; granting write access there lets sandboxed
 * plugin code rewrite the very module the next load imports into the Electron
 * main process. Load-time receipt verification detects such a rewrite, but the
 * jail removes the primitive instead of merely detecting its use.
 */
export function resolvePluginWritableRoot(pluginId: string): string {
  return resolve(lvisHome(), "plugins", pluginId, PLUGIN_DATA_DIR_NAME);
}
