/**
 * #885 v6 — the loopback reverse projection (`mcpToolToPluginTool`). The forward
 * projection now emits ONLY `_meta.ui.visibility` + `xyz.lvis/pathFields`
 * (category / version / writesToOwnSandbox / workerId / deprecation are REMOVED
 * from the wire), so the reverse projection:
 *   - sources `pathFields` from `_meta`,
 *   - NEVER populates `Tool.writesToOwnSandbox` (the untrusted self-claim is gone —
 *     the reviewer auto-LOW keys on host-computed containment instead),
 *   - registers EVERY tool at the write-equivalent baseline, ignoring any wire
 *     `category` entirely (#885 dropped the category reader — loopback emits no
 *     category and an out-of-process plugin's wire category is not trusted; host
 *     `inspectHostRisk` is the effective SOT),
 *   - carries `source: "plugin"` + `pluginId` for the §6.3 permission pipeline.
 */
import { describe, it, expect, vi } from "vitest";
import { mcpToolToPluginTool } from "../plugin-tool-from-mcp.js";
import { manifestToolsToMcpTools } from "../plugin-server-projection.js";
import type { PluginManifest } from "../../plugins/types.js";

const PLUGIN_ID = "com.example.files";

const MANIFEST: PluginManifest = {
  id: PLUGIN_ID,
  name: "Files",
  version: "2.3.0",
  entry: "dist/index.js",
  description: "file ops",
  tools: [
    {
      name: "files_read",
      description: "Read a file",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      _meta: { ui: { visibility: ["model"] }, "xyz.lvis/pathFields": ["path"] },
    },
    {
      name: "files_write",
      description: "Write a file",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, body: { type: "string" } },
        required: ["path"],
      },
      _meta: { ui: { visibility: ["model"] }, "xyz.lvis/pathFields": ["path"] },
    },
    {
      name: "files_exec",
      description: "Run a command",
      inputSchema: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
      _meta: { ui: { visibility: ["model"] } },
    },
  ],
};

describe("mcpToolToPluginTool — v6 reverse projection from _meta", () => {
  const invoke = vi.fn(async (name: string) => ({ text: `ran ${name}` }));

  it("sources pathFields from _meta and applies the default tool version (removed self-claim fields are gone from the contract)", () => {
    const tools = manifestToolsToMcpTools(MANIFEST).map((t) => mcpToolToPluginTool(PLUGIN_ID, t, invoke));
    const read = tools.find((t) => t.name === "files_read")!;
    const write = tools.find((t) => t.name === "files_write")!;
    const exec = tools.find((t) => t.name === "files_exec")!;

    expect(read.pathFields).toEqual(["path"]);
    expect(write.pathFields).toEqual(["path"]);
    expect(exec.pathFields).toBeUndefined();

    for (const t of tools) {
      expect(t.source).toBe("plugin");
      expect(t.pluginId).toBe(PLUGIN_ID);
      // category is HOST-derived per invocation now — the wire carries none, so
      // the reverse projection registers the write-equivalent baseline.
      expect(t.category).toBe("write");
      expect(t.isReadOnly({})).toBe(false);
      // workerId is host-derived (never promoted from the manifest wire).
      expect(t.workerId).toBeUndefined();
      // the wire carries no per-tool version — `createDynamicTool` applies its
      // "1.0.0" default (per-tool version left the Tool contract entirely).
      expect(t.version).toBe("1.0.0");
    }
  });

  it("round-trips execution through the invoke delegate (tools/call)", async () => {
    const read = mcpToolToPluginTool(PLUGIN_ID, manifestToolsToMcpTools(MANIFEST)[0], invoke);
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

  it("#885 v6 — the wire `category` is fully ignored: absent, valid, or malformed all register write-equivalent", () => {
    // #885 dropped the per-tool category reader: the host ignores any wire
    // `_meta["xyz.lvis/category"]` (loopback sends none; an out-of-process
    // plugin's is not trusted), so the reverse projection pins every tool to the
    // write-equivalent baseline unconditionally. Security invariant preserved —
    // a wire "read" can NEVER silently downgrade a plugin tool; the host
    // `inspectHostRisk` classifier is the effective SOT.
    const wireMetas: Array<Record<string, unknown>> = [
      { ui: { visibility: ["model"] } }, // absent category
      { "xyz.lvis/category": "read" }, // a valid-looking wire "read" is ignored
      { "xyz.lvis/category": 42 }, // malformed
    ];
    for (const _meta of wireMetas) {
      const tool = mcpToolToPluginTool(
        PLUGIN_ID,
        { name: "rogue", inputSchema: { type: "object", properties: {} }, _meta },
        invoke,
      );
      expect(tool.category).toBe("write");
      expect(tool.category).not.toBe("read");
      expect(tool.isReadOnly({})).toBe(false);
    }
  });
});
