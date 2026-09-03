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

/**
 * Tab → the anchored sections inside it, in the order the page lays them out.
 *
 * A tab is where a setting lives; a section is where the switch is. A link that
 * can only name the tab leaves the reader to find the control among ten others,
 * which is the whole reason a notice or an onboarding card sends them there —
 * so the destination model carries one level deeper than the tab.
 *
 * Every id here is anchored in the DOM as `data-settings-section="<id>"` by the
 * component that renders that tab, and the pairing is enforced in both
 * directions by `src/ui/renderer/__tests__/settings-section-anchors.test.ts`:
 * an id with no anchor is an unreachable destination, and an anchor missing
 * from this table is a place nothing can link to.
 *
 * Ids are globally unique rather than per-tab, because arrival looks the anchor
 * up by attribute across the whole panel: two tabs sharing an id would make the
 * lookup depend on which one happens to be mounted.
 */
export const SETTINGS_SECTIONS: Record<SettingsTab, readonly string[]> = {
  llm: ["llm-providers", "llm-thinking", "llm-fallback", "llm-pricing-overrides"],
  appearance: ["appearance-language", "appearance-theme", "appearance-font"],
  chat: ["chat-optimization", "chat-stream-smoothing", "chat-experimental", "chat-privacy"],
  web: ["web-search-engine", "web-api-key", "web-view-flow"],
  startup: [
    "startup-shortcut",
    "startup-launch",
    "startup-rendering",
    "startup-corp-ca",
    "startup-system-behavior",
  ],
  permissions: [
    "permissions-policy-summary",
    "permissions-policy",
    "permissions-approval-dialog",
    "permissions-os-sandbox",
    "permissions-adjudication",
    "permissions-rules",
    "permissions-directories",
    "permissions-approvals",
    "permissions-audit-log",
  ],
  "remote-surfaces": [
    "remote-tailnet",
    "remote-tailnet-observer",
    "remote-telegram",
    "remote-local-api",
  ],
  roles: ["roles-agents", "roles-memory", "roles-preferences", "roles-presets", "roles-preview"],
  usage: ["usage-workspace", "usage-summary"],
  audit: [
    "audit-stats",
    "audit-filter",
    "audit-results",
    "audit-bundle",
    "audit-log-file",
    "audit-crash",
    "audit-telemetry",
  ],
  mcp: ["mcp-servers"],
  "plugin-config": ["plugin-config-installed", "plugin-config-performance"],
  marketplace: ["marketplace-inventory", "marketplace-maintenance", "marketplace-advanced"],
  about: ["about-system-info"],
};

/**
 * Strict membership: is this the id of a tab this build actually ships?
 *
 * Separate from `normalizeSettingsTab`, which answers "llm" for anything it
 * cannot place. That answer is right for a persisted tab id or a stale deep
 * link — the panel has to open on something — and wrong for a caller deciding
 * whether a destination exists at all, which needs to be able to say no.
 */
export function isSettingsTab(tab: unknown): tab is SettingsTab {
  return typeof tab === "string" && (SETTINGS_TABS as readonly string[]).includes(tab);
}

/** Is `section` one of the anchors `tab` actually renders? */
export function isSettingsSection(tab: SettingsTab, section: unknown): boolean {
  return typeof section === "string" && SETTINGS_SECTIONS[tab].includes(section);
}

/** A settings destination: the page, and optionally the section within it. */
export interface SettingsPath {
  tab: SettingsTab;
  section?: string;
}

/**
 * Parse `"<tab>"` or `"<tab>/<section>"` into a destination this build can
 * reach, or `null`.
 *
 * Fail-closed on purpose, and strict where `normalizeSettingsTab` is lenient.
 * The callers are trust boundaries — a marketplace announcement's button and a
 * plugin manifest's onboarding highlight — so a path this build cannot honour
 * has to yield NO destination. Resolving it to the landing tab would point a
 * button labelled "turn on the sandbox" at the model page instead.
 */
export function parseSettingsPath(path: unknown): SettingsPath | null {
  if (typeof path !== "string") return null;
  const segments = path.split("/");
  if (segments.length > 2) return null;
  const [tab, section] = segments;
  if (!isSettingsTab(tab)) return null;
  if (section === undefined) return { tab };
  return isSettingsSection(tab, section) ? { tab, section } : null;
}

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
  return isSettingsTab(tab) ? tab : "llm";
}
