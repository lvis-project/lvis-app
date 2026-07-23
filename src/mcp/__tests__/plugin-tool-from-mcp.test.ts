/**
 * #885 v6 — the loopback reverse projection (`mcpToolToPluginTool`). The forward
 * projection now emits ONLY `_meta.ui.visibility` + `lvisai/pathFields`
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
      _meta: { ui: { visibility: ["model"] }, "lvisai/pathFields": ["path"] },
    },
    {
      name: "files_write",
      description: "Write a file",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, body: { type: "string" } },
        required: ["path"],
      },
      _meta: { ui: { visibility: ["model"] }, "lvisai/pathFields": ["path"] },
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

  it("attaches the validated signed operation policy carried by the MCP Tool", () => {
    const policy = {
      discriminant: "operation" as const,
      operations: { read: { kind: "read" as const, minimumRisk: "read" as const, appVisible: true } },
    };
    const projected = {
      ...manifestToolsToMcpTools(MANIFEST)[0],
      _meta: {
        ...manifestToolsToMcpTools(MANIFEST)[0]._meta,
        "lvisai/operationPolicy": policy,
      },
    };
    const tool = mcpToolToPluginTool(PLUGIN_ID, projected, invoke, policy);
    expect(tool.operationPolicy).toEqual(policy);
    expect(projected._meta["lvisai/operationPolicy"]).toEqual(policy);
  });

  it("surfaces a thrown invoke as an isError result (not a throw)", async () => {
    const failing = vi.fn(async () => {
      throw new Error("disk full");
    });
    const tool = mcpToolToPluginTool(PLUGIN_ID, manifestToolsToMcpTools(MANIFEST)[0], failing);
    const result = await tool.execute({ path: "/x" }, {} as never);
    expect(result).toEqual({ output: "disk full", isError: true });
  });

  it("materializes Tool.modelVisible from the wire's _meta.ui.visibility — app-only ⇒ registered but NOT model-exposed", () => {
    // The one standard declaration the host reads back off this wire. It decides
    // MODEL EXPOSURE only — never whether the tool is registered. An app-only tool
    // MUST become a registry `Tool`: that is the only way its card's `tools/call`
    // can run under inspectHostRisk → reviewer/approval → audit.
    const manifest: PluginManifest = {
      ...MANIFEST,
      tools: [
        { name: "files_read", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model"] } } },
        { name: "files_toggle", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model", "app"] } } },
        { name: "files_ui_rows", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["app"] } } },
      ],
    };
    const tools = manifestToolsToMcpTools(manifest).map((t) => mcpToolToPluginTool(PLUGIN_ID, t, invoke));

    // Every declared tool round-trips into a registry `Tool` — app-only included.
    expect(tools.map((t) => t.name)).toEqual(["files_read", "files_toggle", "files_ui_rows"]);
    expect(tools.find((t) => t.name === "files_read")!.modelVisible).toBe(true);
    expect(tools.find((t) => t.name === "files_toggle")!.modelVisible).toBe(true);
    expect(tools.find((t) => t.name === "files_ui_rows")!.modelVisible).toBe(false);
    // The app-visibility MUST stays with `assertUiActionInvokable` inside
    // PluginRuntime.callFromApp (the plugin arm's single enforcement site), so this
    // arm deliberately leaves `appInvokable` unset.
    for (const t of tools) expect(t.appInvokable).toBeUndefined();
  });

  it("fail-closes to the minimal governed surface when the wire carries no valid visibility", () => {
    // The forward projection always emits visibility explicitly, so an absent /
    // malformed declaration here means a broken producer — resolve it to ["model"]
    // (governed, LLM-reachable) rather than silently granting the app surface.
    for (const _meta of [{}, { ui: { visibility: "app" } }, { ui: { visibility: [] } }, { ui: 7 }]) {
      const tool = mcpToolToPluginTool(
        PLUGIN_ID,
        { name: "rogue", inputSchema: { type: "object", properties: {} }, _meta },
        invoke,
      );
      expect(tool.modelVisible).toBe(true);
    }
  });

  it("#885 v6 — the wire `category` is fully ignored: absent, valid, or malformed all register write-equivalent", () => {
    // #885 dropped the per-tool category reader: the host ignores any wire
    // `_meta["lvisai/category"]` (loopback sends none; an out-of-process
    // plugin's is not trusted), so the reverse projection pins every tool to the
    // write-equivalent baseline unconditionally. Security invariant preserved —
    // a wire "read" can NEVER silently downgrade a plugin tool; the host
    // `inspectHostRisk` classifier is the effective SOT.
    const wireMetas: Array<Record<string, unknown>> = [
      { ui: { visibility: ["model"] } }, // absent category
      { "lvisai/category": "read" }, // a valid-looking wire "read" is ignored
      { "lvisai/category": 42 }, // malformed
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

  it("IGNORES the legacy xyz.lvis/pathFields wire key — the dual-read was removed (fail-closed)", () => {
    // The `_meta` namespace rename removed the transitional legacy read. A wire
    // carrying ONLY the legacy key yields NO pathFields — the security-bearing
    // extraction is not silently sourced from the old key (that would be fail-open).
    const legacy = mcpToolToPluginTool(
      PLUGIN_ID,
      {
        name: "legacy_read",
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
        _meta: { ui: { visibility: ["model"] }, "xyz.lvis/pathFields": ["path"] },
      },
      invoke,
    );
    expect(legacy.pathFields).toBeUndefined();
  });

  it("reads pathFields from the new lvisai/pathFields wire key (and ignores a stray legacy key)", () => {
    const tool = mcpToolToPluginTool(
      PLUGIN_ID,
      {
        name: "both_read",
        inputSchema: { type: "object", properties: {} },
        _meta: {
          ui: { visibility: ["model"] },
          "lvisai/pathFields": ["new"],
          "xyz.lvis/pathFields": ["old"],
        },
      },
      invoke,
    );
    expect(tool.pathFields).toEqual(["new"]);
  });
});
