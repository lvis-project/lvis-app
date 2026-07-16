import { describe, expect, it } from "vitest";

import { createDynamicTool, type Tool } from "../base.js";
import { ToolRegistry } from "../registry.js";
import type {
  ToolCategory,
  ToolDecisionOverride,
  ToolSource,
} from "../types.js";

function tool(input: {
  name: string;
  source?: ToolSource;
  category?: ToolCategory;
  decisionOverride?: ToolDecisionOverride;
  categoryForInput?: (value: unknown) => ToolCategory;
}): Tool {
  const source = input.source ?? "builtin";
  return createDynamicTool({
    name: input.name,
    description: input.name,
    source,
    category: input.category ?? "write",
    ...(input.decisionOverride === undefined
      ? {}
      : { decisionOverride: input.decisionOverride }),
    ...(input.categoryForInput === undefined
      ? {}
      : { categoryForInput: input.categoryForInput }),
    ...(source === "plugin" ? { pluginId: "plugin-a" } : {}),
    ...(source === "mcp" ? { mcpServerId: "server-a" } : {}),
    jsonSchema: { type: "object", properties: {} },
    execute: async () => ({ output: "ok", isError: false }),
  });
}

describe("ToolRegistry host-only meta governance", () => {
  it("accepts only the two explicit builtin meta overrides", () => {
    const registry = new ToolRegistry();
    registry.register(tool({
      name: "agent_spawn",
      category: "meta",
      decisionOverride: "ask",
    }));
    registry.register(tool({
      name: "agent_status",
      category: "meta",
      decisionOverride: "always-allow-with-audit",
    }));

    expect(registry.findByName("agent_spawn")?.decisionOverride).toBe("ask");
    expect(registry.findByName("agent_status")?.decisionOverride).toBe(
      "always-allow-with-audit",
    );
  });

  it.each(["plugin", "mcp"] as const)(
    "rejects %s tools that forge meta, decisionOverride, or categoryForInput",
    (source) => {
      const registry = new ToolRegistry();
      expect(() => registry.register(tool({
        name: `${source}-meta`,
        source,
        category: "meta",
        decisionOverride: "ask",
      }))).toThrow(/host-only meta/);
      expect(() => registry.register(tool({
        name: `${source}-override`,
        source,
        decisionOverride: "ask",
      }))).toThrow(/cannot declare decisionOverride/);
      expect(() => registry.register(tool({
        name: `${source}-dynamic-category`,
        source,
        categoryForInput: () => "read",
      }))).toThrow(/cannot declare categoryForInput/);
    },
  );

  it("rejects incomplete or contradictory builtin shapes", () => {
    const registry = new ToolRegistry();
    expect(() => registry.register(tool({
      name: "missing-override",
      category: "meta",
    }))).toThrow(/requires a supported decisionOverride/);
    expect(() => registry.register(tool({
      name: "dynamic-meta",
      category: "meta",
      decisionOverride: "ask",
      categoryForInput: () => "write",
    }))).toThrow(/Meta tool .* cannot declare categoryForInput/);
    expect(() => registry.register(tool({
      name: "non-meta-override",
      category: "write",
      decisionOverride: "ask",
    }))).toThrow(/Non-meta builtin tool .* cannot declare decisionOverride/);
  });

  it("prevalidates registerBatch before mutating the live registry", () => {
    const registry = new ToolRegistry();
    expect(() => registry.registerBatch([
      tool({ name: "valid-first" }),
      tool({
        name: "forged-second",
        source: "plugin",
        category: "meta",
        decisionOverride: "ask",
      }),
    ])).toThrow(/host-only meta/);

    expect(registry.findByName("valid-first")).toBeUndefined();
    expect(registry.findByName("forged-second")).toBeUndefined();
  });

  it("keeps replacePluginTools atomic when a replacement violates governance", () => {
    const registry = new ToolRegistry();
    const original = tool({ name: "plugin-original", source: "plugin" });
    registry.register(original);

    expect(() => registry.replacePluginTools(["plugin-a"], [tool({
      name: "plugin-forged-meta",
      source: "plugin",
      category: "meta",
      decisionOverride: "ask",
    })])).toThrow(/host-only meta/);

    expect(registry.findByName("plugin-original")).toBe(original);
    expect(registry.findByName("plugin-forged-meta")).toBeUndefined();
  });
});
