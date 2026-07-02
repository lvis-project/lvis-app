/**
 * `plugin-loopback-server` milestone gate (mcp-alignment-design.md §5):
 * a first-party plugin migrated to the MCP loopback path must register tools
 * that are IDENTICAL, in every permission-relevant field, to the legacy direct
 * path — with the authoritative `category` now sourced from the tool's
 * `xyz.lvis/*` `_meta` rather than a second raw manifest read.
 *
 * So this test asserts the forward+reverse projection is a faithful round-trip:
 *   pluginToolsForRegistration(manifest)            // legacy direct path
 *     ≡ (permission fields) ≡
 *   manifestToolsToMcpTools(manifest)               // forward: manifest → MCP
 *     .map(mcpToolToPluginTool)                      // reverse: MCP → Tool
 */
import { describe, it, expect, vi } from "vitest";
import { mcpToolToPluginTool } from "../plugin-tool-from-mcp.js";
import { manifestToolsToMcpTools } from "../plugin-server-projection.js";
import type { Tool } from "../../tools/base.js";
import type { PluginManifest } from "../../plugins/types.js";

const PLUGIN_ID = "com.example.files";

const MANIFEST: PluginManifest = {
  id: PLUGIN_ID,
  name: "Files",
  version: "2.3.0",
  entry: "dist/index.js",
  description: "file ops",
  tools: ["files_read", "files_write", "files_exec", "files_fetch"],
  toolSchemas: {
    files_read: {
      description: "Read a file",
      category: "read",
      pathFields: ["path"],
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
    files_write: {
      description: "Write a file",
      category: "write",
      pathFields: ["path"],
      workerId: "files-worker",
      writesToOwnSandbox: true,
      version: "9.9.9", // per-tool version override (should win over manifest 2.3.0)
      deprecatedSince: "2.0.0",
      replacedBy: "files_write_v2",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, body: { type: "string" } },
        required: ["path"],
      },
    },
    files_exec: {
      description: "Run a command",
      category: "shell",
      inputSchema: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
    },
    files_fetch: {
      description: "Fetch a URL",
      category: "network",
      inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    },
  },
} as PluginManifest;

/** The fields the §6.3 permission pipeline + §6.4 registry actually read. */
function permissionFields(tool: Tool) {
  return {
    name: tool.name,
    source: tool.source,
    category: tool.category,
    pluginId: tool.pluginId,
    workerId: tool.workerId,
    pathFields: tool.pathFields,
    writesToOwnSandbox: tool.writesToOwnSandbox,
    version: tool.version,
    deprecatedSince: tool.deprecatedSince,
    replacedBy: tool.replacedBy,
    isReadOnly: tool.isReadOnly({}),
  };
}

