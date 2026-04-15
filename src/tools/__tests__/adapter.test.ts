/**
 * BaseTool → legacy ToolDefinition adapter unit tests — Tier A1 (W1).
 *
 * Verifies that {@link baseToolToLegacyDefinition} produces a definition
 * whose execute() round-trips through the legacy §6.4 {@link ToolRegistry}
 * cleanly. No network, no filesystem, no electron — pure in-memory.
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";

import { baseToolToLegacyDefinition } from "../adapter.js";
import {
  BaseTool,
  type ToolExecutionContext,
  type ToolResult,
} from "../base.js";
import { ToolRegistry } from "../../core/tool-registry.js";

// ─── Fixture ────────────────────────────────────────

const echoSchema = z.object({
  text: z.string().describe("text to echo back"),
  shout: z.boolean().optional(),
});

class EchoTool extends BaseTool<typeof echoSchema> {
  readonly name = "echo_adapter";
  readonly description = "Fixture tool for adapter round-trip tests.";
  readonly inputSchema = echoSchema;

  async execute(
    input: z.infer<typeof echoSchema>,
    _ctx: ToolExecutionContext,
  ): Promise<ToolResult> {
    const output = input.shout ? input.text.toUpperCase() : input.text;
    return { output, isError: false, metadata: { shouted: !!input.shout } };
  }
}

// ─── Tests ──────────────────────────────────────────

describe("baseToolToLegacyDefinition", () => {
  it("preserves name + description from the BaseTool", () => {
    const def = baseToolToLegacyDefinition(new EchoTool());
    expect(def.name).toBe("echo_adapter");
    expect(def.description).toBe(
      "Fixture tool for adapter round-trip tests.",
    );
    expect(def.source).toBe("builtin");
  });

  it("derives parameters as an object schema with properties + required", () => {
    const def = baseToolToLegacyDefinition(new EchoTool());
    expect(def.parameters.type).toBe("object");
    expect(def.parameters.properties).toBeDefined();
    expect(def.parameters.properties.text).toBeDefined();
    expect(def.parameters.required).toContain("text");
  });

  it("honours a custom source argument", () => {
    const def = baseToolToLegacyDefinition(new EchoTool(), "plugin");
    expect(def.source).toBe("plugin");
  });

  it("execute() parses args through the zod schema and returns a ToolResult", async () => {
    const def = baseToolToLegacyDefinition(new EchoTool());
    const result = (await def.execute({ text: "hello", shout: true })) as {
      output: string;
      isError: boolean;
      metadata: { shouted: boolean };
    };
    expect(result.output).toBe("HELLO");
    expect(result.isError).toBe(false);
    expect(result.metadata.shouted).toBe(true);
  });

  it("execute() throws a zod validation error on malformed args", async () => {
    const def = baseToolToLegacyDefinition(new EchoTool());
    await expect(
      def.execute({ text: 123 as unknown as string }),
    ).rejects.toThrowError();
  });
});

describe("ToolRegistry round-trip", () => {
  it("an adapted BaseTool is findable and executable via the legacy registry", async () => {
    const registry = new ToolRegistry();
    registry.register(baseToolToLegacyDefinition(new EchoTool()));

    const found = registry.findByName("echo_adapter");
    expect(found).toBeDefined();
    expect(found?.source).toBe("builtin");

    const result = (await found?.execute({ text: "hi" })) as {
      output: string;
      isError: boolean;
    };
    expect(result.output).toBe("hi");
    expect(result.isError).toBe(false);
  });

  it("getToolSchemas exposes the adapted tool to the LLM", () => {
    const registry = new ToolRegistry();
    registry.register(baseToolToLegacyDefinition(new EchoTool()));

    const schemas = registry.getToolSchemas();
    const entry = schemas.find((s) => s.name === "echo_adapter");
    expect(entry).toBeDefined();
    expect(entry?.input_schema.type).toBe("object");
    expect(entry?.input_schema.properties.text).toBeDefined();
  });
});
