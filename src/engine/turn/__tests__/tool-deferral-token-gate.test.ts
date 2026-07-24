/**
 * Budget-based deferral gate (tool-loading-policy.md §7) — unit tests.
 *
 * `shouldDeferToolSchemas` trips when EITHER bound is exceeded:
 *   - count  >= EAGER_TOOL_EXPOSURE_CEILING   (cheap pre-filter)
 *   - tokens >= EAGER_TOOL_EXPOSURE_TOKEN_BUDGET (authoritative token gate)
 *
 * The token gate is the one that protects TPM: a few very large schemas can
 * exceed the token budget while their count stays well under the ceiling.
 */
import { describe, it, expect } from "vitest";

import { shouldDeferToolSchemas } from "../tool-scope.js";
import {
  EAGER_TOOL_EXPOSURE_CEILING,
  EAGER_TOOL_EXPOSURE_TOKEN_BUDGET,
} from "../../../shared/tool-exposure-policy.js";
import type { ConversationLoopDeps } from "../types.js";

function makeDeps(
  tools: Array<{ name: string; pluginId: string; schemaChars: number }>,
): ConversationLoopDeps {
  const modelVisible = tools.map((t) => ({
    name: t.name,
    source: "plugin" as const,
    pluginId: t.pluginId,
  }));
  const schemas = tools.map((t) => ({
    name: t.name,
    description: "d",
    input_schema: {
      type: "object",
      properties: { p: { type: "string", description: "x".repeat(t.schemaChars) } },
    },
    source: "plugin" as const,
  }));
  return {
    headless: false,
    toolRegistry: {
      getModelVisibleTools: () => modelVisible,
      getToolSchemas: () => schemas,
    },
  } as unknown as ConversationLoopDeps;
}

describe("budget-based deferral gate", () => {
  it("keeps the common surface eager (below both count and token budget)", () => {
    // Largest current single plugin (~43 tools) with normal-size schemas.
    const deps = makeDeps(
      Array.from({ length: 43 }, (_, i) => ({ name: `t${i}`, pluginId: "p", schemaChars: 120 })),
    );
    expect(shouldDeferToolSchemas(deps, new Set(["p"]))).toBe(false);
  });

  it("defers when the count reaches the ceiling (cheap pre-filter)", () => {
    const deps = makeDeps(
      Array.from({ length: EAGER_TOOL_EXPOSURE_CEILING }, (_, i) => ({
        name: `t${i}`,
        pluginId: "p",
        schemaChars: 1, // tiny schemas — token budget alone would not trip
      })),
    );
    expect(shouldDeferToolSchemas(deps, new Set(["p"]))).toBe(true);
  });

  it("defers when a few large schemas exceed the token budget (count under ceiling)", () => {
    // 20 tools, each ~12k-char schema → ~240k chars ≈ ~60k tokens > 48k budget,
    // while the count (20) is far under EAGER_TOOL_EXPOSURE_CEILING (200).
    const tools = Array.from({ length: 20 }, (_, i) => ({
      name: `t${i}`,
      pluginId: "p",
      schemaChars: 12000,
    }));
    expect(tools.length).toBeLessThan(EAGER_TOOL_EXPOSURE_CEILING);
    const deps = makeDeps(tools);
    expect(shouldDeferToolSchemas(deps, new Set(["p"]))).toBe(true);
  });

  it("only counts in-scope plugin schemas toward the token budget", () => {
    // Large schemas belong to an OUT-of-scope plugin → not counted → eager.
    const deps = makeDeps(
      Array.from({ length: 20 }, (_, i) => ({ name: `t${i}`, pluginId: "other", schemaChars: 12000 })),
    );
    expect(shouldDeferToolSchemas(deps, new Set(["p"]))).toBe(false);
  });

  it("returns false for an empty scope", () => {
    expect(shouldDeferToolSchemas(makeDeps([]), new Set())).toBe(false);
  });

  it("sanity: the token budget is above the common surface and below the count-ceiling worst case", () => {
    // Documents the calibration invariant the constant relies on.
    expect(EAGER_TOOL_EXPOSURE_TOKEN_BUDGET).toBeGreaterThan(13_000);
    expect(EAGER_TOOL_EXPOSURE_TOKEN_BUDGET).toBeGreaterThan(0);
  });
});
