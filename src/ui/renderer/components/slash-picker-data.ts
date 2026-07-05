



import { Terminal, Zap, Puzzle, Server, Sparkles, type LucideIcon } from "lucide-react";
import { t } from "../../../i18n/runtime.js";
import type { QuickAction } from "./command-actions.js";
import type { PluginEntry } from "./PluginGridButton.js";

/** A single live MCP-server tool, namespaced by its server. */
export interface McpToolEntry {
  /** Namespaced tool name as registered (e.g. "serverId__toolName"). */
  name: string;
  /** Originating MCP server id. */
  serverId: string;
}

/** A single registered assistant skill. */
export interface SkillEntry {
  name: string;
  description: string;
}

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
export type Category = "command" | "shortcut" | "plugin" | "mcp" | "skills";

/** Stable category order for both the popover drill-down and the inline menu. */
export const CATEGORY_ORDER: Category[] = ["command", "shortcut", "plugin", "mcp", "skills"];

export const CATEGORY_ICON: Record<Category, LucideIcon> = {
  command: Terminal,
  shortcut: Zap,
  plugin: Puzzle,
  mcp: Server,
  skills: Sparkles,
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
    case "mcp":
      return t("slashPicker.catMcp");
    case "skills":
      return t("slashPicker.catSkills");
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
    case "mcp":
      return t("slashPicker.catMcpDesc");
    case "skills":
      return t("slashPicker.catSkillsDesc");
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

/** Filter live MCP-server tools by name or server-id substring. */
export function filterMcpTools(tools: McpToolEntry[], query: string): McpToolEntry[] {
  const q = normalizeSlashQuery(query);
  if (!q) return tools;
  return tools.filter(
    (m) => m.name.toLowerCase().includes(q) || m.serverId.toLowerCase().includes(q),
  );
}

/** Filter registered skills by name or description substring. */
export function filterSkills(skills: SkillEntry[], query: string): SkillEntry[] {
  const q = normalizeSlashQuery(query);
  if (!q) return skills;
  return skills.filter(
    (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
  );
}
