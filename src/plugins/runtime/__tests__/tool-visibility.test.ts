/**
 * #885 v6 (§0) — the single host reader `toolVisibility` + its derived predicates.
 *
 * The primitive is a pure READER: `normalizeManifest` (U1) is the SOLE defaulting
 * site, so post-normalize every tool carries an explicit non-empty visibility.
 * These tests pin (a) explicit arrays are returned verbatim with no warn, and
 * (b) the DEFENSIVE fail-closed backstop: a tool that reaches a consumer WITHOUT
 * explicit visibility (a normalization-contract violation) resolves to the
 * MINIMAL GOVERNED surface `["model"]` — NEVER app-only, so it can never reach
 * the ungoverned app-only dispatch path — and warns loudly. This is NOT the semantic
 * default (`["model","app"]`, which lives only in normalize).
 */
import { describe, it, expect, vi } from "vitest";
import type { Tool } from "../../types.js";
import { toolVisibility, isModelVisible, isAppVisible, isUiOnly } from "../tool-visibility.js";

function tool(meta: Tool["_meta"]): Tool {
  return { name: "t", inputSchema: { type: "object", properties: {} }, _meta: meta };
}

describe("toolVisibility — explicit arrays are returned verbatim (pure reader, no re-default)", () => {
  it.each([
    [["model"] as const],
    [["app"] as const],
    [["model", "app"] as const],
  ])("returns %j verbatim and does NOT warn", (vis) => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(toolVisibility(tool({ ui: { visibility: [...vis] } }))).toEqual([...vis]);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("toolVisibility — fail-closed defensive backstop (never app-only)", () => {
  const brokenCases: Array<[string, Tool]> = [
    ["_meta absent", { name: "t", inputSchema: { type: "object", properties: {} } }],
    ["_meta.ui absent", tool({ "xyz.lvis/pathFields": ["p"] })],
    ["visibility []", tool({ ui: { visibility: [] } })],
    ["visibility bogus", tool({ ui: { visibility: ["bogus" as "model"] } })],
  ];

  it.each(brokenCases)("%s → resolves ['model'] (governed) AND warns", (_label, t) => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const vis = toolVisibility(t);
      // fail-closed: minimal GOVERNED surface, never app-only.
      expect(vis).toEqual(["model"]);
      expect(vis).not.toContain("app");
      const warned = warnSpy.mock.calls.some((args) =>
        args.some(
          (a) =>
            (typeof a === "string" && /explicit _meta\.ui\.visibility/.test(a)) ||
            (typeof a === "object" && a !== null && (a as { event?: string }).event === "tool-visibility-missing"),
        ),
      );
      expect(warned).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("the backstop is fail-closed w.r.t. the bypass: isUiOnly is false for a missing-visibility tool", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const t: Tool = { name: "t", inputSchema: { type: "object", properties: {} } };
      expect(isModelVisible(t)).toBe(true);
      expect(isAppVisible(t)).toBe(false);
      expect(isUiOnly(t)).toBe(false); // governed, never the ungoverned bypass
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("isModelVisible / isAppVisible / isUiOnly — SoT §2.3 membership", () => {
  it("model-only → model-visible, not ui-only", () => {
    const t = tool({ ui: { visibility: ["model"] } });
    expect(isModelVisible(t)).toBe(true);
    expect(isAppVisible(t)).toBe(false);
    expect(isUiOnly(t)).toBe(false);
  });

  it("dual → model AND app visible, not ui-only (model wins → governed)", () => {
    const t = tool({ ui: { visibility: ["model", "app"] } });
    expect(isModelVisible(t)).toBe(true);
    expect(isAppVisible(t)).toBe(true);
    expect(isUiOnly(t)).toBe(false);
  });

  it("app-only → ui-only (the ONLY isUiOnly=true case — the bypass surface)", () => {
    const t = tool({ ui: { visibility: ["app"] } });
    expect(isModelVisible(t)).toBe(false);
    expect(isAppVisible(t)).toBe(true);
    expect(isUiOnly(t)).toBe(true);
  });
});
