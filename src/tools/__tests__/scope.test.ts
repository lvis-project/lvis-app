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
  r.register(makePluginTool("meeting_start", "com.lge.meeting"));
  r.register(makePluginTool("meeting_stop", "com.lge.meeting"));
  r.register(makePluginTool("email_list", "com.lge.email"));
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
      activePluginIds: new Set(["com.lge.meeting"]),
      includeBuiltins: true,
      includeMcp: false,
    });
    const names = schemas.map((s) => s.name).sort();
    expect(names).toEqual(["bash", "meeting_start", "meeting_stop", "web_search"]);
  });

  it("multi-plugin scope → union of plugin tools", () => {
    const r = seed();
    const schemas = r.getToolSchemasForScope({
      activePluginIds: new Set(["com.lge.meeting", "com.lge.email"]),
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
      activePluginIds: new Set(["com.lge.meeting"]),
      includeBuiltins: false,
      includeMcp: false,
    });
    const names = schemas.map((s) => s.name).sort();
    expect(names).toEqual(["meeting_start", "meeting_stop"]);
  });

  it("accepts string[] in addition to Set for activePluginIds", () => {
    const r = seed();
    const schemas = r.getToolSchemasForScope({
      activePluginIds: ["com.lge.email"],
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

  it("plugin tool missing pluginId is excluded even when includeBuiltins=true", () => {
    const r = seed();
    // Register a plugin-source tool with no pluginId (misconfigured tool)
    r.register(createDynamicTool({
      name: "orphan_plugin_tool",
      description: "plugin tool with no pluginId",
      source: "plugin",
      // pluginId intentionally omitted
      jsonSchema: { type: "object", properties: {} },
      execute: async () => ({ output: "", isError: false }),
    }));
    const schemas = r.getToolSchemasForScope({
      activePluginIds: new Set<string>(),
      includeBuiltins: true,
      includeMcp: false,
    });
    expect(schemas.map((s) => s.name)).not.toContain("orphan_plugin_tool");
  });
});
