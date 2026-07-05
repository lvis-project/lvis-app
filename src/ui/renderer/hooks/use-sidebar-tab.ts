import { useCallback, useEffect, useState } from "react";
import type { LvisApi } from "../types.js";

export type SidebarTab = "chats" | "projects";

const DEFAULT_SIDEBAR_TAB: SidebarTab = "chats";

export interface UseSidebarTabResult {
  /** Active sidebar tab ("chats" = ungrouped conversation list, "projects" = named-project groups). */
  activeTab: SidebarTab;
  /** Switch tabs — persists immediately (same durable-preference family as sidebarWidth/appMode). */
  setActiveTab: (tab: SidebarTab) => void;
}

/**
 * Persists the sidebar's active tab the same way other UI preferences persist
 * (SystemSettings round-trip via getSettings/updateSettings) — mirrors
 * `useSidebarWidth`'s mount-seed + guarded-write shape. Unlike a drag value,
 * a tab switch has no meaningful "live" (uncommitted) intermediate state, so
 * there is a single setter that both updates local state and persists.
 */
export function useSidebarTab(api: LvisApi): UseSidebarTabResult {
  const [activeTab, setActiveTabState] = useState<SidebarTab>(DEFAULT_SIDEBAR_TAB);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api
      .getSettings()
      .then((settings) => {
        if (cancelled) return;
        const tab = settings?.system?.sidebarActiveTab;
        if (tab === "chats" || tab === "projects") setActiveTabState(tab);
      })
      .catch(() => {
        // Non-fatal: fall back to the default tab. The next switch persists.
      })
      .finally(() => {
        if (!cancelled) setHydrated(true);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const setActiveTab = useCallback(
    (tab: SidebarTab) => {
      setActiveTabState(tab);
      // Guard against persisting the seed value back before the initial read
      // resolves (would race the mount-seed effect above with a redundant write).
      if (!hydrated) return;
      void api.updateSettings({ system: { sidebarActiveTab: tab } });
    },
    [api, hydrated],
  );

  return { activeTab, setActiveTab };
}
