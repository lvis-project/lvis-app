/**
 * BashTool (Tier A1) unit tests — real `sh -c` spawn, no mocks.
 *
 * Uses harmless commands (echo, false, sleep, yes|head) so the test
 * suite remains fast and side-effect free on macOS/Linux CI.
 */
import { describe, it, expect } from "vitest";

import { BashTool, BashToolInputSchema } from "../bash.js";
import { ToolRegistry, type ToolExecutionContext } from "../base.js";

const ctx = (cwd: string = process.cwd()): ToolExecutionContext => ({
  cwd,
  metadata: {},
});

describe("BashTool — happy path", () => {
  it("runs `echo hello` and returns output with returncode 0", async () => {
    const tool = new BashTool();
    const result = await tool.execute(
      { command: "echo hello", timeoutSeconds: 5 },
      ctx(),
    );
    expect(result.isError).toBe(false);
    expect(result.output).toBe("hello");
    expect(result.metadata).toEqual({ returncode: 0 });
  });
});

describe("BashTool — non-zero exit", () => {
  it("returns isError=true and returncode=1 for `false`", async () => {
    const tool = new BashTool();
    const result = await tool.execute(
      { command: "false", timeoutSeconds: 5 },
      ctx(),
    );
    expect(result.isError).toBe(true);
    expect(result.metadata?.returncode).toBe(1);
  });
});

describe("BashTool — output cap", () => {
  it("truncates very large output to ~12_000 chars + marker", async () => {
    const tool = new BashTool();
    const result = await tool.execute(
      { command: "yes | head -n 10000", timeoutSeconds: 5 },
      ctx(),
    );
    expect(result.isError).toBe(false);
    // "yes" outputs "y\n" repeated -> 20_000 chars -> must be truncated.
    expect(result.output.length).toBeGreaterThan(12_000);
    expect(result.output.length).toBeLessThan(12_100);
    expect(result.output.endsWith("...[truncated]...")).toBe(true);
  });
});

describe("BashTool — timeout", () => {
  it(
    "kills a long sleep and reports timedOut metadata",
    async () => {
      const tool = new BashTool();
      const result = await tool.execute(
        { command: "sleep 5", timeoutSeconds: 1 },
        ctx(),
      );
      expect(result.isError).toBe(true);
      expect(result.metadata?.timedOut).toBe(true);
      expect(result.output).toMatch(/timed out/i);
    },
    { timeout: 3000 },
  );
});

describe("BashTool — preflight interactive command block", () => {
  it("blocks `npm create some-app` without non-interactive flag", async () => {
    const tool = new BashTool();
    const result = await tool.execute(
      { command: "npm create some-app", timeoutSeconds: 5 },
      ctx(),
    );
    expect(result.isError).toBe(true);
    expect(result.metadata?.interactiveRequired).toBe(true);
    expect(result.output.toLowerCase()).toContain("interactive");
    // Did NOT actually spawn — returncode should be absent.
    expect(result.metadata).not.toHaveProperty("returncode");
  });

  it("allows a command that looks interactive but has -y flag", async () => {
    // Use a harmless echo with the literal scaffold string + -y to exercise
    // the allow branch without spawning a real scaffolder.
    const tool = new BashTool();
    const result = await tool.execute(
      { command: "echo some-app -y", timeoutSeconds: 5 },
      ctx(),
    );
    // Preflight did NOT block — metadata.interactiveRequired is undefined.
    expect(result.metadata?.interactiveRequired).toBeUndefined();
    expect(result.isError).toBe(false);
    expect(result.output).toBe("some-app -y");
  });
});

describe("BashTool — BaseTool surface", () => {
  it("isReadOnly returns false", () => {
    const tool = new BashTool();
    expect(tool.isReadOnly({ command: "echo", timeoutSeconds: 5 })).toBe(false);
  });

  it("toApiSchema returns name, description, input_schema with command property", () => {
    const tool = new BashTool();
    const schema = tool.toApiSchema();
    expect(schema.name).toBe("bash");
    expect(schema.description).toBe("Run a shell command in the local repository.");
    expect(schema.input_schema).toBeTypeOf("object");

    const inputSchema = schema.input_schema as {
      type?: string;
      properties?: Record<string, unknown>;
      required?: string[];
      definitions?: Record<string, unknown>;
      $ref?: string;
    };

    // zodToJsonSchema with name option wraps schema in definitions + $ref.
    const resolved =
      inputSchema.definitions && inputSchema.$ref
        ? (inputSchema.definitions[inputSchema.$ref.replace("#/definitions/", "")] as {
            type: string;
            properties: Record<string, unknown>;
            required?: string[];
          })
        : (inputSchema as {
            type: string;
            properties: Record<string, unknown>;
            required?: string[];
          });

    expect(resolved.type).toBe("object");
    expect(resolved.properties).toBeDefined();
    expect(resolved.properties.command).toBeDefined();
  });

  it("registers in a fresh ToolRegistry", () => {
    const registry = new ToolRegistry();
    const tool = new BashTool();
    registry.register(tool);
    expect(registry.has("bash")).toBe(true);
    expect(registry.get("bash")).toBe(tool);
  });
});

describe("BashTool — sandbox violation", () => {
  it("rejects cwd outside the sandbox boundary", async () => {
    const tool = new BashTool();
    const result = await tool.execute(
      { command: "echo hi", cwd: "/etc", timeoutSeconds: 5 },
      ctx(),
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Sandbox:");
  });
});

describe("BashTool — schema default", () => {
  it("input schema defaults timeoutSeconds to 600 when omitted", () => {
    const parsed = BashToolInputSchema.parse({ command: "echo hi" });
    expect(parsed.timeoutSeconds).toBe(600);
  });
});