describe("mcpToolToPluginTool — reverse projection from _meta (#1230 §5 plugin-loopback-server)", () => {
  const invoke = vi.fn(async (name: string) => ({ text: `ran ${name}` }));

  it("reconstructs permission fields from _meta without trusting workerId as execution proof", () => {
    const viaMcp = manifestToolsToMcpTools(MANIFEST).map((t) =>
      mcpToolToPluginTool(PLUGIN_ID, t, invoke),
    );

    // The reverse projection is now the ONLY registration path (legacy removed);
    // assert it yields the authoritative permission fields straight from _meta.
    expect(viaMcp.map(permissionFields)).toEqual([
      { name: "files_read", source: "plugin", category: "read", pluginId: PLUGIN_ID,
        workerId: undefined, pathFields: ["path"], writesToOwnSandbox: undefined, version: "2.3.0",
        deprecatedSince: undefined, replacedBy: undefined, isReadOnly: true },
      { name: "files_write", source: "plugin", category: "write", pluginId: PLUGIN_ID,
        workerId: undefined, pathFields: ["path"], writesToOwnSandbox: true, version: "9.9.9",
        deprecatedSince: "2.0.0", replacedBy: "files_write_v2", isReadOnly: false },
      { name: "files_exec", source: "plugin", category: "shell", pluginId: PLUGIN_ID,
        workerId: undefined, pathFields: undefined, writesToOwnSandbox: undefined, version: "2.3.0",
        deprecatedSince: undefined, replacedBy: undefined, isReadOnly: false },
      { name: "files_fetch", source: "plugin", category: "network", pluginId: PLUGIN_ID,
        workerId: undefined, pathFields: undefined, writesToOwnSandbox: undefined, version: "2.3.0",
        deprecatedSince: undefined, replacedBy: undefined, isReadOnly: false },
    ]);
  });

  it("sources the per-tool version override from _meta (9.9.9, not the manifest 2.3.0)", () => {
    const write = manifestToolsToMcpTools(MANIFEST)
      .map((t) => mcpToolToPluginTool(PLUGIN_ID, t, invoke))
      .find((t) => t.name === "files_write");
    expect(write?.version).toBe("9.9.9");
    // workerId is manifest-advisory only on the loopback path. It must not
    // become Tool.workerId unless the host actually routes execution through
    // that worker; otherwise a plugin could self-attest ASRT confinement.
    expect(write?.workerId).toBeUndefined();
    expect(write?.writesToOwnSandbox).toBe(true);
    expect(write?.pathFields).toEqual(["path"]);
    expect(write?.deprecatedSince).toBe("2.0.0");
    expect(write?.replacedBy).toBe("files_write_v2");
  });

  it("read-category tool is read-only; write/shell/network are not", () => {
    const byName = Object.fromEntries(
      manifestToolsToMcpTools(MANIFEST)
        .map((t) => mcpToolToPluginTool(PLUGIN_ID, t, invoke))
        .map((t) => [t.name, t]),
    );
    expect(byName.files_read.isReadOnly({})).toBe(true);
    expect(byName.files_write.isReadOnly({})).toBe(false);
    expect(byName.files_exec.isReadOnly({})).toBe(false);
    expect(byName.files_fetch.isReadOnly({})).toBe(false);
  });

  it("round-trips execution through the invoke delegate (tools/call)", async () => {
    const read = mcpToolToPluginTool(
      PLUGIN_ID,
      manifestToolsToMcpTools(MANIFEST)[0],
      invoke,
    );
    const result = await read.execute({ path: "/etc/hosts" }, {} as never);
    expect(invoke).toHaveBeenCalledWith("files_read", { path: "/etc/hosts" });
    expect(result).toEqual({ output: "ran files_read", isError: false });
  });

  it("surfaces a thrown invoke as an isError result (not a throw)", async () => {
    const failing = vi.fn(async () => {
      throw new Error("disk full");
    });
    const tool = mcpToolToPluginTool(PLUGIN_ID, manifestToolsToMcpTools(MANIFEST)[0], failing);
    const result = await tool.execute({ path: "/x" }, {} as never);
    expect(result).toEqual({ output: "disk full", isError: true });
  });

  it("default-strict: a discovered tool with no category in _meta loads as write-equivalent (no throw)", () => {
    const tool = mcpToolToPluginTool(
      PLUGIN_ID,
      { name: "rogue", inputSchema: { type: "object", properties: {} }, _meta: {} },
      invoke,
    );
    // A plugin grading its own danger is not a control; an undeclared tool
    // registers at the write-equivalent baseline rather than failing load.
    expect(tool.category).toBe("write");
    expect(tool.isReadOnly({})).toBe(false);
  });

  it("default-strict: an invalid category string in _meta also loads as write-equivalent", () => {
    const tool = mcpToolToPluginTool(
      PLUGIN_ID,
      { name: "rogue", inputSchema: { type: "object", properties: {} }, _meta: { "xyz.lvis/category": "bogus" } },
      invoke,
    );
    expect(tool.category).toBe("write");
  });
});
