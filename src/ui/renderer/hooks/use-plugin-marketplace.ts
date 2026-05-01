import { useCallback, useEffect, useState } from "react";
import type { LvisApi } from "../types.js";
import type { MarketplaceItem, PluginCardSummary, PluginUiExtension } from "../types.js";
import { getHostMarketplaceApi } from "../host-marketplace-api.js";

/**
 * Phase reported by `lvis:plugins:install-progress` IPC events. Renderer
 * surfaces (sidebar placeholder + settings tab skeleton) read this map to
 * render an in-flight indicator while the main process drives the install.
 */
export type InstallPhase = "installing" | "downloading" | "verifying" | "registering" | "restarting";
export type InstallInFlight = Record<string, InstallPhase>;

/**
 * Plugin marketplace actions + state. Extracted from App.tsx to keep the
 * composition root focused on orchestration.
 */
export function usePluginMarketplace(api: LvisApi) {
  const [marketplace, setMarketplace] = useState<MarketplaceItem[]>([]);
  const [pluginViews, setPluginViews] = useState<PluginUiExtension[]>([]);
  // Plugin manifest summaries — needed alongside the slot-bound view list so
  // surfaces (sidebar grid, settings tab, etc.) can read manifest-level
  // metadata like `auth` without going through their own card fetch.
  const [pluginCards, setPluginCards] = useState<PluginCardSummary[]>([]);
  const [marketStatus, setMarketStatus] = useState("로딩 중...");
  const [working, setWorking] = useState(false);
  const [installInFlight, setInstallInFlight] = useState<InstallInFlight>({});

  const refreshViews = useCallback(async () => {
    const v = (await api.listPluginUiExtensions()).filter((i) => i.extension.slot === "sidebar");
    setPluginViews(v);
    return v;
  }, [api]);

  const refreshCards = useCallback(async () => {
    try {
      const cards = await api.listPluginCards();
      setPluginCards(cards);
    } catch {
      // Card load is best-effort — surfaces that depend on it (auth badge)
      // simply skip rendering until next refresh tick.
    }
  }, [api]);

  const refreshMarketplace = useCallback(async () => {
    try {
      setMarketStatus("로딩 중...");
      const l = await api.listMarketplacePlugins();
      setMarketplace(l);
      setMarketStatus(`플러그인 ${l.length}개`);
    } catch (e) {
      setMarketStatus(`실패: ${(e as Error).message}`);
    }
  }, [api]);

  const installPlugin = useCallback(async (id: string) => {
    setWorking(true);
    try {
      const result = await getHostMarketplaceApi().installMarketplacePlugin(id);
      if (!result.ok) {
        throw new Error(result.message ?? result.error);
      }
      await refreshMarketplace();
      await refreshViews();
      await refreshCards();
      setMarketStatus(`설치 완료: ${id}`);
    } catch (e) {
      setMarketStatus(`설치 실패: ${(e as Error).message}`);
    } finally {
      setWorking(false);
    }
  }, [api, refreshMarketplace, refreshViews, refreshCards]);

  const uninstallPlugin = useCallback(async (id: string) => {
    setWorking(true);
    try {
      const result = await getHostMarketplaceApi().uninstallMarketplacePlugin(id);
      if (!result.ok) {
        throw new Error(result.message ?? result.error);
      }
      await refreshMarketplace();
      await refreshViews();
      await refreshCards();
      setMarketStatus(`제거 완료: ${id}`);
    } catch (e) {
      setMarketStatus(`제거 실패: ${(e as Error).message}`);
    } finally {
      setWorking(false);
    }
  }, [api, refreshMarketplace, refreshViews, refreshCards]);

  // Track in-flight installs so the renderer can render a skeleton card +
  // sidebar placeholder while the main-process pipeline runs. Cleared on
  // both the success and failure result events so a transient slug never
  // sticks around as a permanent placeholder.
  useEffect(() => {
    const unsubs: Array<() => void> = [];
    if (typeof api.onPluginInstallProgress === "function") {
      unsubs.push(
        api.onPluginInstallProgress((payload) => {
          setInstallInFlight((prev) => ({ ...prev, [payload.slug]: payload.phase }));
        }),
      );
    }
    if (typeof api.onPluginInstallResult === "function") {
      unsubs.push(
        api.onPluginInstallResult(({ slug }) => {
          setInstallInFlight((prev) => {
            if (!(slug in prev)) return prev;
            const next = { ...prev };
            delete next[slug];
            return next;
          });
        }),
      );
    }
    return () => {
      for (const u of unsubs) u();
    };
  }, [api]);

  return {
    marketplace,
    pluginViews,
    pluginCards,
    marketStatus,
    working,
    installInFlight,
    refreshViews,
    refreshCards,
    refreshMarketplace,
    installPlugin,
    uninstallPlugin,
  };
}
