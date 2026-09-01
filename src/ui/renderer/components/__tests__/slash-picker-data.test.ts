// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, it, expect } from "vitest";
import { MessageSquareText, Server, Sparkles } from "lucide-react";
import {
  SLASH_COMMANDS,
  CATEGORY_ICON,
  CATEGORY_ORDER,
  catLabel,
  filterMcpTools,
  filterSkills,
  buildComposerMenuSections,
  type McpPromptEntry,
  type McpToolEntry,
  type SkillEntry,
} from "../slash-picker-data.js";

const mcpTools: McpToolEntry[] = [
  { name: "github__create_issue", serverId: "github" },
  { name: "linear__list_tickets", serverId: "linear" },
];

const mcpPrompts: McpPromptEntry[] = [
  { name: "triage", serverId: "github", description: "Sort inbound issues", arguments: [] },
  { name: "standup", serverId: "linear", title: "Daily standup", arguments: [] },
];

const skills: SkillEntry[] = [
  { name: "deep-research", description: "Fan-out web research" },
  { name: "code-review", description: "Review the current diff" },
];

describe("slash-picker-data — category model (mcp tools, mcp prompts, skills)", () => {
  it("CATEGORY_ORDER lists every category in order", () => {
    expect(CATEGORY_ORDER).toEqual([
      "command",
      "shortcut",
      "plugin",
      "mcp",
      "mcp-prompts",
      "skills",
    ]);
  });

  it("maps the mcp + skills categories to their spec icons", () => {
    expect(CATEGORY_ICON.mcp).toBe(Server);
    expect(CATEGORY_ICON["mcp-prompts"]).toBe(MessageSquareText);
    expect(CATEGORY_ICON.skills).toBe(Sparkles);
  });

  it("resolves human labels for the new categories", () => {
    expect(catLabel("mcp").length).toBeGreaterThan(0);
    expect(catLabel("skills").length).toBeGreaterThan(0);
    // `catLabel` switches exhaustively, so a category added without its case
    // would return undefined here.
    expect(catLabel("mcp-prompts").length).toBeGreaterThan(0);
  });

  it("filters MCP tools by name or server id", () => {
    expect(filterMcpTools(mcpTools, "")).toHaveLength(2);
    expect(filterMcpTools(mcpTools, "issue")).toEqual([mcpTools[0]]);
    expect(filterMcpTools(mcpTools, "linear")).toEqual([mcpTools[1]]);
  });

  it("filters skills by name or description", () => {
    expect(filterSkills(skills, "")).toHaveLength(2);
    expect(filterSkills(skills, "research")).toEqual([skills[0]]);
    expect(filterSkills(skills, "diff")).toEqual([skills[1]]);
  });

  it("carries a prompt's and a skill's description into the row's second line", () => {
    // The deleted panel drew two lines per row. A native menu keeps the second
    // one in `sublabel`, so dropping it here would silently cost the user every
    // description while every other assertion still passed.
    const sections = buildComposerMenuSections({
      actions: [],
      plugins: [],
      mcpTools,
      mcpPrompts,
      skills,
      onInsert: () => {},
      onSelectPlugin: () => {},
      onRunMcpPrompt: () => {},
    });
    const rows = new Map(sections.flatMap((s) => s.items).map((row) => [row.id, row]));
    expect(rows.get("category:mcp-prompts")!.submenu!.map((r) => r.sublabel))
      .toEqual(["Sort inbound issues", undefined]);
    expect(rows.get("category:skills")!.submenu!.map((r) => r.sublabel))
      .toEqual(["Fan-out web research", "Review the current diff"]);
  });

  it("leaves out a category with nothing in it rather than drawing an empty submenu", () => {
    const sections = buildComposerMenuSections({
      actions: [],
      plugins: [],
      mcpTools: [],
      mcpPrompts: [],
      skills: [],
      onInsert: () => {},
      onSelectPlugin: () => {},
      onRunMcpPrompt: () => {},
    });
    // Only the built-in commands survive: no actions, no plugins, no MCP, no
    // skills. The empty shortcut section is dropped too, so what is left is one
    // section holding one category.
    expect(sections).toHaveLength(1);
    expect(sections[0]!.items.map((row) => row.id)).toEqual(["category:command"]);
  });

  it("SLASH_COMMANDS is the one built-in command list: unique commands, each with a catalog label", () => {
    const commands = SLASH_COMMANDS.map((entry) => entry.cmd);
    expect(new Set(commands).size).toBe(commands.length);
    expect(commands).toContain("/help");
    for (const entry of SLASH_COMMANDS) {
      expect(entry.cmd.startsWith("/")).toBe(true);
      expect(entry.labelKey).toMatch(/^slashPickerPanel\.cmd/);
    }
  });
});
