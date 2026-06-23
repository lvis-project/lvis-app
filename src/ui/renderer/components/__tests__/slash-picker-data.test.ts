// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, it, expect } from "vitest";
import { Server, Sparkles } from "lucide-react";
import {
  CATEGORY_ICON,
  CATEGORY_ORDER,
  catLabel,
  filterMcpTools,
  filterSkills,
  type McpToolEntry,
  type SkillEntry,
} from "../slash-picker-data.js";

const mcpTools: McpToolEntry[] = [
  { name: "github__create_issue", serverId: "github" },
  { name: "linear__list_tickets", serverId: "linear" },
];

const skills: SkillEntry[] = [
  { name: "deep-research", description: "Fan-out web research" },
  { name: "code-review", description: "Review the current diff" },
];

describe("slash-picker-data — 5-category model (mcp + skills added)", () => {
  it("CATEGORY_ORDER lists all five categories in order", () => {
    expect(CATEGORY_ORDER).toEqual(["command", "shortcut", "plugin", "mcp", "skills"]);
  });

  it("maps the mcp + skills categories to their spec icons", () => {
    expect(CATEGORY_ICON.mcp).toBe(Server);
    expect(CATEGORY_ICON.skills).toBe(Sparkles);
  });

  it("resolves human labels for the new categories", () => {
    expect(catLabel("mcp").length).toBeGreaterThan(0);
    expect(catLabel("skills").length).toBeGreaterThan(0);
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
});
