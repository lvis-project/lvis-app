/**
 * BaseTool + BaseToolRegistry unit tests — Tier S3
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  BaseTool,
  BaseToolRegistry,
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

// ─── BaseTool ─────────────────────────────────────────

describe("BaseTool", () => {
  it("toApiSchema returns name, description, and input_schema", () => {
    const tool = new EchoTool();
    const schema = tool.toApiSchema();

    expect(schema.name).toBe("echo");
    expect(schema.description).toBe("Echoes the input text back to the caller.");
    expect(schema.input_schema).toBeTypeOf("object");

    const inputSchema = schema.input_schema as {
      type?: string;
      properties?: Record<string, unknown>;
      required?: string[];
      definitions?: Record<string, unknown>;
      $ref?: string;
    };

    // zodToJsonSchema with name option wraps schema in definitions + $ref.
    // Resolve to the actual object schema.
    const resolved =
      inputSchema.definitions && inputSchema.$ref
        ? (inputSchema.definitions[inputSchema.$ref.replace("#/definitions/", "")] as {
            type: string;
            properties: Record<string, unknown>;
            required: string[];
          })
        : (inputSchema as {
            type: string;
            properties: Record<string, unknown>;
            required: string[];
          });

    expect(resolved.type).toBe("object");
    expect(resolved.properties).toBeDefined();
    expect(resolved.properties.text).toBeDefined();
    expect(resolved.required).toContain("text");
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
});

// ─── BaseToolRegistry ─────────────────────────────────────

describe("BaseToolRegistry", () => {
  it("register + get + has + list", () => {
    const registry = new BaseToolRegistry();
    const tool = new EchoTool();

    expect(registry.has("echo")).toBe(false);
    expect(registry.get("echo")).toBeUndefined();
    expect(registry.list()).toEqual([]);

    registry.register(tool);

    expect(registry.has("echo")).toBe(true);
    expect(registry.get("echo")).toBe(tool);
    expect(registry.list()).toEqual([tool]);
  });

  it("registering the same tool twice throws", () => {
    const registry = new BaseToolRegistry();
    registry.register(new EchoTool());
    expect(() => registry.register(new EchoTool())).toThrowError(
      /Tool already registered: echo/,
    );
  });

  it("toApiSchema returns one entry per registered tool", () => {
    const registry = new BaseToolRegistry();
    registry.register(new EchoTool());
    registry.register(new ReadOnlyEchoTool());

    const schemas = registry.toApiSchema();
    expect(schemas).toHaveLength(2);
    expect(schemas.map((s) => s.name).sort()).toEqual(["echo", "echo_readonly"]);
    for (const entry of schemas) {
      expect(entry).toHaveProperty("name");
      expect(entry).toHaveProperty("description");
      expect(entry).toHaveProperty("input_schema");
    }
  });
});
