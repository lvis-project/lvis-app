



import { Terminal, Zap, Puzzle, Server, Sparkles, MessageSquareText, type LucideIcon } from "lucide-react";
import { t } from "../../../i18n/runtime.js";
import type { QuickAction } from "./command-actions.js";
import type { PluginEntry } from "./PluginGridButton.js";
import type { NativeMenuRow } from "../hooks/use-native-context-menu.js";

/** A single live MCP-server tool, namespaced by its server. */
export interface McpToolEntry {
  /** Namespaced tool name as registered (e.g. "serverId__toolName"). */
  name: string;
  /** Originating MCP server id. */
  serverId: string;
}

/**
 * A prompt a connected MCP server declared. Prompts are a USER-controlled
 * primitive: the user picks one here, the host fetches it, and the server's text
 * enters the turn with untrusted provenance. Never model-callable.
 */
export interface McpPromptEntry {
  name: string;
  serverId: string;
  title?: string;
  description?: string;
  arguments: Array<{ name: string; description?: string; required: boolean }>;
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

/** The built-in slash commands — the one list the picker renders. */
export const SLASH_COMMANDS: SlashCommand[] = [
  { cmd: "/new", labelKey: "slashPickerPanel.cmdNew" },
  { cmd: "/sessions", labelKey: "slashPickerPanel.cmdSessions" },
  { cmd: "/load", labelKey: "slashPickerPanel.cmdLoad" },
  { cmd: "/compact", labelKey: "slashPickerPanel.cmdCompact" },
  { cmd: "/remember", labelKey: "slashPickerPanel.cmdRemember" },
  { cmd: "/memory", labelKey: "slashPickerPanel.cmdMemory" },
  { cmd: "/vendor", labelKey: "slashPickerPanel.cmdVendor" },
  { cmd: "/tools", labelKey: "slashPickerPanel.cmdTools" },
  { cmd: "/permission", labelKey: "slashPickerPanel.cmdPermission" },
  { cmd: "/permission dir list", labelKey: "slashPickerPanel.cmdPermissionDirList" },
  { cmd: "/permission mode strict", labelKey: "slashPickerPanel.cmdPermissionModeStrict" },
  { cmd: "/permission mode default", labelKey: "slashPickerPanel.cmdPermissionModeDefault" },
  { cmd: "/permission mode auto", labelKey: "slashPickerPanel.cmdPermissionModeAuto" },
  { cmd: "/permission mode allow", labelKey: "slashPickerPanel.cmdPermissionModeAllow" },
  { cmd: "/permission hooks list", labelKey: "slashPickerPanel.cmdPermissionHooksList" },
  { cmd: "/permission audit verify", labelKey: "slashPickerPanel.cmdPermissionAuditVerify" },
  { cmd: "/help", labelKey: "slashPickerPanel.cmdHelp" },
];

/** The drill-down category model — one step per group, with a global search. */
export type Category = "command" | "shortcut" | "plugin" | "mcp" | "mcp-prompts" | "skills";

/** Stable category order for both the popover drill-down and the inline menu. */
export const CATEGORY_ORDER: Category[] = ["command", "shortcut", "plugin", "mcp", "mcp-prompts", "skills"];

export const CATEGORY_ICON: Record<Category, LucideIcon> = {
  command: Terminal,
  shortcut: Zap,
  plugin: Puzzle,
  mcp: Server,
  "mcp-prompts": MessageSquareText,
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
    case "mcp-prompts":
      return t("slashPicker.catMcpPrompts");
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
    case "mcp-prompts":
      return t("slashPicker.catMcpPromptsDesc");
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

/** Filter server-declared prompts by name, title, description, or server id. */
export function filterMcpPrompts(prompts: McpPromptEntry[], query: string): McpPromptEntry[] {
  const q = normalizeSlashQuery(query);
  if (!q) return prompts;
  return prompts.filter((p) =>
    p.name.toLowerCase().includes(q)
    || p.serverId.toLowerCase().includes(q)
    || (p.title ?? "").toLowerCase().includes(q)
    || (p.description ?? "").toLowerCase().includes(q),
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

/**
 * The composer's command menu as native menu rows.
 *
 * The picker used to be a search box over a flat list; a native menu cannot
 * filter as you type, so the shape carries the weight instead. What the user
 * reaches for constantly — the view shortcuts — stays flat at the top, and each
 * long, install-dependent list (plugins, MCP tools and prompts, skills) sits
 * behind its own submenu. Typing to find something is still the "/" menu in the
 * composer, which is unchanged.
 *
 * A category with nothing in it is left out rather than shown empty: an
 * always-present row that never opens teaches the user it is broken.
 */
export function buildComposerMenuSections(input: {
  actions: QuickAction[];
  plugins: PluginEntry[];
  mcpTools: McpToolEntry[];
  mcpPrompts: McpPromptEntry[];
  skills: SkillEntry[];
  onInsert: (cmd: string) => void;
  onSelectPlugin: (viewKey: string) => void;
  onRunMcpPrompt: (prompt: McpPromptEntry) => void;
}): Array<{ items: NativeMenuRow[] }> {
  const shortcuts: NativeMenuRow[] = input.actions.map((action) => ({
    id: `shortcut:${action.id}`,
    label: action.label,
    onSelect: () => action.run(),
  }));

  const categories: NativeMenuRow[] = [];
  const push = (category: Category, rows: NativeMenuRow[]): void => {
    if (rows.length === 0) return;
    categories.push({ id: `category:${category}`, label: catLabel(category), submenu: rows });
  };

  push("command", SLASH_COMMANDS.map((command) => ({
    id: `command:${command.cmd}`,
    label: `${command.cmd} — ${t(command.labelKey)}`,
    // The trailing space is what lets the user keep typing arguments.
    onSelect: () => input.onInsert(`${command.cmd} `),
  })));
  push("plugin", input.plugins.map((plugin) => ({
    id: `plugin:${plugin.viewKey}`,
    label: plugin.label,
    onSelect: () => input.onSelectPlugin(plugin.viewKey),
  })));
  push("mcp", input.mcpTools.map((tool) => ({
    id: `mcp:${tool.serverId}:${tool.name}`,
    label: tool.name,
    onSelect: () => input.onInsert(`/${tool.name} `),
  })));
  push("mcp-prompts", input.mcpPrompts.map((prompt) => ({
    id: `mcp-prompt:${prompt.serverId}:${prompt.name}`,
    label: prompt.title ?? prompt.name,
    onSelect: () => input.onRunMcpPrompt(prompt),
  })));
  push("skills", input.skills.map((skill) => ({
    id: `skill:${skill.name}`,
    label: skill.name,
    onSelect: () => input.onInsert(`/${skill.name} `),
  })));

  return [{ items: shortcuts }, { items: categories }].filter(
    (section) => section.items.length > 0,
  );
}
