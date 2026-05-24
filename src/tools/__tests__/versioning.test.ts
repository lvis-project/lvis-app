/**
 * §6.4 Tool Versioning + Deprecation — ToolRegistry behaviour.
 *
 * Covers:
 *   - Registration with explicit versions
 *   - Duplicate (name, version) throws
 *   - Multi-version registration selects latest via semver compare
 *   - findByName emits deprecation event for deprecated tools
 *   - replacedBy triggers transparent redirect + deprecation event
 *   - findByNameVersion pins a specific legacy version without warn
 *   - Default version "1.0.0" applied when spec omits it
 *   - unregisterByPlugin drops every version of that plugin's tools
 */
import { describe, it, expect, vi } from "vitest";

import { ToolRegistry, type DeprecationEvent } from "../registry.js";
import { createDynamicTool } from "../base.js";

function makeTool(
  name: string,
  opts: {
    version?: string;
    deprecatedSince?: string;
    replacedBy?: string;
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
    deprecatedSince: opts.deprecatedSince,
    replacedBy: opts.replacedBy,
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

  it("findByNameVersion returns the pinned legacy version without deprecation warn", () => {
    const r = new ToolRegistry();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    r.register(makeTool("foo", { version: "1.0.0", deprecatedSince: "2.0.0" }));
    r.register(makeTool("foo", { version: "2.0.0" }));
    expect(r.findByNameVersion("foo", "1.0.0")?.version).toBe("1.0.0");
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("prefers active tool over deprecated when both are registered", () => {
    const r = new ToolRegistry();
    r.register(makeTool("foo", { version: "2.0.0", deprecatedSince: "2.0.0" }));
    r.register(makeTool("foo", { version: "1.5.0" }));
    expect(r.findByName("foo")?.version).toBe("1.5.0");
  });

  it("emits deprecation event on findByName for a deprecated tool", () => {
    const r = new ToolRegistry();
    const events: DeprecationEvent[] = [];
    r.setDeprecationHandler((e) => events.push(e));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    r.register(makeTool("old_tool", { version: "1.0.0", deprecatedSince: "1.5.0" }));
    const resolved = r.findByName("old_tool");
    expect(resolved?.name).toBe("old_tool");
    expect(events).toHaveLength(1);
    expect(events[0].requested).toBe("old_tool");
    expect(events[0].deprecatedSince).toBe("1.5.0");
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("replacedBy transparently redirects findByName to the replacement", () => {
    const r = new ToolRegistry();
    const events: DeprecationEvent[] = [];
    r.setDeprecationHandler((e) => events.push(e));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    r.register(
      makeTool("old_name", {
        version: "1.0.0",
        deprecatedSince: "2.0.0",
        replacedBy: "new_name",
      }),
    );
    r.register(makeTool("new_name", { version: "2.0.0" }));

    const resolved = r.findByName("old_name");
    expect(resolved?.name).toBe("new_name");
    expect(events).toHaveLength(1);
    expect(events[0].requested).toBe("old_name");
    expect(events[0].resolved.name).toBe("new_name");
    expect(events[0].replacedBy).toBe("new_name");
    warnSpy.mockRestore();
  });

  it("falls back to deprecated tool when replacement is missing", () => {
    const r = new ToolRegistry();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    r.register(
      makeTool("old_name", {
        version: "1.0.0",
        deprecatedSince: "2.0.0",
        replacedBy: "missing",
      }),
    );
    const resolved = r.findByName("old_name");
    expect(resolved?.name).toBe("old_name");
    warnSpy.mockRestore();
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

  it("deprecation handler throw does not break lookup", () => {
    const r = new ToolRegistry();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    r.setDeprecationHandler(() => {
      throw new Error("boom");
    });
    r.register(makeTool("foo", { version: "1.0.0", deprecatedSince: "1.5.0" }));
    const resolved = r.findByName("foo");
    expect(resolved?.name).toBe("foo");
    warnSpy.mockRestore();
  });
});
