/**
 * Sidebar Chats/Projects tab. SoT for the *value set* lives here so every
 * consumer (persisted-settings validation, the renderer hook, and the
 * Sidebar component itself) validates against the same union instead of
 * re-declaring `"chats" | "projects"` inline at each call site.
 *
 * Consumers:
 *  - `src/data/settings-store.ts` (`SystemSettings.sidebarActiveTab`'s type
 *    + `SIDEBAR_TABS`-derived patch/normalize validation)
 *  - `src/ui/renderer/hooks/use-sidebar-tab.ts` (persists the active tab)
 *  - `src/ui/renderer/components/Sidebar.tsx` (renders the Tabs UI)
 */
export type SidebarTab = "chats" | "projects";

export const SIDEBAR_TABS: readonly SidebarTab[] = ["chats", "projects"];

export const DEFAULT_SIDEBAR_TAB: SidebarTab = "chats";

export function isSidebarTab(value: unknown): value is SidebarTab {
  return typeof value === "string" && (SIDEBAR_TABS as readonly string[]).includes(value);
}

/**
 * Sidebar nav groups the user can fold: "features" holds the built-in views
 * (work board, routines, insights), "plugins" holds the installed plugin
 * rows. Persisted as the list of CLOSED groups (`SystemSettings.
 * sidebarClosedGroups`) so an absent value — and any group added later —
 * reads as open.
 *
 * Consumers:
 *  - `src/data/settings-store.ts` / `settings-normalization.ts` (validate the
 *    stored list)
 *  - `src/ui/renderer/hooks/use-sidebar-tab.ts` (persists the folded set)
 *  - `src/ui/renderer/components/Sidebar.tsx` (renders the group headers)
 */
export type SidebarGroup = "features" | "plugins";

const SIDEBAR_GROUPS: readonly SidebarGroup[] = ["features", "plugins"];

function isSidebarGroup(value: unknown): value is SidebarGroup {
  return typeof value === "string" && (SIDEBAR_GROUPS as readonly string[]).includes(value);
}

/** Keeps the known groups, in first-seen order, once each. */
export function normalizeSidebarGroupList(value: readonly unknown[]): SidebarGroup[] {
  const seen = new Set<SidebarGroup>();
  for (const entry of value) {
    if (isSidebarGroup(entry)) seen.add(entry);
  }
  return [...seen];
}
