/**
 * #885 Plugin Contract v6 (phase a2) — `normalizeManifest` unit tests.
 *
 * `normalizeManifest` is the SINGLE legacy-shape reader (SoT §3.1). It compiles a
 * legacy `tools: string[]` + `toolSchemas` + `uiActions` manifest into the pure
 * `Tool[]` form, and passes a pure manifest through while materializing the
 * standard `["model","app"]` visibility default (and REJECTING an explicit `[]`).
 */
import { describe, it, expect, vi } from "vitest";
import { normalizeManifest } from "../types.js";
import type { RawPluginManifest, Tool, NormalizeNotice } from "../types.js";

function raw(
  over: { tools: string[] | Tool[] } & Partial<RawPluginManifest>,
): RawPluginManifest {
  return {
    id: "test-plugin",
    name: "Test",
    version: "1.0.0",
    entry: "index.js",
    description: "test plugin",
    ...over,
  };
}

describe("normalizeManifest — legacy compile", () => {
  it("compiles a legacy manifest into pure Tool[] with derived visibility", () => {
    const m = raw({
      tools: ["t_list", "t_get"], // t_list is ALSO in uiActions ⇒ dual; t_get model-only
      uiActions: { t_list: { description: "ui" }, t_status: { description: "auth" } },
      toolSchemas: {
        t_list: {
          description: "list things",
          inputSchema: { type: "object", properties: { q: {} } },
          pathFields: ["p"],
        },
        t_get: { description: "get one", inputSchema: { type: "object", properties: {} } },
        t_status: { description: "status", inputSchema: { type: "object", properties: {} } },
      },
    });
    const out = normalizeManifest(m);
    const by = Object.fromEntries(out.tools.map((t) => [t.name, t]));

    expect(out.tools).toHaveLength(3); // t_list, t_get (tools[]) + t_status (UI-only)
    expect(by.t_list._meta?.ui?.visibility).toEqual(["model", "app"]); // dual
    expect(by.t_get._meta?.ui?.visibility).toEqual(["model"]); // model-only
    expect(by.t_status._meta?.ui?.visibility).toEqual(["app"]); // UI-only (auth-style)
    expect(by.t_list._meta?.["xyz.lvis/pathFields"]).toEqual(["p"]); // pathFields moved
    expect(by.t_get._meta?.["xyz.lvis/pathFields"]).toBeUndefined();
    // legacy maps eliminated from the normalized manifest
    expect((out as Record<string, unknown>).toolSchemas).toBeUndefined();
    expect((out as Record<string, unknown>).uiActions).toBeUndefined();
  });

  it("drops removed fields and reports once with deduped droppedFields", () => {
    const notices: NormalizeNotice[] = [];
    const m = raw({
      tools: ["a", "b"],
      toolSchemas: {
        a: {
          description: "a",
          inputSchema: { type: "object", properties: {} },
          category: "read",
          workerId: "w",
          version: "9.9.9",
        },
        b: {
          description: "b",
          inputSchema: { type: "object", properties: {} },
          writesToOwnSandbox: true,
          category: "write",
        },
      },
    });
    const out = normalizeManifest(m, (n) => notices.push(n));

    for (const t of out.tools) {
      const bag = t as unknown as Record<string, unknown>;
      expect(bag.category).toBeUndefined();
      expect(bag.workerId).toBeUndefined();
      expect(bag.writesToOwnSandbox).toBeUndefined();
    }
    expect(notices).toHaveLength(1);
    expect(notices[0].pluginId).toBe("test-plugin");
    expect(notices[0].kind).toBe("legacy-shape");
    expect([...notices[0].droppedFields].sort()).toEqual(
      ["category", "version", "workerId", "writesToOwnSandbox"].sort(),
    );
  });

  it("normalizes a schema-less uiActions-only tool to app-visibility empty inputSchema", () => {
    // meeting's "upload quad" case: UI-only, no toolSchemas entry.
    const m = raw({ tools: [], uiActions: { upload_chunk: { description: "chunk" } } });
    const out = normalizeManifest(m);
    expect(out.tools).toHaveLength(1);
    expect(out.tools[0].name).toBe("upload_chunk");
    expect(out.tools[0]._meta?.ui?.visibility).toEqual(["app"]);
    expect(out.tools[0].inputSchema).toEqual({ type: "object", properties: {} });
    expect(out.tools[0].description).toBeUndefined();
  });

  it("treats empty tools:[] as legacy → empty Tool[], no throw", () => {
    const out = normalizeManifest(raw({ tools: [] }));
    expect(out.tools).toEqual([]);
  });
});

describe("normalizeManifest — pure passthrough + visibility default", () => {
  it("passes a pure manifest through unchanged and does not report", () => {
    const report = vi.fn();
    const tool: Tool = {
      name: "p",
      description: "pure tool",
      inputSchema: { type: "object", properties: {} },
      _meta: { ui: { visibility: ["model"] } },
    };
    const out = normalizeManifest(raw({ tools: [tool] }), report);
    expect(out.tools).toEqual([tool]);
    expect(report).not.toHaveBeenCalled();
  });

  it('materializes absent visibility to the standard ["model","app"]', () => {
    const noMeta: Tool = { name: "x", inputSchema: { type: "object", properties: {} } };
    const metaNoVis: Tool = {
      name: "y",
      inputSchema: { type: "object", properties: {} },
      _meta: { "xyz.lvis/pathFields": ["p"] },
    };
    const out = normalizeManifest(raw({ tools: [noMeta, metaNoVis] }));
    expect(out.tools[0]._meta?.ui?.visibility).toEqual(["model", "app"]);
    expect(out.tools[1]._meta?.ui?.visibility).toEqual(["model", "app"]);
    expect(out.tools[1]._meta?.["xyz.lvis/pathFields"]).toEqual(["p"]); // preserved
  });

  it("default is governed — never yields an app-only (bypass) tool", () => {
    const out = normalizeManifest(
      raw({ tools: [{ name: "x", inputSchema: { type: "object", properties: {} } }] }),
    );
    const vis = out.tools[0]._meta?.ui?.visibility ?? [];
    const isUiOnly = vis.includes("app") && !vis.includes("model");
    expect(isUiOnly).toBe(false);
  });

  it("REJECTS an explicit empty visibility [] (R6 — never widened to dual)", () => {
    const bad: Tool = {
      name: "z",
      inputSchema: { type: "object", properties: {} },
      _meta: { ui: { visibility: [] } },
    };
    expect(() => normalizeManifest(raw({ tools: [bad] }))).toThrow(/visibility is \[\]/);
  });
});
