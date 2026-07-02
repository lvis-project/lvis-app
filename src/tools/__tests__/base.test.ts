/**
 * Tool interface + ZodTool + createDynamicTool unit tests.
 *
 * Verifies the canonical §6.4 {@link ../base.js Tool} contract end-to-end:
 *   - {@link ZodTool} subclass: schema-backed execute via executeTyped.
 *   - {@link createDynamicTool}: factory for runtime-built tools
 *     (plugin / MCP / factory paths).
 *   - {@link ToolRegistry} integration: tools register + look up cleanly.
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";

import { ToolRegistry } from "../registry.js";
import {
  ZodTool,
  createDynamicTool,
  type Tool,
  type ToolExecutionContext,
  type ToolResult,
} from "../base.js";

// ─── Fixtures ─────────────────────────────────────────

const echoInputSchema = z.object({ text: z.string() });

class EchoTool extends ZodTool<typeof echoInputSchema> {
  readonly name = "echo";
  readonly description = "Echoes the input text back to the caller.";
  readonly inputSchema = echoInputSchema;

  protected async executeTyped(
    input: z.infer<typeof echoInputSchema>,
    _ctx: ToolExecutionContext,
  ): Promise<ToolResult> {
    return { output: input.text, isError: false };
  }
}

class ReadOnlyEchoTool extends EchoTool {
  override readonly name = "echo_readonly";

  override isReadOnly(_input: unknown): boolean {
    return true;
  }
}

class PluginEchoTool extends EchoTool {
  override readonly name = "echo_plugin";
  override readonly source = "plugin" as const;
}

const ctx = (): ToolExecutionContext => ({ cwd: "/tmp", extraAllowedDirectories: [], metadata: {} });

// ─── ZodTool ──────────────────────────────────────────

describe("ZodTool", () => {
  it("toJsonSchema returns a JSON Schema derived from the zod input schema", () => {
    const tool = new EchoTool();
    const schema = tool.toJsonSchema() as {
      type?: string;
      properties?: Record<string, unknown>;
      required?: string[];
    };

    expect(schema.type).toBe("object");
    expect(schema.properties).toBeDefined();
    expect(schema.properties?.text).toBeDefined();
    expect(schema.required).toContain("text");
  });

  it("execute() parses rawInput via the zod schema then dispatches executeTyped", async () => {
    const tool = new EchoTool();
    const result = await tool.execute({ text: "hello" }, ctx());
    expect(result.output).toBe("hello");
    expect(result.isError).toBe(false);
  });

  it("execute() throws a zod validation error on malformed input", async () => {
    const tool = new EchoTool();
    await expect(
      tool.execute({ text: 123 as unknown as string }, ctx()),
    ).rejects.toThrowError();
  });

  it("isReadOnly defaults to false", () => {
    expect(new EchoTool().isReadOnly({ text: "x" })).toBe(false);
  });

  it("subclass overriding isReadOnly to return true works", () => {
    expect(new ReadOnlyEchoTool().isReadOnly({ text: "x" })).toBe(true);
  });

  it("source defaults to 'builtin'", () => {
    expect(new EchoTool().source).toBe("builtin");
  });

  it("subclass can override source to 'plugin'", () => {
    expect(new PluginEchoTool().source).toBe("plugin");
  });
});

// ─── createDynamicTool ────────────────────────────────

describe("createDynamicTool", () => {
  it("returns a Tool with every spec field plumbed through", () => {
    const executeSpy = async (): Promise<ToolResult> => ({
      output: "ok",
      isError: false,
    });
    const tool = createDynamicTool({
      name: "dyn_tool",
      description: "Dynamic tool fixture.",
      source: "plugin",
      category: "write",
      pluginId: "lvis-plugin-meeting",
      workerId: "meeting-worker",
      jsonSchema: { type: "object", properties: {} },
      execute: executeSpy,
    });

    expect(tool.name).toBe("dyn_tool");
    expect(tool.description).toBe("Dynamic tool fixture.");
    expect(tool.source).toBe("plugin");
    expect(tool.category).toBe("write");
    expect(tool.pluginId).toBe("lvis-plugin-meeting");
    expect(tool.workerId).toBe("meeting-worker");
    expect(tool.toJsonSchema()).toEqual({ type: "object", properties: {} });
  });

  it("execute callback receives rawInput + ctx and returns the ToolResult", async () => {
    let seen: unknown;
    const tool = createDynamicTool({
      name: "dyn_tool_exec",
      description: "",
      source: "mcp",
      mcpServerId: "srv-1",
      jsonSchema: { type: "object" },
      execute: async (rawInput) => {
        seen = rawInput;
        return { output: "echoed", isError: false };
      },
    });

    const result = await tool.execute({ hello: "world" }, ctx());
    expect(seen).toEqual({ hello: "world" });
    expect(result.output).toBe("echoed");
    expect(result.isError).toBe(false);
  });

  it("isReadOnly defaults to () => false when not supplied", () => {
    const tool = createDynamicTool({
      name: "dyn_tool_ro_default",
      description: "",
      source: "builtin",
      jsonSchema: {},
      execute: async () => ({ output: "", isError: false }),
    });
    expect(tool.isReadOnly({})).toBe(false);
  });

  it("honours a custom isReadOnly callback", () => {
    const tool = createDynamicTool({
      name: "dyn_tool_ro_custom",
      description: "",
      source: "builtin",
      jsonSchema: {},
      isReadOnly: () => true,
      execute: async () => ({ output: "", isError: false }),
    });
    expect(tool.isReadOnly({})).toBe(true);
  });
});

// ─── ToolRegistry integration ─────────────────────────

describe("ToolRegistry with Tool instances", () => {
  it("accepts ZodTool subclasses directly", () => {
    const registry = new ToolRegistry();
    registry.register(new EchoTool());

    expect(registry.size).toBe(1);
    const found = registry.findByName("echo");
    expect(found).toBeDefined();
    expect(found?.name).toBe("echo");
    expect(found?.source).toBe("builtin");
  });

  it("accepts createDynamicTool factory output", () => {
    const registry = new ToolRegistry();
    registry.register(
      createDynamicTool({
        name: "dyn_plugin",
        description: "",
        source: "plugin",
        pluginId: "lvis-plugin-meeting",
        workerId: "meeting-worker",
        category: "read",
        jsonSchema: { type: "object" },
        execute: async () => ({ output: "", isError: false }),
      }),
    );

    const found = registry.findByName("dyn_plugin");
    expect(found).toBeDefined();
    expect(found?.source).toBe("plugin");
    expect(found?.pluginId).toBe("lvis-plugin-meeting");
    expect(found?.workerId).toBe("meeting-worker");
    expect(found?.category).toBe("read");
  });

  it("rejects duplicate registrations", () => {
    const registry = new ToolRegistry();
    registry.register(new EchoTool());
    expect(() => registry.register(new EchoTool())).toThrow(
      /already registered/i,
    );
  });

  it("getToolSchemas returns one entry per registered tool", () => {
    const registry = new ToolRegistry();
    registry.register(new EchoTool());
    registry.register(new ReadOnlyEchoTool());

    const schemas = registry.getToolSchemas();
    expect(schemas).toHaveLength(2);
    expect(schemas.map((s) => s.name).sort()).toEqual(["echo", "echo_readonly"]);
    for (const entry of schemas) {
      expect(entry).toHaveProperty("name");
      expect(entry).toHaveProperty("description");
      expect(entry).toHaveProperty("input_schema");
    }
  });

  it("unregisterByPlugin drops every tool from a given plugin", () => {
    const registry = new ToolRegistry();
    const pluginTool: Tool = createDynamicTool({
      name: "plugin_tool",
      description: "",
      source: "plugin",
      pluginId: "lvis-plugin-meeting",
      jsonSchema: {},
      execute: async () => ({ output: "", isError: false }),
    });
    registry.register(new EchoTool());
    registry.register(pluginTool);
    expect(registry.size).toBe(2);

    registry.unregisterByPlugin("lvis-plugin-meeting");
    expect(registry.size).toBe(1);
    expect(registry.findByName("plugin_tool")).toBeUndefined();
    expect(registry.findByName("echo")).toBeDefined();
  });

  it("unregisterByMcp drops every tool from a given MCP server", () => {
    const registry = new ToolRegistry();
    const mcpTool: Tool = createDynamicTool({
      name: "mcp_tool",
      description: "",
      source: "mcp",
      mcpServerId: "srv-1",
      jsonSchema: {},
      execute: async () => ({ output: "", isError: false }),
    });
    registry.register(mcpTool);
    expect(registry.size).toBe(1);

    registry.unregisterByMcp("srv-1");
    expect(registry.size).toBe(0);
  });

  it("§6.3 Layer 1 deny rule hides tools from getVisibleTools/getToolSchemas", () => {
    const registry = new ToolRegistry();
    registry.register(new EchoTool());
    registry.register(new ReadOnlyEchoTool());
    registry.setDenyRules([{ pattern: "echo_*" }]);

    expect(registry.size).toBe(2); // denied tool still registered
    expect(registry.getVisibleTools().map((t) => t.name)).toEqual(["echo"]);
    expect(registry.getToolSchemas().map((s) => s.name)).toEqual(["echo"]);
  });
});
