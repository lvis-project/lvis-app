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
  "plugin-perf",
  "mcp",
  "plugin-config",
  "marketplace",
] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number];

export function normalizeSettingsTab(tab: unknown): SettingsTab {
  if (tab === "privacy") return "chat";
  return typeof tab === "string" && (SETTINGS_TABS as readonly string[]).includes(tab)
    ? (tab as SettingsTab)
    : "general";
}
