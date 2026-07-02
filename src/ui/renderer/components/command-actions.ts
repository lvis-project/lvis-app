import { Folder, Globe, Table, Terminal, type LucideIcon } from "lucide-react";
import { getPluginViewLabel, toViewKey } from "../api-client.js";
import { t } from "../../../i18n/runtime.js";
import type { WorkspaceTabKind } from "../preview/workspace-tabs.js";
import type { PluginUiExtension } from "../types.js";

export interface QuickAction {
  id: string;
  label: string;
  run: () => void | Promise<void>;
}

/**
 * Single source of truth for the workspace-rail launcher (§6.10.3). Each
 * `WorkspaceTabKind` maps to its launcher label, keyboard shortcut hint, and
 * icon. The empty-state launcher in ChatSidePanel renders one row per entry and
 * the keyboard-shortcut handler binds off the same table, so the picker and the
 * app command surface share one list rather than duplicating it. Order here is
 * the render order in the launcher.
 *
 * `사이드채팅` (side chat) is intentionally deferred — it is not a launcher item.
 */
export interface WorkspaceLauncherItem {
  kind: WorkspaceTabKind;
  labelKey: string;
  /** Human-readable shortcut hint shown on the right of the launcher row. */
  shortcutHint: string;
  /**
   * Structured shortcut binding matched against KeyboardEvent. `null` means the
   * hint is displayed but no key is bound (no matching accelerator).
   */
  shortcut: WorkspaceLauncherShortcut | null;
  icon: LucideIcon;
}

export interface WorkspaceLauncherShortcut {
  /** Lower-case `KeyboardEvent.key` to match (after normalization). */
  key: string;
  /** Requires the primary meta/ctrl modifier (⌘ on macOS, Ctrl elsewhere). */
  meta: boolean;
  /** Requires Ctrl specifically (for ⌃⇧G — Ctrl on every platform). */
  ctrl: boolean;
  shift: boolean;
}

export const WORKSPACE_TAB_LAUNCHER: readonly WorkspaceLauncherItem[] = [
  {
    kind: "preview",
    labelKey: "chatPreviewRail.launcher.review",
    shortcutHint: "⌃⇧G",
    shortcut: { key: "g", meta: false, ctrl: true, shift: true },
    icon: Table,
  },
  {
    kind: "terminal",
    labelKey: "chatPreviewRail.launcher.terminal",
    shortcutHint: "",
    shortcut: null,
    icon: Terminal,
  },
  {
    kind: "browser",
    labelKey: "chatPreviewRail.launcher.browser",
    shortcutHint: "⌘T",
    shortcut: { key: "t", meta: true, ctrl: false, shift: false },
    icon: Globe,
  },
  {
    kind: "file-browser",
    labelKey: "chatPreviewRail.launcher.file",
    shortcutHint: "⌘P",
    shortcut: { key: "p", meta: true, ctrl: false, shift: false },
    icon: Folder,
  },
];

/**
 * Match a KeyboardEvent against a launcher shortcut. Kept next to the table so
 * the launcher UI and the panel-scoped keydown handler agree on semantics.
 * `meta` accepts either the platform meta key (⌘) or Ctrl so the binding works
 * on macOS and other platforms; `ctrl` requires Ctrl exactly (⌃⇧G).
 */
export function matchesLauncherShortcut(
  shortcut: WorkspaceLauncherShortcut,
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
): boolean {
  if (event.altKey) return false;
  if (event.key.toLowerCase() !== shortcut.key) return false;
  if (event.shiftKey !== shortcut.shift) return false;
  if (shortcut.ctrl) {
    // ⌃-anchored binding: require Ctrl specifically, never plain ⌘.
    return event.ctrlKey && !event.metaKey;
  }
  if (shortcut.meta) {
    // ⌘-anchored binding: accept ⌘ (macOS) or Ctrl (other platforms).
    return event.metaKey || event.ctrlKey;
  }
  return !event.metaKey && !event.ctrlKey;
}

/**
 * Build the default quick-action list from app state.
 * Kept separate from CommandPopover so App does not import cmdk at startup.
 */
export function buildQuickActions({
  setActiveView,
  openSettings,
  handleNewChat,
  pluginViews,
}: {
  setActiveView: (key: string) => void;
  openSettings: () => void;
  handleNewChat: () => void | Promise<void>;
  pluginViews: PluginUiExtension[];
}): QuickAction[] {
  return [
    { id: "home",       label: t("commandActions.goHome"),        run: () => setActiveView("home") },
    { id: "work-board", label: t("commandActions.viewWorkBoard"), run: () => setActiveView("work-board") },
    { id: "routines",   label: t("commandActions.viewRoutines"),  run: () => setActiveView("routines") },
    { id: "settings",  label: t("commandActions.openSettings"), run: openSettings },
    { id: "new-chat",  label: t("commandActions.newChat"),      run: handleNewChat },
    ...pluginViews.map((i) => {
      const viewKey = toViewKey(i);
      const pluginLabel = getPluginViewLabel(i);
      return {
        id: `v:${viewKey}`,
        label: t("commandActions.openPlugin", { pluginLabel }),
        run: () => setActiveView(viewKey),
      };
    }),
  ];
}
