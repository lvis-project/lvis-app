/**
 * Phase 1 Lazy Tool Scoping — getToolSchemasForScope regression tests.
 *
 * Verifies scope filter semantics:
 *   - Empty activePluginIds → builtin-only (plugin tools excluded)
 *   - Single plugin in scope → builtins + that plugin's tools
 *   - Multi-plugin scope → union of plugin tools
 *   - MCP toggle → MCP tools included only when includeMcp=true
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
    jsonSchema: { type: "object", properties: {} },
    execute: async () => ({ output: "", isError: false }),
  });
}

function makePluginTool(name: string, pluginId: string) {
  return createDynamicTool({
    name,
    description: `plugin ${name}`,
    source: "plugin",
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

  it("single plugin in scope → builtins + that plugin's tools", () => {
    const r = seed();
    const schemas = r.getToolSchemasForScope({
      activePluginIds: new Set(["com.example.meeting"]),
      includeBuiltins: true,
      includeMcp: false,
    });
    const names = schemas.map((s) => s.name).sort();
    expect(names).toEqual(["bash", "meeting_start", "meeting_stop", "web_search"]);
  });

  it("multi-plugin scope → union of plugin tools", () => {
    const r = seed();
    const schemas = r.getToolSchemasForScope({
      activePluginIds: new Set(["com.example.meeting", "com.example.email"]),
      includeBuiltins: true,
      includeMcp: false,
    });
    const names = schemas.map((s) => s.name).sort();
    expect(names).toEqual([
      "bash",
      "email_list",
      "meeting_start",
      "meeting_stop",
      "web_search",
    ]);
  });

  it("includeMcp=true adds MCP tools; includeMcp=false excludes them", () => {
    const r = seed();
    const withMcp = r.getToolSchemasForScope({
      activePluginIds: new Set<string>(),
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
      includeBuiltins: false,
      includeMcp: false,
    });
    const names = schemas.map((s) => s.name).sort();
    expect(names).toEqual(["meeting_start", "meeting_stop"]);
  });

  it("accepts string[] in addition to Set for activePluginIds", () => {
    const r = seed();
    const schemas = r.getToolSchemasForScope({
      activePluginIds: ["com.example.email"],
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

describe("ToolRegistry — Tool-Level Deferral (flag on)", () => {
  function seedWithToolSearch(): ToolRegistry {
    const r = seed();
    r.register(makeBuiltin("tool_search"));
    return r;
  }

  it("flag off: tool_search hidden even though registered as a builtin", () => {
    const r = seedWithToolSearch();
    const schemas = r.getToolSchemasForScope({
      activePluginIds: new Set<string>(),
      includeBuiltins: true,
      includeMcp: false,
      deferral: false,
    });
    expect(schemas.map((s) => s.name)).not.toContain("tool_search");
  });

  it("flag on: tool_search visible; plugin tools load individually by activeToolNames", () => {
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

  it("flag on: plugin tool not in activeToolNames stays deferred", () => {
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
