export const SETTINGS_TABS = [
  "general",
  "llm",
  "appearance",
  "chat",
  "web",
  "startup",
  "permissions",
  "roles",
  "usage",
  "audit",
  "mcp",
  "plugin-config",
  "marketplace",
] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number];

export function normalizeSettingsTab(tab: unknown): SettingsTab {
  if (tab === "privacy") return "chat";
  // The plugin-perf tab was merged into plugin-config ("성능만 병합"); keep old
  // deep links / persisted tab ids resolving to the config tab that now hosts
  // the performance section.
  if (tab === "plugin-perf") return "plugin-config";
  return typeof tab === "string" && (SETTINGS_TABS as readonly string[]).includes(tab)
    ? (tab as SettingsTab)
    : "general";
}
