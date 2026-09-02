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

const personas = [
  { id: "default", name: "기본", systemPromptAdd: "", isDefault: true },
  { id: "coding", name: "코딩", systemPromptAdd: "Code carefully." },
];

/** The builder's inputs with nothing installed and no persona chosen. */
const bare = {
  personas,
  activePersonaId: "default",
  plugins: [],
  mcpTools: [],
  mcpPrompts: [],
  skills: [],
  onSelectPersona: () => {},
  onInsert: () => {},
  onSelectPlugin: () => {},
  onRunMcpPrompt: () => {},
};

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
    const sections = buildComposerMenuSections({ ...bare, mcpTools, mcpPrompts, skills });
    const rows = new Map(sections.flatMap((s) => s.items).map((row) => [row.id, row]));
    expect(rows.get("category:mcp-prompts")!.submenu!.map((r) => r.sublabel))
      .toEqual(["Sort inbound issues", undefined]);
    expect(rows.get("category:skills")!.submenu!.map((r) => r.sublabel))
      .toEqual(["Fan-out web research", "Review the current diff"]);
  });

  it("leaves out a category with nothing in it rather than drawing an empty submenu", () => {
    const sections = buildComposerMenuSections(bare);
    // Only the persona and the built-in commands survive: nothing installed, so
    // no plugins, no MCP, no skills.
    expect(sections).toHaveLength(1);
    expect(sections[0]!.items.map((row) => row.id)).toEqual(["category:persona", "category:command"]);
    // …and that applies to the persona list too, should it ever be empty.
    expect(buildComposerMenuSections({ ...bare, personas: [] })[0]!.items.map((row) => row.id))
      .toEqual(["category:command"]);
  });

  it("holds only what goes INTO a message — never a row that navigates the window", () => {
    // This menu hangs off the composer. The view shortcuts it used to open with
    // are navigation and belong to the sidebar; ten of them above the divider
    // also pushed the three things the button is for below the fold. They are
    // still reachable by typing in the "/" menu, which `filterActions` serves.
    const sections = buildComposerMenuSections({
      ...bare,
      plugins: [{ viewKey: "plugin:meeting:panel", label: "미팅 열기" }],
      mcpTools,
      mcpPrompts,
      skills,
    });
    // One section: no flat block above the divider any more.
    expect(sections).toHaveLength(1);
    const ids = sections[0]!.items.map((row) => row.id);
    expect(ids).toEqual([
      "category:persona",
      "category:command",
      "category:plugin",
      "category:mcp",
      "category:mcp-prompts",
      "category:skills",
    ]);
    // Every row is a category that opens a submenu — nothing acts on click.
    expect(sections[0]!.items.every((row) => (row.submenu?.length ?? 0) > 0)).toBe(true);
    expect(ids.some((id) => id.startsWith("shortcut:"))).toBe(false);
  });

  it("draws the personas as radio rows, the active one checked, and reports the id on pick", () => {
    const picked: string[] = [];
    const sections = buildComposerMenuSections({
      ...bare,
      activePersonaId: "coding",
      onSelectPersona: (id) => picked.push(id),
    });
    const persona = sections[0]!.items[0]!;
    expect(persona.id).toBe("category:persona");
    expect(persona.label.length).toBeGreaterThan(0);
    // Every row carries a state — that is what makes main draw it as a radio
    // item — and exactly the active one is on. The rows that are NOT personas
    // carry none, so they stay plain commands.
    expect(persona.submenu!.map((row) => [row.id, row.label, row.checked])).toEqual([
      ["persona:default", "기본", false],
      ["persona:coding", "코딩", true],
    ]);
    expect(sections[0]!.items[1]!.submenu!.every((row) => row.checked === undefined)).toBe(true);
    void persona.submenu![0]!.onSelect!();
    expect(picked).toEqual(["default"]);
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
