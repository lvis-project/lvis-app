import { useCallback, useState } from "react";
import type { LvisApi } from "../types.js";
import type { MarketplaceItem, PluginUiExtension } from "../types.js";

/**
 * Plugin marketplace actions + state. Extracted from App.tsx to keep the
 * composition root focused on orchestration.
 */
export function usePluginMarketplace(api: LvisApi) {
  const [marketplace, setMarketplace] = useState<MarketplaceItem[]>([]);
  const [pluginViews, setPluginViews] = useState<PluginUiExtension[]>([]);
  const [marketStatus, setMarketStatus] = useState("로딩 중...");
  const [working, setWorking] = useState(false);

  const refreshViews = useCallback(async () => {
    const v = (await api.listPluginUiExtensions()).filter((i) => i.extension.slot === "sidebar");
    setPluginViews(v);
    return v;
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
      const result = await api.installMarketplacePlugin(id);
      if (!result.ok) {
        throw new Error(result.message ?? result.error);
      }
      await refreshMarketplace();
      await refreshViews();
      setMarketStatus(`설치 완료: ${id}`);
    } catch (e) {
      setMarketStatus(`설치 실패: ${(e as Error).message}`);
    } finally {
      setWorking(false);
    }
  }, [api, refreshMarketplace, refreshViews]);

  const uninstallPlugin = useCallback(async (id: string) => {
    setWorking(true);
    try {
      const result = await api.uninstallMarketplacePlugin(id);
      if (!result.ok) {
        throw new Error(result.message ?? result.error);
      }
      await refreshMarketplace();
      await refreshViews();
      setMarketStatus(`제거 완료: ${id}`);
    } catch (e) {
      setMarketStatus(`제거 실패: ${(e as Error).message}`);
    } finally {
      setWorking(false);
    }
  }, [api, refreshMarketplace, refreshViews]);

  return {
    marketplace,
    pluginViews,
    marketStatus,
    working,
    refreshViews,
    refreshMarketplace,
    installPlugin,
    uninstallPlugin,
  };
}
