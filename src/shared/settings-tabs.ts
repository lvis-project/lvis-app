export const SETTINGS_TABS = [
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
  "about",
] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number];

export function normalizeSettingsTab(tab: unknown): SettingsTab {
  if (tab === "privacy") return "chat";
  // The plugin-perf tab was merged into plugin-config ("성능만 병합"); keep old
  // deep links / persisted tab ids resolving to the config tab that now hosts
  // the performance section.
  if (tab === "plugin-perf") return "plugin-config";
  // The former "general" tab was split up (account → Model, stats → Usage,
  // system info → the new "about" tab). Old persisted/deep-link "general" ids
  // land on the new default landing surface, the Model tab that now hosts the
  // account section.
  if (tab === "general") return "llm";
  return typeof tab === "string" && (SETTINGS_TABS as readonly string[]).includes(tab)
    ? (tab as SettingsTab)
    : "llm";
}
