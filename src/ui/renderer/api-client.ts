// Stateless helpers over window.lvisApi.

import type { LvisApi, PluginUiExtension } from "./types.js";

export function getApi(): LvisApi {
  if (!window.lvisApi) throw new Error("lvisApi not initialized");
  return window.lvisApi;
}

export function toViewKey(item: PluginUiExtension): string {
  return `plugin:${item.pluginId}:${item.extension.id}`;
}

export function getPluginViewLabel(item: PluginUiExtension): string {
  return item.extension.displayName?.trim() || item.extension.title || item.pluginId;
}
