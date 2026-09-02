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
