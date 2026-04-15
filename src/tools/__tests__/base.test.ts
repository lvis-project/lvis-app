/**
 * BaseTool unit tests — Tier S3
 *
 * Registry semantics now flow through the canonical §6.4
 * {@link ../../core/tool-registry.js ToolRegistry} via the
 * {@link ../adapter.js baseToolToLegacyDefinition} adapter; the prior
 * standalone `BaseToolRegistry` was removed in the Phase 3 follow-up
 * tool-registry unification (see `docs/blueprints/openharness-selective-borrow-plan.md`).
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { ToolRegistry } from "../../core/tool-registry.js";
import { baseToolToLegacyDefinition } from "../adapter.js";
import {
  BaseTool,
  type ToolExecutionContext,
  type ToolResult,
} from "../base.js";

// ─── Fixtures ─────────────────────────────────────────

const echoInputSchema = z.object({ text: z.string() });

class EchoTool extends BaseTool<typeof echoInputSchema> {
  readonly name = "echo";
  readonly description = "Echoes the input text back to the caller.";
  readonly inputSchema = echoInputSchema;

  async execute(
    input: z.infer<typeof echoInputSchema>,
    _ctx: ToolExecutionContext,
  ): Promise<ToolResult> {
    return { output: input.text, isError: false };
  }
}

class ReadOnlyEchoTool extends EchoTool {
  override readonly name = "echo_readonly";

  override isReadOnly(_input: z.infer<typeof echoInputSchema>): boolean {
    return true;
  }
}

class PluginEchoTool extends EchoTool {
  override readonly name = "echo_plugin";
  override readonly source = "plugin" as const;
}

// ─── BaseTool ─────────────────────────────────────────

describe("BaseTool", () => {
  it("toApiSchema returns name, description, and a flat JSON Schema", () => {
    const tool = new EchoTool();
    const schema = tool.toApiSchema();

    expect(schema.name).toBe("echo");
    expect(schema.description).toBe("Echoes the input text back to the caller.");
    expect(schema.input_schema).toBeTypeOf("object");

    // zod v4 native z.toJSONSchema returns a flat object schema (no $ref
    // wrapping) when called without a name option.
    const inputSchema = schema.input_schema as {
      type: string;
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(inputSchema.type).toBe("object");
    expect(inputSchema.properties).toBeDefined();
    expect(inputSchema.properties.text).toBeDefined();
    expect(inputSchema.required).toContain("text");
  });

  it("execute returns a ToolResult", async () => {
    const tool = new EchoTool();
    const result = await tool.execute(
      { text: "hello" },
      { cwd: "/tmp", metadata: {} },
    );
    expect(result.output).toBe("hello");
    expect(result.isError).toBe(false);
  });

  it("isReadOnly defaults to false", () => {
    const tool = new EchoTool();
    expect(tool.isReadOnly({ text: "x" })).toBe(false);
  });

  it("subclass overriding isReadOnly to return true works", () => {
    const tool = new ReadOnlyEchoTool();
    expect(tool.isReadOnly({ text: "x" })).toBe(true);
  });

  it("source defaults to 'builtin'", () => {
    expect(new EchoTool().source).toBe("builtin");
  });

  it("subclass can override source to 'plugin'", () => {
    expect(new PluginEchoTool().source).toBe("plugin");
  });
});

// ─── ToolRegistry integration via adapter ─────────────

describe("BaseTool + ToolRegistry adapter integration", () => {
  it("adapter result registers cleanly into legacy ToolRegistry", () => {
    const registry = new ToolRegistry();
    const tool = new EchoTool();

    registry.register(baseToolToLegacyDefinition(tool));

    expect(registry.size).toBe(1);
    const found = registry.findByName("echo");
    expect(found).toBeDefined();
    expect(found?.name).toBe("echo");
    expect(found?.source).toBe("builtin");
  });

  it("explicit source argument overrides BaseTool.source", () => {
    const registry = new ToolRegistry();
    registry.register(baseToolToLegacyDefinition(new EchoTool(), "plugin"));
    expect(registry.findByName("echo")?.source).toBe("plugin");
  });

  it("BaseTool.source is propagated when no explicit source given", () => {
    const registry = new ToolRegistry();
    registry.register(baseToolToLegacyDefinition(new PluginEchoTool()));
    expect(registry.findByName("echo_plugin")?.source).toBe("plugin");
  });

  it("extras propagates pluginId / mcpServerId / category", () => {
    const registry = new ToolRegistry();
    registry.register(
      baseToolToLegacyDefinition(new EchoTool(), "plugin", {
        pluginId: "lvis-plugin-meeting",
        category: "read",
      }),
    );
    const def = registry.findByName("echo");
    expect(def?.pluginId).toBe("lvis-plugin-meeting");
    expect(def?.category).toBe("read");
  });

  it("getToolSchemas returns one entry per registered BaseTool", () => {
    const registry = new ToolRegistry();
    registry.register(baseToolToLegacyDefinition(new EchoTool()));
    registry.register(baseToolToLegacyDefinition(new ReadOnlyEchoTool()));

    const schemas = registry.getToolSchemas();
    expect(schemas).toHaveLength(2);
    expect(schemas.map((s) => s.name).sort()).toEqual(["echo", "echo_readonly"]);
    for (const entry of schemas) {
      expect(entry).toHaveProperty("name");
      expect(entry).toHaveProperty("description");
      expect(entry).toHaveProperty("input_schema");
    }
  });
});
