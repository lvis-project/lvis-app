/**
 * Plugin partition naming — shared between main and renderer.
 *
 * Each plugin webview runs in a dedicated `persist:plugin:<hash>` Electron
 * session partition for storage isolation. Main process registers the
 * preload + network gate per partition (via `installPluginPartitionPolicy`)
 * and renderer sets the `partition=` attribute on the `<webview>`. Both
 * sides MUST agree on the hash function — drift would make the renderer
 * route a webview to a partition the main process never policy-registered,
 * silently disabling the `lvisPlugin` contextBridge (#498).
 *
 * 32-bit FNV-1a → 8 hex chars. Pure function (no DOM / Electron deps) so
 * it can be imported from main, renderer, and worker contexts equally.
 * Synchronous (renderer can't use SubtleCrypto inline) and good enough for
 * collision resistance on a per-user plugin set < ~10k.
 *
 * pluginId is admin-issued (marketplace catalog or local-dev install
 * receipt), not user-controllable, so an attacker cannot pre-meditate a
 * slug collision via marketplace upload.
 */

const FNV_OFFSET_BASIS = 2166136261;
const FNV_PRIME = 16777619;

export function pluginPartitionHash(pluginId: string): string {
  let h = FNV_OFFSET_BASIS;
  for (let i = 0; i < pluginId.length; i++) {
    h ^= pluginId.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function pluginPartitionName(pluginId: string): string {
  return `persist:plugin:${pluginPartitionHash(pluginId)}`;
}
