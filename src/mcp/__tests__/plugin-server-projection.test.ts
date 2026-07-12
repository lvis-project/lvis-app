import { describe, it, expect } from "vitest";
import {
  manifestToDiscoverResult,
  manifestToolsToMcpTools,
} from "../plugin-server-projection.js";
import type { PluginManifest } from "../../plugins/types.js";

// #885 v6 — the projection reads the NORMALIZED pure `Tool[]` (manifest == wire)
// and projects ALL of them: a server's tools/list is its tools, and the audience of
// each one rides on its own `_meta.ui.visibility`.
const BASE_MANIFEST: PluginManifest = {
  id: "com.example.meeting",
  name: "Meeting",
  version: "2.1.0",
  entry: "dist/hostPlugin.js",
  description: "Records and summarizes meetings",
  tools: [
    {
      name: "meeting_start",
      description: "Start recording",
      inputSchema: { type: "object", properties: { room: { type: "string" } }, required: ["room"] },
      _meta: { ui: { visibility: ["model"] } },
    },
    {
      name: "meeting_export",
      description: "Export the transcript to a path",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
      _meta: { ui: { visibility: ["model"] }, "lvisai/pathFields": ["path"] },
    },
    {
      // APP-ONLY — serves the plugin's CARD, hidden from the model. It IS projected
      // (that is how it becomes a governed registry `Tool`); the model never sees it
      // because the registry's model-exposure boundary subtracts it.
      name: "meeting_upload_chunk",
      description: "Upload a staged chunk",
      inputSchema: { type: "object", properties: {} },
      _meta: { ui: { visibility: ["app"] } },
    },
    {
      // dual — projected, visibility explicit.
      name: "meeting_toggle",
      description: "Toggle recording",
      inputSchema: { type: "object", properties: {} },
      _meta: { ui: { visibility: ["model", "app"] } },
    },
  ],
};

describe("plugin-server-projection — normalized Tool[] → MCP tools/list (#885 v6)", () => {
  it("relabels the inputSchema dialect to JSON Schema 2020-12, preserving body keywords", () => {
    const start = manifestToolsToMcpTools(BASE_MANIFEST).find((t) => t.name === "meeting_start")!;
    expect(start.inputSchema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(start.inputSchema.properties).toEqual({ room: { type: "string" } });
    expect(start.inputSchema.required).toEqual(["room"]);
  });

  it("emits _meta.ui.visibility EXPLICITLY on every projected tool", () => {
    const tools = manifestToolsToMcpTools(BASE_MANIFEST);
    for (const t of tools) {
      expect(Array.isArray(t._meta.ui.visibility)).toBe(true);
      expect(t._meta.ui.visibility.length).toBeGreaterThan(0);
    }
    expect(tools.find((t) => t.name === "meeting_toggle")!._meta.ui.visibility).toEqual(["model", "app"]);
  });

  it("PROJECTS app-only tools too, carrying their [\"app\"] visibility — the spec's own spelling, not a hole in tools/list", () => {
    const tools = manifestToolsToMcpTools(BASE_MANIFEST);
    // Every declared tool, in manifest order. The app-only one is what a card calls;
    // withholding it from tools/list is what used to leave it with no registry
    // `Tool`, hence no risk classifier / approval gate / audit row — so the app arm
    // had to deny it outright. It is projected, and the visibility rides with it.
    expect(tools.map((t) => t.name)).toEqual([
      "meeting_start",
      "meeting_export",
      "meeting_upload_chunk",
      "meeting_toggle",
    ]);
    expect(tools.find((t) => t.name === "meeting_upload_chunk")!._meta.ui.visibility).toEqual(["app"]);
  });

  it("carries pathFields in _meta iff declared, and emits NONE of the removed proprietary keys / annotations", () => {
    const tools = manifestToolsToMcpTools(BASE_MANIFEST);
    const start = tools.find((t) => t.name === "meeting_start")!;
    const exp = tools.find((t) => t.name === "meeting_export")!;
    expect((start._meta as Record<string, unknown>)["lvisai/pathFields"]).toBeUndefined();
    expect(exp._meta["lvisai/pathFields"]).toEqual(["path"]);
    for (const t of tools) {
      const meta = t._meta as Record<string, unknown>;
      // removed fields never ride the wire
      expect(meta["lvisai/category"]).toBeUndefined();
      expect(meta["lvisai/version"]).toBeUndefined();
      expect(meta["lvisai/writesToOwnSandbox"]).toBeUndefined();
      expect(meta["lvisai/workerId"]).toBeUndefined();
      expect(meta["lvisai/deprecatedSince"]).toBeUndefined();
      expect(meta["lvisai/replacedBy"]).toBeUndefined();
      // host never projects (untrusted) annotations
      expect((t as Record<string, unknown>).annotations).toBeUndefined();
      // only `ui` + vendor-prefixed lvisai/* keys; never a reserved mcp second label.
      for (const key of Object.keys(meta)) {
        expect(key === "ui" || key.startsWith("lvisai/")).toBe(true);
        expect(key).not.toMatch(/(^|\.)(mcp|modelcontextprotocol)\//);
      }
    }
  });

  it("transitional: reads a legacy xyz.lvis/pathFields manifest but emits ONLY the new lvisai/pathFields on the wire", () => {
    // A published manifest that has not yet migrated still declares the reverse-DNS
    // key; the forward projection must read it, but the WIRE carries only the new key.
    const legacyManifest: PluginManifest = {
      id: "com.example.legacy",
      name: "Legacy",
      version: "1.0.0",
      entry: "dist/index.js",
      description: "legacy manifest",
      tools: [
        {
          name: "legacy_export",
          description: "Export to a path",
          inputSchema: { type: "object", properties: { path: { type: "string" } } },
          _meta: { ui: { visibility: ["model"] }, "xyz.lvis/pathFields": ["path"] },
        },
      ],
    };
    const tool = manifestToolsToMcpTools(legacyManifest)[0];
    expect(tool._meta["lvisai/pathFields"]).toEqual(["path"]);
    expect((tool._meta as Record<string, unknown>)["xyz.lvis/pathFields"]).toBeUndefined();
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

  it("declares the MCP Apps extension when the manifest ships a served ui:// card (uiResources)", () => {
    const withUiResources: PluginManifest = {
      ...BASE_MANIFEST,
      uiResources: [{ uri: "ui://com.example.meeting/card.html" }],
    };
    const discover = manifestToDiscoverResult(withUiResources);
    expect(discover.capabilities.extensions).toMatchObject({
      "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
    });
  });

  it("does NOT project the advisory manifest.capabilities[] into MCP ServerCapabilities", () => {
    const withCaps: PluginManifest = { ...BASE_MANIFEST, capabilities: ["meeting-recorder", "mail-source"] };
    const discover = manifestToDiscoverResult(withCaps);
    expect(Object.keys(discover.capabilities)).toEqual(["tools"]);
    expect(JSON.stringify(discover.capabilities)).not.toContain("meeting-recorder");
  });
});
