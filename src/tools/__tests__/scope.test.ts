/**
 * Phase 1 Lazy Tool Scoping — getToolSchemasForScope regression tests.
 *
 * Verifies scope filter semantics:
 *   - Empty activePluginIds → builtin-only (plugin tools excluded)
 *   - Active plugin scope alone → catalog eligibility, not loaded schemas
 *   - Plugin/MCP schemas load only by activeToolNames
 *   - Builtins toggle → builtins excluded when includeBuiltins=false
 */
import { describe, it, expect } from "vitest";

import { ToolRegistry } from "../registry.js";
import { createDynamicTool } from "../base.js";

function makeBuiltin(name: string) {
  return createDynamicTool({
    name,
    description: `builtin ${name}`,
    source: "builtin",
    category: "read",
    jsonSchema: { type: "object", properties: {} },
    execute: async () => ({ output: "", isError: false }),
  });
}

function makePluginTool(name: string, pluginId: string) {
  return createDynamicTool({
    name,
    description: `plugin ${name}`,
    source: "plugin",
    category: "read",
    pluginId,
    jsonSchema: { type: "object", properties: {} },
    execute: async () => ({ output: "", isError: false }),
  });
}

function makeMcpTool(name: string, mcpServerId: string) {
  return createDynamicTool({
    name,
    description: `mcp ${name}`,
    source: "mcp",
    category: "network",
    mcpServerId,
    jsonSchema: { type: "object", properties: {} },
    execute: async () => ({ output: "", isError: false }),
  });
}

function seed(): ToolRegistry {
  const r = new ToolRegistry();
  r.register(makeBuiltin("bash"));
  r.register(makeBuiltin("web_search"));
  r.register(makePluginTool("meeting_start", "com.example.meeting"));
  r.register(makePluginTool("meeting_stop", "com.example.meeting"));
  r.register(makePluginTool("email_list", "com.example.email"));
  r.register(makeMcpTool("mcp_fetch", "server-1"));
  return r;
}

describe("ToolRegistry.getToolSchemasForScope — Phase 1 Lazy Tool Scoping", () => {
  it("empty activePluginIds → builtins only (plugin tools excluded)", () => {
    const r = seed();
    const schemas = r.getToolSchemasForScope({
      activePluginIds: new Set<string>(),
      includeBuiltins: true,
      includeMcp: false,
    });
    const names = schemas.map((s) => s.name).sort();
    expect(names).toEqual(["bash", "web_search"]);
  });

  it("active plugin scope alone does not load plugin schemas", () => {
    const r = seed();
    const schemas = r.getToolSchemasForScope({
      activePluginIds: new Set(["com.example.meeting"]),
      includeBuiltins: true,
      includeMcp: false,
    });
    const names = schemas.map((s) => s.name).sort();
    expect(names).toEqual(["bash", "web_search"]);
  });

  it("plugin schemas load individually by activeToolNames", () => {
    const r = seed();
    const schemas = r.getToolSchemasForScope({
      activePluginIds: new Set(["com.example.meeting", "com.example.email"]),
      activeToolNames: new Set(["meeting_stop", "email_list"]),
      includeBuiltins: true,
      includeMcp: false,
    });
    const names = schemas.map((s) => s.name).sort();
    expect(names).toEqual([
      "bash",
      "email_list",
      "meeting_stop",
      "web_search",
    ]);
  });

  it("schema entries preserve tool provenance metadata", () => {
    const r = seed();
    const schemas = r.getToolSchemasForScope({
      activePluginIds: new Set(["com.example.meeting"]),
      activeToolNames: new Set(["meeting_stop", "mcp_fetch"]),
      includeBuiltins: true,
      includeMcp: true,
    });

    expect(schemas.find((s) => s.name === "bash")).toMatchObject({
      source: "builtin",
      category: "read",
    });
    expect(schemas.find((s) => s.name === "meeting_stop")).toMatchObject({
      source: "plugin",
      category: "read",
      pluginId: "com.example.meeting",
    });
    expect(schemas.find((s) => s.name === "mcp_fetch")).toMatchObject({
      source: "mcp",
      category: "network",
      mcpServerId: "server-1",
    });
  });

  it("includeMcp=true still requires activeToolNames for MCP schemas", () => {
    const r = seed();
    const withMcp = r.getToolSchemasForScope({
      activePluginIds: new Set<string>(),
      activeToolNames: new Set(["mcp_fetch"]),
      includeBuiltins: true,
      includeMcp: true,
    });
    expect(withMcp.map((s) => s.name)).toContain("mcp_fetch");

    const withoutMcp = r.getToolSchemasForScope({
      activePluginIds: new Set<string>(),
      includeBuiltins: true,
      includeMcp: false,
    });
    expect(withoutMcp.map((s) => s.name)).not.toContain("mcp_fetch");
  });

  it("includeBuiltins=false excludes host builtins", () => {
    const r = seed();
    const schemas = r.getToolSchemasForScope({
      activePluginIds: new Set(["com.example.meeting"]),
      activeToolNames: new Set(["meeting_start"]),
      includeBuiltins: false,
      includeMcp: false,
    });
    const names = schemas.map((s) => s.name).sort();
    expect(names).toEqual(["meeting_start"]);
  });

  it("accepts string[] in addition to Set for activePluginIds", () => {
    const r = seed();
    const schemas = r.getToolSchemasForScope({
      activePluginIds: ["com.example.email"],
      activeToolNames: ["email_list"],
      includeBuiltins: false,
      includeMcp: false,
    });
    expect(schemas.map((s) => s.name)).toEqual(["email_list"]);
  });

  it("deny rules still apply on top of scope filter", () => {
    const r = seed();
    r.setDenyRules([{ pattern: "bash" }]);
    const schemas = r.getToolSchemasForScope({
      activePluginIds: new Set<string>(),
      includeBuiltins: true,
      includeMcp: false,
    });
    expect(schemas.map((s) => s.name)).not.toContain("bash");
  });
});

