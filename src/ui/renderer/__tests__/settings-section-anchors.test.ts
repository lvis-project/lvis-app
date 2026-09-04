/**
 * `SETTINGS_SECTIONS` and the DOM must name the same places.
 *
 * The registry is what a marketplace announcement and a plugin manifest are
 * validated against; the `data-settings-section` attributes are what arrival
 * actually looks for. Nothing at runtime notices when the two drift: a registry
 * id with no anchor validates fine and then lands the reader at the top of the
 * page, and an anchor missing from the registry is a place every link to it is
 * rejected. Both failures are silent, and both are what an ordinary rename of a
 * settings section produces.
 *
 * A source scan rather than a render, because these tabs pull live IPC on
 * mount: a render deep enough to prove the attribute is present would be
 * proving the mocks instead.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { SETTINGS_SECTIONS, SETTINGS_TABS, type SettingsTab } from "../../../shared/settings-tabs.js";

const RENDERER = resolve(import.meta.dirname, "..");

/**
 * Every source file that renders part of one tab's body.
 *
 * Hand-written because the composition is what is asserted: a section belongs
 * to the tab whose body reaches it, and deriving the list from imports would
 * let a section move between tabs without this noticing.
 */
const TAB_SOURCES: Record<SettingsTab, readonly string[]> = {
  llm: [
    "tabs/LlmTab.tsx",
    "tabs/PricingOverridesSection.tsx",
    "tabs/SubscriptionProvidersSection.tsx",
    "tabs/SubscriptionProvidersController.tsx",
  ],
  appearance: ["tabs/AppearanceTab.tsx"],
  chat: ["tabs/ChatTab.tsx", "tabs/PrivacyTab.tsx"],
  web: ["tabs/WebTab.tsx"],
  startup: ["tabs/StartupTab.tsx"],
  permissions: ["tabs/PermissionsTab.tsx"],
  "remote-surfaces": [
    "tabs/RemoteSurfacesTab.tsx",
    "tabs/TailnetAccessContent.tsx",
    "tabs/TailnetSetupWizard.tsx",
    "tabs/TailnetObserverSection.tsx",
    "tabs/TelegramConnectionContent.tsx",
    "tabs/AwayAuthorityContent.tsx",
    "tabs/LocalApiSurfacesSection.tsx",
  ],
  roles: ["tabs/RolesTab.tsx"],
  usage: ["components/UsageDashboard.tsx", "components/WorkspaceStatsSection.tsx"],
  audit: ["tabs/AuditTab.tsx", "tabs/DiagnosticsSection.tsx", "tabs/TelemetrySection.tsx"],
  mcp: ["tabs/McpTab.tsx"],
  "plugin-config": [
    "tabs/PluginConfigTab.tsx",
    "tabs/PluginPerfTab.tsx",
    "components/PluginAuthSection.tsx",
  ],
  marketplace: ["tabs/MarketplaceTab.tsx"],
  about: ["tabs/AboutTab.tsx"],
};

const ANCHOR = /data-settings-section="([a-z0-9-]+)"/g;

function anchorsIn(relativePaths: readonly string[]): Set<string> {
  const found = new Set<string>();
  for (const relativePath of relativePaths) {
    const text = readFileSync(join(RENDERER, relativePath), "utf-8");
    for (const match of text.matchAll(ANCHOR)) found.add(match[1]!);
  }
  return found;
}

/** Every renderer source file, relative to the renderer root. */
function rendererSources(dir = RENDERER, prefix = "", out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__" || entry === "__mocks__" || entry === "node_modules") continue;
    const full = join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(full).isDirectory()) rendererSources(full, rel, out);
    else if (/\.tsx?$/.test(entry)) out.push(rel);
  }
  return out;
}

describe("settings section anchors", () => {
  it.each(SETTINGS_TABS)("%s anchors every section the registry lists", (tab) => {
    const anchored = anchorsIn(TAB_SOURCES[tab]);
    expect(SETTINGS_SECTIONS[tab].filter((section) => !anchored.has(section))).toEqual([]);
  });

  it.each(SETTINGS_TABS)("%s lists every section it anchors", (tab) => {
    const registered = new Set<string>(SETTINGS_SECTIONS[tab]);
    expect([...anchorsIn(TAB_SOURCES[tab])].filter((id) => !registered.has(id))).toEqual([]);
  });

  it("puts no anchor outside the tab bodies the map covers", () => {
    // The map above is the claim that a section belongs to ONE tab. An anchor
    // written into a component no tab's list reaches would satisfy both checks
    // above by never being read at all.
    const mapped = new Set<string>(Object.values(TAB_SOURCES).flatMap((files) => [...files]));
    const stray = rendererSources()
      .filter((file) => !mapped.has(file))
      .flatMap((file) => [...anchorsIn([file])].map((id) => `${file}: ${id}`));
    expect(stray).toEqual([]);
  });
});
