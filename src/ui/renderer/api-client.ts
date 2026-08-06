// Stateless helpers over window.lvisApi.

import type { LvisApi, PluginUiExtension } from "./types.js";

export { getPluginViewLabel } from "../../shared/plugin-view-label.js";

export function getApi(): LvisApi {
  if (!window.lvisApi) throw new Error("lvisApi not initialized");
  return window.lvisApi;
}

export function toViewKey(item: PluginUiExtension): string {
  return `plugin:${item.pluginId}:${item.extension.id}`;
}
