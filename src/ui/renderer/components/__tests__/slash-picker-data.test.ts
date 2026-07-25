// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, it, expect } from "vitest";
import { MessageSquareText, Server, Sparkles } from "lucide-react";
import {
  CATEGORY_ICON,
  CATEGORY_ORDER,
  catLabel,
  catDescription,
  filterMcpPrompts,
  filterMcpTools,
  filterSkills,
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
    // Every category needs BOTH a label and a drill-down description —
    // `catLabel`/`catDescription` switch exhaustively, so a category added
    // without its cases would return undefined here.
    expect(catLabel("mcp-prompts").length).toBeGreaterThan(0);
    expect(catDescription("mcp-prompts").length).toBeGreaterThan(0);
  });

  it("filters MCP tools by name or server id", () => {
    expect(filterMcpTools(mcpTools, "")).toHaveLength(2);
    expect(filterMcpTools(mcpTools, "issue")).toEqual([mcpTools[0]]);
    expect(filterMcpTools(mcpTools, "linear")).toEqual([mcpTools[1]]);
  });

  it("filters MCP prompts by name, title, description, or server id", () => {
    expect(filterMcpPrompts(mcpPrompts, "")).toHaveLength(2);
    expect(filterMcpPrompts(mcpPrompts, "triage")).toEqual([mcpPrompts[0]]);
    expect(filterMcpPrompts(mcpPrompts, "inbound")).toEqual([mcpPrompts[0]]);
    expect(filterMcpPrompts(mcpPrompts, "daily")).toEqual([mcpPrompts[1]]);
    expect(filterMcpPrompts(mcpPrompts, "linear")).toEqual([mcpPrompts[1]]);
  });

  it("filters skills by name or description", () => {
    expect(filterSkills(skills, "")).toHaveLength(2);
    expect(filterSkills(skills, "research")).toEqual([skills[0]]);
    expect(filterSkills(skills, "diff")).toEqual([skills[1]]);
  });
});
