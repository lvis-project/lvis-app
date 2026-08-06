/**
 * The display label for a plugin UI extension — shared between the main-window
 * renderer and the plugin-shell bundle.
 *
 * Both bundles render the same extension in the same session (the sidebar entry
 * in the main window, the shell header in the detached/embedded view), so a
 * one-sided edit makes one surface call an extension something the other does
 * not. Same corrective pattern the sibling concern in `plugin-ui-host.tsx`
 * already documents for partition naming (`shared/plugin-partition.ts`, #498).
 *
 * Pure — no DOM / Electron / node deps, and no import of the extension type, so
 * it stays importable from either bundle without pulling a bundle entry module
 * into the shared graph. The parameter is the minimum the derivation reads;
 * `PluginUiExtensionView` (plugin-ui-host.tsx) and its renderer alias
 * `PluginUiExtension` both satisfy it structurally, which `tsc` checks at each
 * call site.
 */
export interface PluginViewLabelSource {
  pluginId: string;
  extension: {
    displayName?: string;
    title: string;
  };
}

/**
 * Author-chosen `displayName` first, then the required `title`, then the plugin
 * id as the last resort. A `displayName` that is blank once trimmed is treated
 * as absent — an all-whitespace label would render as an invisible entry.
 */
export function getPluginViewLabel(item: PluginViewLabelSource): string {
  return item.extension.displayName?.trim() || item.extension.title || item.pluginId;
}
