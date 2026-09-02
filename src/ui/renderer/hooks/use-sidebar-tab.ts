import { useCallback, useEffect, useState } from "react";
import type { LvisApi } from "../types.js";
import {
  DEFAULT_SIDEBAR_TAB,
  isSidebarTab,
  normalizeSidebarGroupList,
  type SidebarGroup,
  type SidebarTab,
} from "../../../shared/sidebar-tab.js";

export type { SidebarGroup, SidebarTab };

export interface UseSidebarTabResult {
  /** Active sidebar tab ("chats" = ungrouped conversation list, "projects" = named-project groups). */
  activeTab: SidebarTab;
  /** Switch tabs — persists immediately (same durable-preference family as sidebarWidth/appMode). */
  setActiveTab: (tab: SidebarTab) => void;
}

/**
 * Persists the sidebar's active tab the same way other UI preferences persist
 * (SystemSettings round-trip via getSettings/updateSettings) — mirrors
 * `usePanelWidth`'s mount-seed + guarded-write shape. Unlike a drag value,
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
        if (isSidebarTab(tab)) setActiveTabState(tab);
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

export interface UseSidebarGroupsResult {
  /** Nav groups the user has folded. Absent = open. */
  closedGroups: ReadonlySet<SidebarGroup>;
  /** Fold or open one group — persists immediately, same family as the active tab. */
  setGroupOpen: (group: SidebarGroup, open: boolean) => void;
}

/**
 * Persists which sidebar nav groups are folded, through the same
 * SystemSettings round-trip as `useSidebarTab` (mount-seed + guarded write).
 * Stored as the closed list so a group the store has never heard of is open.
 */
export function useSidebarGroups(api: LvisApi): UseSidebarGroupsResult {
  const [closedGroups, setClosedGroups] = useState<ReadonlySet<SidebarGroup>>(() => new Set());
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api
      .getSettings()
      .then((settings) => {
        if (cancelled) return;
        const stored = settings?.system?.sidebarClosedGroups;
        if (Array.isArray(stored)) setClosedGroups(new Set(normalizeSidebarGroupList(stored)));
      })
      .catch(() => {
        // Non-fatal: every group stays open. The next toggle persists.
      })
      .finally(() => {
        if (!cancelled) setHydrated(true);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const setGroupOpen = useCallback(
    (group: SidebarGroup, open: boolean) => {
      setClosedGroups((current) => {
        if (current.has(group) === !open) return current;
        const next = new Set(current);
        if (open) next.delete(group);
        else next.add(group);
        if (hydrated) void api.updateSettings({ system: { sidebarClosedGroups: [...next] } });
        return next;
      });
    },
    [api, hydrated],
  );

  return { closedGroups, setGroupOpen };
}