describe("ToolRegistry — Tool-Level Deferral", () => {
  function seedWithToolSearch(): ToolRegistry {
    const r = seed();
    r.register(makeBuiltin("tool_search"));
    return r;
  }

  it("tool_search is visible whenever builtins are included", () => {
    const r = seedWithToolSearch();
    const schemas = r.getToolSchemasForScope({
      activePluginIds: new Set<string>(),
      includeBuiltins: true,
      includeMcp: false,
      deferral: false,
    });
    expect(schemas.map((s) => s.name)).toContain("tool_search");
  });

  it("plugin tools load individually by activeToolNames", () => {
    const r = seedWithToolSearch();
    const schemas = r.getToolSchemasForScope({
      activePluginIds: new Set(["com.example.meeting"]),
      activeToolNames: new Set(["meeting_start"]),
      includeBuiltins: true,
      includeMcp: true,
      deferral: true,
    });
    const names = schemas.map((s) => s.name).sort();
    // builtins + tool_search load; only the preloaded meeting_start loads,
    // NOT meeting_stop (deferred), and not mcp_fetch (not in activeToolNames).
    expect(names).toEqual(["bash", "meeting_start", "tool_search", "web_search"]);
  });

  it("plugin tool not in activeToolNames stays deferred", () => {
    const r = seedWithToolSearch();
    const schemas = r.getToolSchemasForScope({
      activePluginIds: new Set(["com.example.meeting"]),
      activeToolNames: new Set<string>(),
      includeBuiltins: true,
      includeMcp: true,
      deferral: true,
    });
    expect(schemas.map((s) => s.name)).not.toContain("meeting_start");
    expect(schemas.map((s) => s.name)).not.toContain("meeting_stop");
  });

  it("activeToolNames cannot expose a plugin outside activePluginIds", () => {
    const r = seedWithToolSearch();
    const schemas = r.getToolSchemasForScope({
      activePluginIds: new Set<string>(),
      activeToolNames: new Set(["meeting_start"]),
      includeBuiltins: true,
      includeMcp: false,
      deferral: true,
    });
    expect(schemas.map((s) => s.name)).not.toContain("meeting_start");
  });
});

describe("ToolRegistry.getToolCatalogForScope", () => {
  it("lists in-scope plugin/mcp tools that are NOT loaded", () => {
    const r = seed();
    const catalog = r.getToolCatalogForScope({
      activePluginIds: new Set(["com.example.meeting"]),
      activeToolNames: new Set(["meeting_start"]),
      includeMcp: true,
    });
    const names = catalog.map((c) => c.name).sort();
    // meeting_start is loaded → excluded; meeting_stop deferred → present;
    // mcp_fetch in scope (includeMcp) and not loaded → present;
    // email_list plugin not active → excluded.
    expect(names).toEqual(["mcp_fetch", "meeting_stop"]);
  });

  it("catalog entries preserve plugin/MCP provenance metadata", () => {
    const r = seed();
    const catalog = r.getToolCatalogForScope({
      activePluginIds: new Set(["com.example.meeting"]),
      activeToolNames: new Set<string>(),
      includeMcp: true,
    });

    expect(catalog.find((c) => c.name === "meeting_start")).toMatchObject({
      source: "plugin",
      pluginId: "com.example.meeting",
    });
    expect(catalog.find((c) => c.name === "mcp_fetch")).toMatchObject({
      source: "mcp",
      mcpServerId: "server-1",
    });
  });

  it("excludes loaded tools (no duplication with the loaded path)", () => {
    const r = seed();
    const catalog = r.getToolCatalogForScope({
      activePluginIds: new Set(["com.example.meeting"]),
      activeToolNames: new Set(["meeting_start", "meeting_stop"]),
      includeMcp: false,
    });
    expect(catalog.map((c) => c.name)).not.toContain("meeting_start");
    expect(catalog.map((c) => c.name)).not.toContain("meeting_stop");
    expect(catalog.map((c) => c.name)).toEqual([]);
  });

  it("never includes builtins in the catalog", () => {
    const r = seed();
    const catalog = r.getToolCatalogForScope({
      activePluginIds: new Set<string>(),
      activeToolNames: new Set<string>(),
      includeMcp: true,
    });
    expect(catalog.map((c) => c.name)).not.toContain("bash");
    expect(catalog.map((c) => c.name)).not.toContain("web_search");
  });

  it("deny rules apply to the catalog too", () => {
    const r = seed();
    r.setDenyRules([{ pattern: "meeting_stop" }]);
    const catalog = r.getToolCatalogForScope({
      activePluginIds: new Set(["com.example.meeting"]),
      activeToolNames: new Set<string>(),
      includeMcp: false,
    });
    expect(catalog.map((c) => c.name)).not.toContain("meeting_stop");
    expect(catalog.map((c) => c.name)).toContain("meeting_start");
  });
});
