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
import type { PluginCard } from "../../plugins/runtime/index.js";

/** PUBLIC `lvis:plugins:cards` — installed plugin cards for the renderer/api. */
export function handlePluginCards(deps: IpcDeps) {
  const cards = deps.pluginRuntime.listPluginCards(deps.toolRegistry);
  const existingIds = new Set(cards.map((card) => card.id));
  const failureCards: PluginCard[] = deps.pluginMarketplace
    .getInstallFailureDiagnostics()
    .filter((failure) => !existingIds.has(failure.id))
    .map((failure) => ({
      id: failure.id,
      name: failure.name,
      description: `Marketplace install failed: ${failure.error}`,
      sampleTools: [],
      tools: [],
      capabilities: [],
      isManaged: failure.isManaged,
      installPolicy: failure.installPolicy,
      loadStatus: "failed",
      active: false,
      runtimeLoaded: false,
      installAliases: failure.installAliases,
      ...(failure.installFailureKind ? { installFailureKind: failure.installFailureKind } : {}),
      installFailureMessage: failure.error,
      ...(failure.networkAccess ? { networkAccess: failure.networkAccess } : {}),
      ...(failure.version ? { version: failure.version } : {}),
      ...(failure.publisher ? { publisher: failure.publisher } : {}),
    }));
  return [...cards, ...failureCards];
}

/** PUBLIC `lvis:plugins:marketplace:list` — marketplace catalog listing. */
export function handleMarketplaceList(deps: IpcDeps) {
  return deps.pluginMarketplace.list();
}
