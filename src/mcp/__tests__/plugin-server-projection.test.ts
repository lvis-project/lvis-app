import { describe, it, expect } from "vitest";
import {
  annotationsForCategory,
  manifestToDiscoverResult,
  manifestToolsToMcpTools,
  toolSchemaToMcpTool,
} from "../plugin-server-projection.js";
import type { PluginManifest } from "../../plugins/types.js";

const BASE_MANIFEST: PluginManifest = {
  id: "com.example.meeting",
  name: "Meeting",
  version: "2.1.0",
  entry: "dist/hostPlugin.js",
  description: "Records and summarizes meetings",
  tools: ["meeting_start", "meeting_export"],
  toolSchemas: {
    meeting_start: {
      description: "Start recording",
      category: "shell",
      inputSchema: { type: "object", properties: { room: { type: "string" } }, required: ["room"] },
    },
    meeting_export: {
      description: "Export the transcript to a path",
      category: "write",
      pathFields: ["path"],
      writesToOwnSandbox: true,
      version: "3.0.0",
      deprecatedSince: "2.0.0",
      replacedBy: "meeting_export_v2",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
    },
  },
};

describe("plugin-server-projection — toolSchema → MCP Tool (#1230 §3.3)", () => {
  it("relabels the inputSchema dialect to JSON Schema 2020-12", () => {
    const tool = toolSchemaToMcpTool("meeting_start", BASE_MANIFEST.toolSchemas!.meeting_start, "2.1.0");
    expect(tool.inputSchema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    // body keywords preserved
    expect(tool.inputSchema.properties).toEqual({ room: { type: "string" } });
    expect(tool.inputSchema.required).toEqual(["room"]);
  });

  it("carries the authoritative category in reverse-DNS _meta (NOT a reserved mcp prefix)", () => {
    const tool = toolSchemaToMcpTool("meeting_start", BASE_MANIFEST.toolSchemas!.meeting_start, "2.1.0");
    expect(tool._meta["xyz.lvis/category"]).toBe("shell");
    // §8: no LVIS key may use an mcp/modelcontextprotocol second label.
    for (const key of Object.keys(tool._meta)) {
      expect(key.startsWith("xyz.lvis/")).toBe(true);
      expect(key).not.toMatch(/(^|\.)(mcp|modelcontextprotocol)\//);
    }
  });

  it("default-strict: a toolSchema entry without category projects write-equivalent (loads, no throw)", () => {
    // host-classifies-risk: category is optional. A manifest that omits it
    // must still load and project a valid (write-equivalent) declared category.
    const tool = toolSchemaToMcpTool(
      "uncategorized_tool",
      {
        description: "no category declared",
        inputSchema: { type: "object", properties: {} },
      },
      "1.0.0",
    );
    expect(tool._meta["xyz.lvis/category"]).toBe("write");
    // annotations reflect the write-equivalent baseline (destructive, not read-only)
    expect(tool.annotations.readOnlyHint).toBe(false);
    expect(tool.annotations.destructiveHint).toBe(true);
  });

  it("falls back the tool version to the manifest version when omitted, else uses the tool's own", () => {
    const start = toolSchemaToMcpTool("meeting_start", BASE_MANIFEST.toolSchemas!.meeting_start, "2.1.0");
    expect(start._meta["xyz.lvis/version"]).toBe("2.1.0"); // inherits manifest version
    const exp = toolSchemaToMcpTool("meeting_export", BASE_MANIFEST.toolSchemas!.meeting_export, "2.1.0");
    expect(exp._meta["xyz.lvis/version"]).toBe("3.0.0"); // tool's own version
  });

  it("carries optional policy fields in _meta only when present", () => {
    const start = toolSchemaToMcpTool("meeting_start", BASE_MANIFEST.toolSchemas!.meeting_start, "2.1.0");
    expect(start._meta["xyz.lvis/pathFields"]).toBeUndefined();
    expect(start._meta["xyz.lvis/writesToOwnSandbox"]).toBeUndefined();

    const exp = toolSchemaToMcpTool("meeting_export", BASE_MANIFEST.toolSchemas!.meeting_export, "2.1.0");
    expect(exp._meta["xyz.lvis/pathFields"]).toEqual(["path"]);
    expect(exp._meta["xyz.lvis/writesToOwnSandbox"]).toBe(true);
    expect(exp._meta["xyz.lvis/deprecatedSince"]).toBe("2.0.0");
    expect(exp._meta["xyz.lvis/replacedBy"]).toBe("meeting_export_v2");
  });

  it("projects category → ToolAnnotations hints (interop only)", () => {
    expect(annotationsForCategory("read")).toEqual({
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    });
    expect(annotationsForCategory("write")).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(annotationsForCategory("shell")).toMatchObject({ destructiveHint: true });
    expect(annotationsForCategory("network")).toMatchObject({ openWorldHint: true, readOnlyHint: false });
  });
});

describe("plugin-server-projection — manifest → tools/list (#1230 §3.3)", () => {
  it("projects every tool that has a schema, in manifest order", () => {
    const tools = manifestToolsToMcpTools(BASE_MANIFEST);
    expect(tools.map((t) => t.name)).toEqual(["meeting_start", "meeting_export"]);
  });

  it("skips a declared tool that has no toolSchemas entry (UI-only / mis-declared)", () => {
    const manifest: PluginManifest = {
      ...BASE_MANIFEST,
      tools: ["meeting_start", "ui_only_method"],
    };
    const tools = manifestToolsToMcpTools(manifest);
    expect(tools.map((t) => t.name)).toEqual(["meeting_start"]);
  });
});

describe("plugin-server-projection — manifest → server/discover (#1230 §3.2)", () => {
  it("projects serverInfo + RC supportedVersions + tools capability", () => {
    const discover = manifestToDiscoverResult(BASE_MANIFEST);
    expect(discover.resultType).toBe("complete");
    expect(discover.supportedVersions).toEqual(["2026-07-28"]);
    expect(discover.serverInfo).toEqual({
      name: "Meeting",
      version: "2.1.0",
      description: "Records and summarizes meetings",
    });
    expect(discover.capabilities.tools).toEqual({ listChanged: true });
  });

  it("declares the MCP Apps extension only when the manifest ships UI", () => {
    expect(manifestToDiscoverResult(BASE_MANIFEST).capabilities.extensions).toBeUndefined();
    const withUi: PluginManifest = {
      ...BASE_MANIFEST,
      ui: [{ slot: "sidebar", entry: "ui/panel.js", title: "Meeting" } as never],
    };
    const discover = manifestToDiscoverResult(withUi);
    expect(discover.capabilities.extensions).toMatchObject({
      "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
    });
  });

  it("does NOT project the advisory manifest.capabilities[] into MCP ServerCapabilities", () => {
    const withCaps: PluginManifest = { ...BASE_MANIFEST, capabilities: ["meeting-recorder", "mail-source"] };
    const discover = manifestToDiscoverResult(withCaps);
    // capabilities map has only `tools` (derived from tools[]); no kebab tags leak in.
    expect(Object.keys(discover.capabilities)).toEqual(["tools"]);
    expect(JSON.stringify(discover.capabilities)).not.toContain("meeting-recorder");
  });
});
