/**
 * BashTool (Tier A1) unit tests — real `sh -c` spawn, no mocks.
 *
 * Uses harmless commands (echo, false, sleep, yes|head) so the test
 * suite remains fast and side-effect free on macOS/Linux CI.
 *
 * BashTool extends the canonical {@link ../base.js ZodTool}, so tests
 * exercise it through the same {@link execute} entry point the §6.4
 * {@link ../registry.js ToolRegistry} uses in production — no adapter.
 */
import { describe, it, expect } from "vitest";

import { ToolRegistry } from "../registry.js";
import { BashTool, BashToolInputSchema } from "../bash.js";
import type { ToolExecutionContext } from "../base.js";

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

describe("BashTool — ZodTool surface", () => {
  it("isReadOnly returns false", () => {
    const tool = new BashTool();
    expect(tool.isReadOnly({ command: "echo", timeoutSeconds: 5 })).toBe(false);
  });

  it("toJsonSchema returns an object schema with a command property", () => {
    const tool = new BashTool();
    const schema = tool.toJsonSchema() as {
      type?: string;
      properties?: Record<string, unknown>;
      required?: string[];
      definitions?: Record<string, unknown>;
      $ref?: string;
    };

    // zodToJsonSchema may wrap in definitions + $ref depending on options.
    const resolved =
      schema.definitions && schema.$ref
        ? (schema.definitions[schema.$ref.replace("#/definitions/", "")] as {
            type: string;
            properties: Record<string, unknown>;
            required?: string[];
          })
        : (schema as {
            type: string;
            properties: Record<string, unknown>;
            required?: string[];
          });

    expect(resolved.type).toBe("object");
    expect(resolved.properties).toBeDefined();
    expect(resolved.properties.command).toBeDefined();
  });

  it("category is 'dangerous'", () => {
    expect(new BashTool().category).toBe("dangerous");
  });

  it("registers directly into the canonical ToolRegistry", () => {
    const registry = new ToolRegistry();
    registry.register(new BashTool());
    const found = registry.findByName("bash");
    expect(found).toBeDefined();
    expect(found?.name).toBe("bash");
    expect(found?.source).toBe("builtin");
    expect(found?.category).toBe("dangerous");
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

// ── H2: env whitelist — secrets must NOT leak to child process ────

describe("BashTool — H2 env whitelist", () => {
  it("does not leak LVIS_TEST_SECRET to the spawned child", async () => {
    // Arrange: set a secret in the parent env
    const SECRET_KEY = "LVIS_TEST_SECRET";
    const SECRET_VAL = "secret-xyz-12345";
    const prev = process.env[SECRET_KEY];
    process.env[SECRET_KEY] = SECRET_VAL;
    try {
      const tool = new BashTool();
      // `env` prints all env vars; if the filter works, LVIS_TEST_SECRET
      // is absent and grep exits 1 (isError=true with "(no output)").
      const result = await tool.execute(
        { command: "env | grep LVIS_TEST_SECRET || true", timeoutSeconds: 5 },
        ctx(),
      );
      // The child exited cleanly (|| true) but no match should be found
      expect(result.output).not.toContain(SECRET_VAL);
      expect(result.output).not.toContain("LVIS_TEST_SECRET=");
    } finally {
      if (prev === undefined) delete process.env[SECRET_KEY];
      else process.env[SECRET_KEY] = prev;
    }
  });

  it("does not leak ANTHROPIC_API_KEY to the spawned child", async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-should-not-leak";
    try {
      const tool = new BashTool();
      const result = await tool.execute(
        { command: "env | grep ANTHROPIC_API_KEY || true", timeoutSeconds: 5 },
        ctx(),
      );
      expect(result.output).not.toContain("sk-ant-test-should-not-leak");
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });

  it("still forwards PATH so basic commands resolve", async () => {
    const tool = new BashTool();
    // `echo` is a shell builtin but `which echo` exercises PATH lookup.
    const result = await tool.execute(
      { command: "which echo || true", timeoutSeconds: 5 },
      ctx(),
    );
    // We expect either "/bin/echo", "/usr/bin/echo", or similar — just
    // verify PATH was not stripped (output contains "echo")
    expect(result.output).toContain("echo");
  });
});
