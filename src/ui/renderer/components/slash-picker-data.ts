/**
 * Shared catalog + filtering for the "/" entry point.
 *
 * Both the button-triggered SlashPicker popover and the inline caret-anchored
 * autocomplete menu import from here, so the command list, category model,
 * icons, and matching semantics stay identical — the two surfaces cannot drift.
 *
 * Categories present on this base: built-in slash commands, view shortcuts
 * (the QuickAction list — 홈/루틴/설정/플러그인 뷰), and installed plugins.
 * MCP-tool and assistant-skill enumeration is intentionally NOT a category
 * here: this app exposes no renderer-side data source for live MCP tools or
 * skills (only aggregate counts via `getRuntimeCounts`), so adding those
 * categories would require new IPC plumbing rather than a layout recovery.
 */
import { Terminal, Zap, Puzzle, type LucideIcon } from "lucide-react";
import { t } from "../../../i18n/runtime.js";
import type { QuickAction } from "./command-actions.js";
import type { PluginEntry } from "./PluginGridButton.js";

/** A built-in slash command. `labelKey` resolves to a human label via i18n. */
export interface SlashCommand {
  cmd: string;
  labelKey: string;
}

/**
 * The built-in slash commands. Mirrors the legacy CommandPopoverPanel list so
 * the unified picker keeps the exact same command surface.
 */
export const SLASH_COMMANDS: SlashCommand[] = [
  { cmd: "/new", labelKey: "commandPopoverPanel.cmdNew" },
  { cmd: "/sessions", labelKey: "commandPopoverPanel.cmdSessions" },
  { cmd: "/load", labelKey: "commandPopoverPanel.cmdLoad" },
  { cmd: "/compact", labelKey: "commandPopoverPanel.cmdCompact" },
  { cmd: "/remember", labelKey: "commandPopoverPanel.cmdRemember" },
  { cmd: "/memory", labelKey: "commandPopoverPanel.cmdMemory" },
  { cmd: "/vendor", labelKey: "commandPopoverPanel.cmdVendor" },
  { cmd: "/tools", labelKey: "commandPopoverPanel.cmdTools" },
  { cmd: "/permission", labelKey: "commandPopoverPanel.cmdPermission" },
  { cmd: "/permission dir list", labelKey: "commandPopoverPanel.cmdPermissionDirList" },
  { cmd: "/permission mode strict", labelKey: "commandPopoverPanel.cmdPermissionModeStrict" },
  { cmd: "/permission mode default", labelKey: "commandPopoverPanel.cmdPermissionModeDefault" },
  { cmd: "/permission mode auto", labelKey: "commandPopoverPanel.cmdPermissionModeAuto" },
  { cmd: "/permission mode allow", labelKey: "commandPopoverPanel.cmdPermissionModeAllow" },
  { cmd: "/permission hooks list", labelKey: "commandPopoverPanel.cmdPermissionHooksList" },
  { cmd: "/permission audit verify", labelKey: "commandPopoverPanel.cmdPermissionAuditVerify" },
  { cmd: "/help", labelKey: "commandPopoverPanel.cmdHelp" },
];

/** The drill-down category model — one step per group, with a global search. */
export type Category = "command" | "shortcut" | "plugin";

/** Stable category order for both the popover drill-down and the inline menu. */
export const CATEGORY_ORDER: Category[] = ["command", "shortcut", "plugin"];

export const CATEGORY_ICON: Record<Category, LucideIcon> = {
  command: Terminal,
  shortcut: Zap,
  plugin: Puzzle,
};

/** Human label for a category header (i18n). */
export function catLabel(category: Category): string {
  switch (category) {
    case "command":
      return t("slashPicker.catCommand");
    case "shortcut":
      return t("slashPicker.catShortcut");
    case "plugin":
      return t("slashPicker.catPlugin");
  }
}

/** Short description shown under a category in the drill-down list. */
export function catDescription(category: Category): string {
  switch (category) {
    case "command":
      return t("slashPicker.catCommandDesc");
    case "shortcut":
      return t("slashPicker.catShortcutDesc");
    case "plugin":
      return t("slashPicker.catPluginDesc");
  }
}

/** Normalize a typed query for case-insensitive substring matching. */
export function normalizeSlashQuery(query: string): string {
  return query.trim().toLowerCase();
}

/**
 * Filter the built-in commands by a normalized query, matching either the raw
 * command string or its translated label.
 */
export function filterSlashCommands(query: string): SlashCommand[] {
  const q = normalizeSlashQuery(query);
  if (!q) return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter(
    ({ cmd, labelKey }) => cmd.includes(q) || t(labelKey).toLowerCase().includes(q),
  );
}

/** Filter view shortcuts (QuickAction[]) by label substring. */
export function filterActions(actions: QuickAction[], query: string): QuickAction[] {
  const q = normalizeSlashQuery(query);
  if (!q) return actions;
  return actions.filter((a) => a.label.toLowerCase().includes(q));
}

/** Filter installed plugins by label substring. */
export function filterPlugins(plugins: PluginEntry[], query: string): PluginEntry[] {
  const q = normalizeSlashQuery(query);
  if (!q) return plugins;
  return plugins.filter((p) => p.label.toLowerCase().includes(q));
}
