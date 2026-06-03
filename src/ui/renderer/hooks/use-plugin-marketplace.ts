import { useCallback, useState } from "react";
import type { LvisApi } from "../types.js";
import type { MarketplaceItem, PluginCardSummary, PluginUiExtension } from "../types.js";
import { getHostMarketplaceApi } from "../host-marketplace-api.js";
import { t } from "../../../i18n/runtime.js";

/**
 * Phase reported by `lvis:plugins:install-progress` IPC events. Renderer
 * surfaces (plugin grid placeholder + settings tab skeleton) read this map to
 * render an in-flight indicator while the main process drives the install.
 */
export type InstallPhase = "installing" | "downloading" | "verifying" | "registering" | "restarting" | "preparing";
export type InstallProgressPayload =
  | { slug: string; phase: Exclude<InstallPhase, "downloading"> }
  | { slug: string; phase: "downloading"; bytesDownloaded: number; bytesTotal: number | null };
export type InstallInFlight = Record<string, InstallProgressPayload>;

/**
 * Plugin marketplace actions + state. Extracted from App.tsx to keep the
 * composition root focused on orchestration.
 */
export function usePluginMarketplace(api: LvisApi) {
  const [marketplace, setMarketplace] = useState<MarketplaceItem[]>([]);
  const [pluginViews, setPluginViews] = useState<PluginUiExtension[]>([]);
  // Plugin manifest summaries — needed alongside the slot-bound view list so
  // surfaces (plugin grid, settings tab, etc.) can read manifest-level
  // metadata like `auth` without going through their own card fetch.
  const [pluginCards, setPluginCards] = useState<PluginCardSummary[]>([]);
  const [marketStatus, setMarketStatus] = useState(() => t("usePluginMarketplace.loading"));
  const [working, setWorking] = useState(false);

  const refreshViews = useCallback(async () => {
    const v = (await api.listPluginUiExtensions()).filter((i) => i.extension.slot === "sidebar");
    setPluginViews(v);
    return v;
  }, [api]);

  const refreshCards = useCallback(async () => {
    try {
      const cards = await api.listPluginCards();
      setPluginCards(cards);
      return cards;
    } catch {
      // Card load is best-effort — surfaces that depend on it (auth badge)
      // simply skip rendering until next refresh tick.
      return [];
    }
  }, [api]);

  const refreshMarketplace = useCallback(async () => {
    try {
      setMarketStatus(t("usePluginMarketplace.loading"));
      const l = await api.listMarketplacePlugins();
      setMarketplace(l);
      setMarketStatus(t("usePluginMarketplace.pluginCount", { count: l.length }));
    } catch (e) {
      setMarketStatus(t("usePluginMarketplace.loadFailed", { message: (e as Error).message }));
    }
  }, [api]);

  const installPlugin = useCallback(async (id: string, expectedVersion?: string) => {
    setWorking(true);
    try {
      const result = await getHostMarketplaceApi().installMarketplacePlugin(id, expectedVersion);
      if (!result.ok) {
        throw new Error(result.message ?? result.error);
      }
      await refreshMarketplace();
      await refreshViews();
      const cards = await refreshCards();
      assertInstalledPluginVersion(cards, {
        requestedPluginId: id,
        installedPluginId: result.pluginId,
        expectedVersion,
      });
      setMarketStatus(t("usePluginMarketplace.installSuccess", { id }));
    } catch (e) {
      setMarketStatus(t("usePluginMarketplace.installFailed", { message: (e as Error).message }));
      throw e;
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
      setMarketStatus(t("usePluginMarketplace.uninstallSuccess", { id }));
    } catch (e) {
      setMarketStatus(t("usePluginMarketplace.uninstallFailed", { message: (e as Error).message }));
    } finally {
      setWorking(false);
    }
  }, [api, refreshMarketplace, refreshViews, refreshCards]);

  // In-flight install tracking moved to dedicated hooks at the call site.
  // - PluginGridButton (popover placeholder cell + spinner): useInstallingPlugins
  // - PluginConfigTab (Settings install/restart progress card): subscribes
  //   to the same IPC events directly so the marketplace hook stays
  //   focused on install/uninstall actions + view/card refresh.

  return {
    marketplace,
    pluginViews,
    pluginCards,
    marketStatus,
    working,
    refreshViews,
    refreshCards,
    refreshMarketplace,
    installPlugin,
    uninstallPlugin,
  };
}

export function assertInstalledPluginVersion(
  cards: PluginCardSummary[],
  input: {
    requestedPluginId: string;
    installedPluginId: string;
    expectedVersion?: string;
  },
): void {
  const expectedVersion = input.expectedVersion?.trim();
  if (!expectedVersion) return;

  const card = cards.find((candidate) =>
    candidate.id === input.installedPluginId ||
    candidate.id === input.requestedPluginId ||
    candidate.installAliases?.includes(input.requestedPluginId),
  );
  if (!card) {
    throw new Error(
      t("usePluginMarketplace.verifyFailedManifest", { id: input.requestedPluginId }),
    );
  }
  if (card.version !== expectedVersion) {
    throw new Error(
      t("usePluginMarketplace.verifyFailedVersion", {
        id: input.requestedPluginId,
        expected: expectedVersion,
        got: card.version ?? "unknown",
      }),
    );
  }
}
