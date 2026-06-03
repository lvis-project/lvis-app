import { getPluginViewLabel, toViewKey } from "../api-client.js";
import { t } from "../../../i18n/runtime.js";
import type { PluginUiExtension } from "../types.js";

export interface QuickAction {
  id: string;
  label: string;
  run: () => void | Promise<void>;
}

/**
 * Build the default quick-action list from app state.
 * Kept separate from CommandPopover so App does not import cmdk at startup.
 */
export function buildQuickActions({
  setActiveView,
  openSettings,
  handleNewChat,
  pluginViews,
}: {
  setActiveView: (key: string) => void;
  openSettings: () => void;
  handleNewChat: () => void | Promise<void>;
  pluginViews: PluginUiExtension[];
}): QuickAction[] {
  return [
    { id: "home",      label: t("commandActions.goHome"),       run: () => setActiveView("home") },
    { id: "routines",  label: t("commandActions.viewRoutines"), run: () => setActiveView("routines") },
    { id: "settings",  label: t("commandActions.openSettings"), run: openSettings },
    { id: "new-chat",  label: t("commandActions.newChat"),      run: handleNewChat },
    ...pluginViews.map((i) => {
      const viewKey = toViewKey(i);
      const pluginLabel = getPluginViewLabel(i);
      return {
        id: `v:${viewKey}`,
        label: t("commandActions.openPlugin", { pluginLabel }),
        run: () => setActiveView(viewKey),
      };
    }),
  ];
}
