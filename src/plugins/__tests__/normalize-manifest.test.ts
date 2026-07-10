/**
 * #885 Plugin Contract v6 — `normalizeManifest` unit tests.
 *
 * Post-Phase-R `normalizeManifest` is a pure visibility materializer over a pure
 * `Tool[]` manifest: it passes tools through, fills an omitted `_meta.ui.visibility`
 * with the standard `["model","app"]` default, and REJECTS an explicit `[]`. The
 * legacy `tools: string[]` + `toolSchemas` + `uiActions` reader (and its
 * dropped-field reporting) was removed in Phase R, so those cases are gone.
 */
import { describe, it, expect } from "vitest";
import { normalizeManifest } from "../types.js";
import type { PluginManifest, Tool } from "../types.js";

function raw(tools: Tool[], over: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: "test-plugin",
    name: "Test",
    version: "1.0.0",
    entry: "index.js",
    description: "test plugin",
    tools,
    ...over,
  };
}

describe("normalizeManifest — pure passthrough + visibility default", () => {
  it("passes a pure manifest through unchanged", () => {
    const tool: Tool = {
      name: "p",
      description: "pure tool",
      inputSchema: { type: "object", properties: {} },
      _meta: { ui: { visibility: ["model"] } },
    };
    const out = normalizeManifest(raw([tool]));
    expect(out.tools).toEqual([tool]);
  });

  it("returns an empty Tool[] for an empty tools array", () => {
    const out = normalizeManifest(raw([]));
    expect(out.tools).toEqual([]);
  });

  it('materializes absent visibility to the standard ["model","app"]', () => {
    const noMeta: Tool = { name: "x", inputSchema: { type: "object", properties: {} } };
    const metaNoVis: Tool = {
      name: "y",
      inputSchema: { type: "object", properties: {} },
      _meta: { "xyz.lvis/pathFields": ["p"] },
    };
    const out = normalizeManifest(raw([noMeta, metaNoVis]));
    expect(out.tools[0]._meta?.ui?.visibility).toEqual(["model", "app"]);
    expect(out.tools[1]._meta?.ui?.visibility).toEqual(["model", "app"]);
    expect(out.tools[1]._meta?.["xyz.lvis/pathFields"]).toEqual(["p"]); // preserved
  });

  it("default is governed — never yields an app-only (bypass) tool", () => {
    const out = normalizeManifest(
      raw([{ name: "x", inputSchema: { type: "object", properties: {} } }]),
    );
    const vis = out.tools[0]._meta?.ui?.visibility ?? [];
    const isUiOnly = vis.includes("app") && !vis.includes("model");
    expect(isUiOnly).toBe(false);
  });

  it("keeps a declared pathFields _meta key alongside explicit visibility", () => {
    const tool: Tool = {
      name: "read_file",
      inputSchema: { type: "object", properties: { path: {} } },
      _meta: { ui: { visibility: ["model"] }, "xyz.lvis/pathFields": ["path"] },
    };
    const out = normalizeManifest(raw([tool]));
    expect(out.tools[0]._meta?.["xyz.lvis/pathFields"]).toEqual(["path"]);
    expect(out.tools[0]._meta?.ui?.visibility).toEqual(["model"]);
  });

  it("REJECTS an explicit empty visibility [] (R6 — never widened to dual)", () => {
    const bad: Tool = {
      name: "z",
      inputSchema: { type: "object", properties: {} },
      _meta: { ui: { visibility: [] } },
    };
    expect(() => normalizeManifest(raw([bad]))).toThrow(/visibility is \[\]/);
  });
});
