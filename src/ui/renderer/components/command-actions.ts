import { getPluginViewLabel, toViewKey } from "../api-client.js";
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
    { id: "home",      label: "홈으로 이동",   run: () => setActiveView("home") },
    { id: "routines",  label: "루틴 보기",     run: () => setActiveView("routines") },
    { id: "settings",  label: "설정 열기",     run: openSettings },
    { id: "new-chat",  label: "새 대화 시작",  run: handleNewChat },
    ...pluginViews.map((i) => {
      const viewKey = toViewKey(i);
      return {
        id: `v:${viewKey}`,
        label: `${getPluginViewLabel(i)} 열기`,
        run: () => setActiveView(viewKey),
      };
    }),
  ];
}
