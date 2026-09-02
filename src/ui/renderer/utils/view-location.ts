/**
 * Where the main window is, as one value.
 *
 * `activeView` alone cannot say it: Settings is one view key but several
 * places, and a path that renders "Settings" while the user is on the
 * Permissions page is exactly the kind of lie this series has been removing.
 * The settings tab became observable from outside the panel in #1992, so the
 * location can now carry it.
 *
 * Deliberately NOT part of a location:
 *   - the chat session. Loading another conversation changes what `home`
 *     shows and its root crumb names the context it is in — the plain
 *     conversations list, or the project the session belongs to — but the
 *     location stays the same one; sessions are not a navigation depth in
 *     the sidebar. (Owner decision.)
 *   - the marketplace, which opens an external URL and is not an in-app
 *     place at all.
 */
import { Brain, CalendarDays, KanbanSquare, Repeat2, type LucideIcon } from "lucide-react";
import {
  SETTINGS_TAB_LABEL_KEYS,
  normalizeSettingsTab,
  type SettingsTab,
} from "../../../shared/settings-tabs.js";
import { parseViewKey, type BuiltinViewKey, type InlineViewKey } from "../../../shared/view-key.js";
import type { TranslateFn } from "../../../i18n/translate.js";
import type { ProjectIdentity } from "../../../shared/project-identity.js";

export interface ViewLocation {
  view: InlineViewKey;
  /** Only meaningful when `view === "settings"`; absent everywhere else. */
  settingsTab?: SettingsTab;
}

/**
 * Build a location from the two pieces of app state that carry it, dropping
 * the settings tab when it cannot apply. Without that drop, leaving Settings
 * and coming back would compare unequal against an otherwise identical
 * location and push a duplicate history entry.
 */
export function toViewLocation(view: InlineViewKey, settingsTab: string): ViewLocation {
  return view === "settings"
    ? { view, settingsTab: normalizeSettingsTab(settingsTab) }
    : { view };
}

export function sameViewLocation(a: ViewLocation, b: ViewLocation): boolean {
  return a.view === b.view && a.settingsTab === b.settingsTab;
}

/** One crumb. `target` is absent on the last one — you cannot navigate to
 *  where you already are, so it renders as text rather than a control. */
export interface BreadcrumbSegment {
  key: string;
  label: string;
  target?: ViewLocation;
}


export interface BreadcrumbDeps {
  t: TranslateFn;
  /** Resolves a plugin view key to its display title. */
  pluginViewLabel: (viewKey: string) => string | undefined;
  /**
   * The project the current conversation belongs to, or absent for a plain
   * conversation. The same fact the sidebar sorts sessions by: a session
   * whose project is the workspace default is a plain chat, so callers pass
   * only a NAMED project here.
   */
  sessionProject?: Pick<ProjectIdentity, "projectName">;
}

/**
 * The path for a location, deepest last.
 *
 * Every label comes from an existing catalogue key — the sidebar's own labels
 * for built-ins, `SETTINGS_TAB_LABEL_KEYS` for settings pages (the same map
 * the settings panel labels its nav with), and the plugin's declared title.
 * Nothing here invents a name for a place, so the path cannot describe a
 * destination differently from the control that reaches it.
 */
export function viewLocationBreadcrumb(
  location: ViewLocation,
  deps: BreadcrumbDeps,
): BreadcrumbSegment[] {
  const { t } = deps;

  if (location.view === "settings") {
    const tab = location.settingsTab ?? "llm";
    return [
      { key: "settings", label: t("mainToolbar.settings"), target: { view: "settings", settingsTab: "llm" } },
      { key: `settings:${tab}`, label: t(SETTINGS_TAB_LABEL_KEYS[tab]) },
    ];
  }

  const parsed = parseViewKey(location.view);
  if (parsed?.kind === "plugin") {
    return [
      { key: "plugins", label: t("sidebar.pluginsLabel") },
      {
        key: location.view,
        // Fall back to the plugin id when the view list has not loaded yet:
        // a raw id is honest, an empty crumb is not.
        label: deps.pluginViewLabel(location.view) ?? parsed.pluginId,
      },
    ];
  }

  if (location.view === "home") {
    // There is no "home": the conversation surface is either the plain
    // conversations list or a project, the two tabs the sidebar already names.
    // Neither crumb carries a target — this IS where the user is.
    const project = deps.sessionProject;
    return project
      ? [
        { key: "projects", label: t("sidebar.projectsTab") },
        { key: "home", label: project.projectName },
      ]
      : [{ key: "home", label: t("sidebar.chatsTab") }];
  }

  // Settings, plugins and home returned above; what is left is a built-in.
  return [{ key: location.view, label: t(BUILTIN_LABEL_KEYS[location.view as keyof typeof BUILTIN_LABEL_KEYS]) }];
}

/**
 * A built-in view that is a PLACE of its own: neither the conversation surface
 * nor Settings, which are their own shapes. These are the views that become a
 * pane body with the frame's header carrying their name.
 */
export type FeatureViewKey = Exclude<BuiltinViewKey, "home" | "settings">;

/**
 * Built-in view → the label its own sidebar entry already uses. Reused rather
 * than restated so a renamed destination cannot be one thing in the rail and
 * another in the path.
 */
export const BUILTIN_LABEL_KEYS: Record<FeatureViewKey, string> = {
  "work-board": "mainToolbar.workBoard",
  routines: "mainToolbar.routines",
  insights: "mainToolbar.insights",
  starred: "mainToolbar.insights",
  memory: "mainToolbar.memory",
};

/**
 * Built-in view → its glyph, beside the label it is named by.
 *
 * The sidebar row that opens a view and the pane header that then carries it
 * are the same destination seen twice, so they read from one map rather than
 * each picking an icon: a glyph changed in one place cannot become two
 * different pictures of the same place. `memory` has no sidebar row today
 * (removed in the 2026-07 shell refinement, the view stays routable) and is
 * listed here because the pane header still has to draw it.
 */
export const BUILTIN_VIEW_ICONS: Record<FeatureViewKey, LucideIcon> = {
  "work-board": KanbanSquare,
  routines: Repeat2,
  insights: CalendarDays,
  starred: CalendarDays,
  memory: Brain,
};
