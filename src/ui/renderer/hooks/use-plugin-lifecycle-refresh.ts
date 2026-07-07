import { useEffect, useMemo } from "react";
import type { getApi } from "../api-client.js";
import { useInstallingPlugins } from "./use-installing-plugins.js";
import type { usePluginMarketplace } from "./use-plugin-marketplace.js";

type Api = ReturnType<typeof getApi>;
type PluginMarketplace = ReturnType<typeof usePluginMarketplace>;

export interface UsePluginLifecycleRefreshDeps {
  api: Api;
  pluginCards: PluginMarketplace["pluginCards"];
  refreshViews: PluginMarketplace["refreshViews"];
  refreshCards: PluginMarketplace["refreshCards"];
  refreshMarketplace: PluginMarketplace["refreshMarketplace"];
}

/**
 * Plugin/agent/skill lifecycle → catalog refresh, extracted verbatim from
 * App.tsx. Owns the in-flight install tracker (drives the grid overlay spinner)
 * and every IPC subscription that keeps plugin views / cards / marketplace
 * entries fresh without an app restart: install/uninstall/runtime-updated/
 * install-progress broadcasts, the preparing-plugin poll interval, and the
 * agent/skill install-result listeners. All effects are independent IPC
 * subscriptions with no cross-effect state; each returns void.
 */
export function usePluginLifecycleRefresh({
  api,
  pluginCards,
  refreshViews,
  refreshCards,
  refreshMarketplace,
}: UsePluginLifecycleRefreshDeps): void {
  // Track in-flight plugin installs for the grid overlay spinner.
  const installingPlugins = useInstallingPlugins(api);

  const hasPreparingPlugin = useMemo(() => {
    if (pluginCards.some((card) => card.loadStatus === "preparing")) return true;
    return Array.from(installingPlugins.values()).some((phase) => phase === "preparing");
  }, [installingPlugins, pluginCards]);

  // Refresh plugin views + marketplace catalog when a lvis:// deep-link
  // install completes in the main process, so new plugin entries appear
  // (and uninstalled ones disappear) without requiring an app restart.
  useEffect(() => {
    if (typeof api.onPluginInstallResult !== "function") return;
    const unsubscribe = api.onPluginInstallResult(({ success }) => {
      if (success) {
        void refreshViews();
        void refreshMarketplace();
      }
      void refreshCards();
    });
    return unsubscribe;
  }, [api, refreshViews, refreshMarketplace, refreshCards]);

  useEffect(() => {
    if (typeof api.onBootstrapStatus !== "function") return;
    const unsubscribe = api.onBootstrapStatus((status) => {
      if (status.phase === "start") return;
      void refreshCards();
      void refreshViews();
      void refreshMarketplace();
    });
    return unsubscribe;
  }, [api, refreshViews, refreshCards, refreshMarketplace]);

  useEffect(() => {
    if (typeof api.onPluginRuntimeUpdated !== "function") return;
    const unsubscribe = api.onPluginRuntimeUpdated(() => {
      void refreshViews();
      void refreshCards();
    });
    return unsubscribe;
  }, [api, refreshViews, refreshCards]);

  useEffect(() => {
    if (typeof api.onPluginInstallProgress !== "function") return;
    const unsubscribe = api.onPluginInstallProgress((payload) => {
      if (payload.phase !== "preparing") return;
      void refreshCards();
      void refreshViews();
    });
    return unsubscribe;
  }, [api, refreshViews, refreshCards]);

  useEffect(() => {
    if (!hasPreparingPlugin) return;
    const refresh = () => {
      void refreshCards();
      void refreshViews();
    };
    refresh();
    const interval = window.setInterval(refresh, 750);
    return () => window.clearInterval(interval);
  }, [hasPreparingPlugin, refreshViews, refreshCards]);

  // Same lifecycle for uninstall — PluginConfigTab and any other surface
  // drive uninstall through the IPC handler which now broadcasts a result
  // event. Without this subscription plugin entry state would stay stale
  // until the app reloads.
  useEffect(() => {
    if (typeof api.onPluginUninstallResult !== "function") return;
    const unsubscribe = api.onPluginUninstallResult(({ success }) => {
      if (!success) return;
      void refreshViews();
      void refreshMarketplace();
      void refreshCards();
    });
    return unsubscribe;
  }, [api, refreshViews, refreshMarketplace, refreshCards]);

  useEffect(() => {
    const unsubs = [
      api.onAgentInstallResult?.(({ success }) => { if (success) void refreshMarketplace(); }),
      api.onAgentUninstallResult?.(({ success }) => { if (success) void refreshMarketplace(); }),
      api.onSkillInstallResult?.(({ success }) => { if (success) void refreshMarketplace(); }),
      api.onSkillUninstallResult?.(({ success }) => { if (success) void refreshMarketplace(); }),
    ].filter((unsubscribe): unsubscribe is () => void => typeof unsubscribe === "function");
    return () => {
      for (const unsubscribe of unsubs) unsubscribe();
    };
  }, [api, refreshMarketplace]);
}
