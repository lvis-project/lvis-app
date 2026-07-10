/**
 * #885 v6 — the loopback reverse projection (`mcpToolToPluginTool`). The forward
 * projection now emits ONLY `_meta.ui.visibility` + `xyz.lvis/pathFields`
 * (category / version / writesToOwnSandbox / workerId / deprecation are REMOVED
 * from the wire), so the reverse projection:
 *   - sources `pathFields` from `_meta`,
 *   - NEVER populates `Tool.writesToOwnSandbox` (the untrusted self-claim is gone —
 *     the reviewer auto-LOW keys on host-computed containment instead),
 *   - reads an ABSENT category as the write-equivalent baseline WITHOUT warning
 *     (v6-expected steady state), warning only on a present-but-malformed one,
 *   - carries `source: "plugin"` + `pluginId` for the §6.3 permission pipeline.
 */
import { describe, it, expect, vi } from "vitest";
import { mcpToolToPluginTool } from "../plugin-tool-from-mcp.js";
import { manifestToolsToMcpTools } from "../plugin-server-projection.js";
import type { NormalizedManifest } from "../../plugins/types.js";

const PLUGIN_ID = "com.example.files";

const MANIFEST: NormalizedManifest = {
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

function warnedMalformedCategory(spy: ReturnType<typeof vi.spyOn>): boolean {
  return spy.mock.calls.some((args) =>
    args.some((a) => typeof a === "string" && /malformed category/.test(a)),
  );
}

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

  it("#885 v6 — an ABSENT category is v6-expected: write-equivalent WITHOUT a warn (no boot-spam)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const tool = mcpToolToPluginTool(
        PLUGIN_ID,
        { name: "rogue", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model"] } } },
        invoke,
      );
      expect(tool.category).toBe("write");
      expect(tool.isReadOnly({})).toBe(false);
      expect(warnedMalformedCategory(warnSpy)).toBe(false); // absent → silent
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("#885 v6 — a PRESENT-but-malformed category returns write-equivalent AND warns (real declaration error)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const tool = mcpToolToPluginTool(
        PLUGIN_ID,
        { name: "rogue", inputSchema: { type: "object", properties: {} }, _meta: { "xyz.lvis/category": 42 } },
        invoke,
      );
      expect(tool.category).toBe("write");
      expect(warnedMalformedCategory(warnSpy)).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
