export const SETTINGS_TABS = [
  "llm",
  "appearance",
  "chat",
  "web",
  "startup",
  "permissions",
  "remote-surfaces",
  "roles",
  "usage",
  "audit",
  "mcp",
  "plugin-config",
  "marketplace",
  "about",
] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number];

/**
 * Tab → i18n label key. The settings panel's own nav and anything OUTSIDE the
 * panel that has to name the current tab (the top-bar path) read the same map,
 * so a renamed tab cannot end up with two different labels depending on which
 * surface is doing the naming.
 *
 * Keys only — resolving them needs the renderer's `t`, and this module is
 * shared with the main process.
 */
export const SETTINGS_TAB_LABEL_KEYS: Record<SettingsTab, string> = {
  llm: "settingsContent.tabLlm",
  appearance: "settingsContent.tabAppearance",
  chat: "settingsContent.tabChat",
  web: "settingsContent.tabWeb",
  startup: "settingsContent.tabStartup",
  permissions: "settingsContent.tabPermissions",
  "remote-surfaces": "settingsContent.tabRemoteSurfaces",
  roles: "settingsContent.tabRoles",
  usage: "settingsContent.tabUsage",
  audit: "settingsContent.tabAudit",
  mcp: "settingsContent.tabMcp",
  "plugin-config": "settingsContent.tabPluginConfig",
  marketplace: "settingsContent.tabMarketplace",
  about: "settingsContent.tabAbout",
};

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
  // Tailnet is one remote surface among several rather than a tab of its own,
  // so its page became the Remote surfaces tab. Old persisted/deep-link ids
  // still resolve to the page that hosts the Tailnet section.
  if (tab === "tailnet-access") return "remote-surfaces";
  return typeof tab === "string" && (SETTINGS_TABS as readonly string[]).includes(tab)
    ? (tab as SettingsTab)
    : "llm";
}
