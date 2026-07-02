/**
 * plugins.ts (handlers) — transport-agnostic PUBLIC plugin handler logic (#1409 C10).
 *
 * Pure `handle*` functions behind the PUBLIC plugin channels (`plugins cards`,
 * `plugins marketplace:list`). They import NOTHING from the electron transport;
 * the `ipcMain.handle` wrapper stays in `domains/plugins.ts`. Both channels are
 * read-only (gesture: none) and were already sender-guard-optional, so the
 * wrapper is a bare delegation.
 */
import type { IpcDeps } from "../types.js";

/** PUBLIC `lvis:plugins:cards` — installed plugin cards for the renderer/api. */
export function handlePluginCards(deps: IpcDeps) {
  return deps.pluginRuntime.listPluginCards(deps.toolRegistry);
}

/** PUBLIC `lvis:plugins:marketplace:list` — marketplace catalog listing. */
export function handleMarketplaceList(deps: IpcDeps) {
  return deps.pluginMarketplace.list();
}
