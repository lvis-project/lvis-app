/**
 * §6.4 Tool Versioning — ToolRegistry behaviour.
 *
 * Covers:
 *   - Registration with explicit versions
 *   - Duplicate (name, version) throws
 *   - Multi-version registration selects latest via semver compare
 *   - findByNameVersion pins a specific registered version
 *   - Default version "1.0.0" applied when spec omits it
 *   - unregisterByPlugin drops every version of that plugin's tools
 *
 * NOTE: the per-tool deprecation machinery (`deprecatedSince`/`replacedBy`
 * redirect + warn) was removed in #885 Phase R — no builtin ever produced it —
 * so the registry now selects the semver-latest version with no deprecation
 * filtering, and those tests were removed with the feature.
 */
import { describe, it, expect } from "vitest";

import { ToolRegistry } from "../registry.js";
import { createDynamicTool } from "../base.js";

function makeTool(
  name: string,
  opts: {
    version?: string;
    pluginId?: string;
    mcpServerId?: string;
    source?: "builtin" | "plugin" | "mcp";
  } = {},
) {
  return createDynamicTool({
    name,
    description: `tool ${name}@${opts.version ?? "1.0.0"}`,
    source: opts.source ?? "builtin",
    pluginId: opts.pluginId,
    mcpServerId: opts.mcpServerId,
    version: opts.version,
    jsonSchema: { type: "object", properties: {} },
    execute: async () => ({ output: "", isError: false }),
  });
}

describe("§6.4 Tool Versioning — ToolRegistry", () => {
  it("defaults version to 1.0.0 when spec omits it", () => {
    const r = new ToolRegistry();
    r.register(makeTool("foo"));
    expect(r.findByName("foo")?.version).toBe("1.0.0");
  });

  it("throws on duplicate (name, version) registration", () => {
    const r = new ToolRegistry();
    r.register(makeTool("foo", { version: "1.0.0" }));
    expect(() =>
      r.register(makeTool("foo", { version: "1.0.0" })),
    ).toThrow(/already registered/);
  });

  it("allows same name with different versions and picks latest", () => {
    const r = new ToolRegistry();
    r.register(makeTool("foo", { version: "1.0.0" }));
    r.register(makeTool("foo", { version: "2.1.0" }));
    r.register(makeTool("foo", { version: "2.0.3" }));
    expect(r.findByName("foo")?.version).toBe("2.1.0");
    expect(r.listVersions("foo").map((t) => t.version)).toEqual([
      "1.0.0",
      "2.0.3",
      "2.1.0",
    ]);
  });

  it("rejects cross-owner name collisions so plugin tools cannot replace builtins by version", () => {
    const r = new ToolRegistry();
    r.register(makeTool("meeting_start", { version: "1.0.0" }));

    expect(() =>
      r.register(makeTool("meeting_start", {
        version: "9.0.0",
        source: "plugin",
        pluginId: "lvis-plugin-meeting",
      })),
    ).toThrow(/Tool name collision.*builtin.*plugin:lvis-plugin-meeting/);

    expect(r.findByName("meeting_start")?.source).toBe("builtin");
    expect(r.findByName("meeting_start")?.version).toBe("1.0.0");
  });

  it("rejects plugin and MCP tools that are missing owner ids", () => {
    const r = new ToolRegistry();

    expect(() =>
      r.register(makeTool("plugin_missing_owner", { source: "plugin" })),
    ).toThrow(/missing pluginId/);
    expect(() =>
      r.register(makeTool("mcp_missing_owner", { source: "mcp" })),
    ).toThrow(/missing mcpServerId/);
  });

  it("findByNameVersion returns the pinned version regardless of latest", () => {
    const r = new ToolRegistry();
    r.register(makeTool("foo", { version: "1.0.0" }));
    r.register(makeTool("foo", { version: "2.0.0" }));
    expect(r.findByNameVersion("foo", "1.0.0")?.version).toBe("1.0.0");
    expect(r.findByName("foo")?.version).toBe("2.0.0");
  });

  it("unregisterByPlugin removes every version contributed by that plugin", () => {
    const r = new ToolRegistry();
    r.register(makeTool("foo", { version: "1.0.0", source: "plugin", pluginId: "p.a" }));
    r.register(makeTool("foo", { version: "2.0.0", source: "plugin", pluginId: "p.a" }));
    r.register(makeTool("bar", { version: "1.0.0", source: "plugin", pluginId: "p.b" }));
    r.unregisterByPlugin("p.a");
    expect(r.findByName("foo")).toBeUndefined();
    expect(r.listVersions("foo")).toEqual([]);
    expect(r.findByName("bar")?.name).toBe("bar");
  });
});
