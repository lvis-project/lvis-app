// Stateless helpers over window.lvisApi.

import type { LvisApi, PluginUiExtension } from "./types.js";
import { pluginViewKey, type PluginViewKey } from "../../shared/view-key.js";

export { getPluginViewLabel } from "../../shared/plugin-view-label.js";

export function getApi(): LvisApi {
  if (!window.lvisApi) throw new Error("lvisApi not initialized");
  return window.lvisApi;
}

export function toViewKey(item: PluginUiExtension): PluginViewKey {
  return pluginViewKey(item.pluginId, item.extension.id);
}
