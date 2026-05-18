import { useEffect, useState } from "react";
import type { LvisApi } from "../types.js";

export interface PluginUpdateInfo {
  pluginId: string;
  pluginName?: string;
  installedVersion: string;
  latestVersion: string;
}

/**
 * S8 — Subscribes to `marketplace:updates-available` IPC events and
 * exposes the list of available updates + a dismiss callback.
 */
export function useMarketplaceUpdates(api: LvisApi) {
  const [updates, setUpdates] = useState<PluginUpdateInfo[]>([]);

  useEffect(() => {
    let alive = true;
    const unsubscribe = api.onMarketplaceUpdatesAvailable((incoming) => {
      if (alive) setUpdates(incoming);
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [api]);

  const dismiss = () => setUpdates([]);

  return { updates, dismiss };
}
