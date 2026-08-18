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

/** A BUILTIN that surfaces MCP-server data and therefore declares the MCP scope. */
function makeMcpScopedBuiltin(name: string) {
  return createDynamicTool({
    name,
    description: `mcp-scoped builtin ${name}`,
    source: "builtin",
    category: "read",
    requiresMcpScope: true,
    jsonSchema: { type: "object", properties: {} },
    execute: async () => ({ output: "", isError: false }),
  });
}

/** A BUILTIN that can reach a model-chosen external URL. */
function makeEgressBuiltin(name: string) {
  return createDynamicTool({
    name,
    description: `egress builtin ${name}`,
    source: "builtin",
    category: "network",
    arbitraryEgress: true,
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
      includeEgress: true,
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
      includeEgress: true,
    });
    const names = schemas.map((s) => s.name).sort();
    expect(names).toEqual(["bash", "web_search"]);
  });

  // A builtin that hands the model untrusted MCP content honors the SAME switch as
  // an MCP tool. Headless (routine) loops run with `includeMcp: false` on purpose,
  // and a builtin badge must not be a way around that decision.
  it("withholds an mcp-scoped builtin when MCP is out of scope", () => {
    // Registered here rather than in `seed()` so the other cases keep asserting
    // exact tool lists without this one perturbing them.
    const r = seed();
    r.register(makeMcpScopedBuiltin("mcp_resource_list"));
    const withoutMcp = r.getToolSchemasForScope({
      activePluginIds: new Set<string>(),
      includeBuiltins: true,
      includeMcp: false,
      includeEgress: true,
    }).map((s) => s.name);
    expect(withoutMcp).not.toContain("mcp_resource_list");
    expect(withoutMcp).toContain("bash");

    const withMcp = r.getToolSchemasForScope({
      activePluginIds: new Set<string>(),
      includeBuiltins: true,
      includeMcp: true,
      includeEgress: true,
    }).map((s) => s.name);
    expect(withMcp).toContain("mcp_resource_list");
  });

  it("withholds an arbitrary-egress builtin when egress is out of scope", () => {
    // Unattended (headless/routine) lanes set `includeEgress: false`. Dropping
    // the tool at the REGISTRY — not at the approval gate — is what makes this
    // hold against prompt injection: the schema is never shown, so injected
    // text in a mail body or indexed document cannot ask for the tool by name.
    const r = seed();
    r.register(makeEgressBuiltin("web_fetch"));

    const unattended = r.getToolSchemasForScope({
      activePluginIds: new Set<string>(),
      includeBuiltins: true,
      includeMcp: false,
      includeEgress: false,
    }).map((s) => s.name);
    expect(unattended).not.toContain("web_fetch");
    // Withholding egress must not disturb the rest of the builtin surface.
    expect(unattended).toContain("bash");

    const attended = r.getToolSchemasForScope({
      activePluginIds: new Set<string>(),
      includeBuiltins: true,
      includeMcp: false,
      includeEgress: true,
    }).map((s) => s.name);
    expect(attended).toContain("web_fetch");
  });

  it("fails closed when the egress switch is omitted", () => {
    // A security switch must withhold when a caller forgets it, not expose.
    const r = seed();
    r.register(makeEgressBuiltin("web_fetch"));
    const names = r.getToolSchemasForScope({
      activePluginIds: new Set<string>(),
      includeBuiltins: true,
      includeMcp: false,
      // includeEgress deliberately omitted — that is the case under test.
    } as never).map((s) => s.name);
    expect(names).not.toContain("web_fetch");
  });

  it("plugin schemas load individually by activeToolNames", () => {
    const r = seed();
    const schemas = r.getToolSchemasForScope({
      activePluginIds: new Set(["com.example.meeting", "com.example.email"]),
      activeToolNames: new Set(["meeting_stop", "email_list"]),
      includeBuiltins: true,
      includeMcp: false,
      includeEgress: true,
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
      includeEgress: true,
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
      includeEgress: true,
    });
    expect(withMcp.map((s) => s.name)).toContain("mcp_fetch");

    const withoutMcp = r.getToolSchemasForScope({
      activePluginIds: new Set<string>(),
      includeBuiltins: true,
      includeMcp: false,
      includeEgress: true,
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
      includeEgress: true,
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
      includeEgress: true,
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
      includeEgress: true,
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
      includeEgress: true,
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
      includeEgress: true,
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
      includeEgress: true,
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
      includeEgress: true,
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

describe("ToolRegistry — eager exposure (deferral=false, #1176)", () => {
  it("loads the whole active plugin suite without per-tool activeToolNames", () => {
    const r = seed();
    const schemas = r.getToolSchemasForScope({
      activePluginIds: new Set(["com.example.meeting"]),
      // No activeToolNames at all — eager mode must still load every meeting tool.
      includeBuiltins: true,
      includeMcp: false,
      includeEgress: true,
      deferral: false,
    });
    const names = schemas.map((s) => s.name).sort();
    expect(names).toEqual(["bash", "meeting_start", "meeting_stop", "web_search"]);
  });

  it("loads in-scope MCP tools eagerly when includeMcp is set", () => {
    const r = seed();
    const schemas = r.getToolSchemasForScope({
      activePluginIds: new Set<string>(),
      includeBuiltins: false,
      includeMcp: true,
      includeEgress: true,
      deferral: false,
    });
    expect(schemas.map((s) => s.name)).toContain("mcp_fetch");
  });

  it("still excludes plugins outside activePluginIds in eager mode", () => {
    const r = seed();
    const schemas = r.getToolSchemasForScope({
      activePluginIds: new Set(["com.example.meeting"]),
      includeBuiltins: false,
      includeMcp: false,
      includeEgress: true,
      deferral: false,
    });
    const names = schemas.map((s) => s.name).sort();
    expect(names).toEqual(["meeting_start", "meeting_stop"]);
    expect(names).not.toContain("email_list");
  });

  it("returns an empty catalog in eager mode (nothing left to discover)", () => {
    const r = seed();
    const catalog = r.getToolCatalogForScope({
      activePluginIds: new Set(["com.example.meeting"]),
      includeMcp: true,
      deferral: false,
    });
    expect(catalog).toEqual([]);
  });

  it("deny rules still apply in eager mode", () => {
    const r = seed();
    r.setDenyRules([{ pattern: "meeting_stop" }]);
    const schemas = r.getToolSchemasForScope({
      activePluginIds: new Set(["com.example.meeting"]),
      includeBuiltins: false,
      includeMcp: false,
      includeEgress: true,
      deferral: false,
    });
    expect(schemas.map((s) => s.name)).not.toContain("meeting_stop");
    expect(schemas.map((s) => s.name)).toContain("meeting_start");
  });
});
