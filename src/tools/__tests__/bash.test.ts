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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ToolRegistry } from "../registry.js";
import { BashTool, BashToolInputSchema } from "../bash.js";
import type { ToolExecutionContext } from "../base.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";

const ctx = (cwd: string = process.cwd()): ToolExecutionContext => ({
  cwd,
  extraAllowedDirectories: [],
  metadata: {},
});
const SHELL_TIMEOUT_SECONDS = process.platform === "win32" ? 20 : 5;

describe("BashTool — happy path", () => {
  it("runs `echo hello` and returns output with returncode 0", async () => {
    const tool = new BashTool();
    const result = await tool.execute(
      { command: "echo hello", timeoutSeconds: SHELL_TIMEOUT_SECONDS },
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
      { command: "false", timeoutSeconds: SHELL_TIMEOUT_SECONDS },
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
      { command: "yes | head -n 10000", timeoutSeconds: SHELL_TIMEOUT_SECONDS },
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
    { timeout: 8000 },
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
  );
});

describe("BashTool — preflight interactive command block", () => {
  it("blocks `npm create some-app` without non-interactive flag", async () => {
    const tool = new BashTool();
    const result = await tool.execute(
      { command: "npm create some-app", timeoutSeconds: SHELL_TIMEOUT_SECONDS },
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
      { command: "echo some-app -y", timeoutSeconds: SHELL_TIMEOUT_SECONDS },
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
    expect(tool.isReadOnly({ command: "echo", timeoutSeconds: SHELL_TIMEOUT_SECONDS })).toBe(false);
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

  it("category is 'shell'", () => {
    expect(new BashTool().category).toBe("shell");
  });

  it("registers directly into the canonical ToolRegistry", () => {
    const registry = new ToolRegistry();
    registry.register(new BashTool());
    const found = registry.findByName("bash");
    expect(found).toBeDefined();
    expect(found?.name).toBe("bash");
    expect(found?.source).toBe("builtin");
    expect(found?.category).toBe("shell");
  });
});

describe("BashTool — sandbox violation", () => {
  it("rejects cwd outside the sandbox boundary", async () => {
    const tool = new BashTool();
    const result = await tool.execute(
      { command: "echo hi", cwd: "/etc", timeoutSeconds: SHELL_TIMEOUT_SECONDS },
      ctx(),
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Sandbox:");
  });

  it("rejects sensitive cwd even when it is inside the sandbox boundary", async () => {
    const root = mkdtempSync(join(tmpdir(), "lvis-bash-sensitive-cwd-"));
    const sensitive = join(root, ".lvis", "secrets");
    mkdirSync(sensitive, { recursive: true });
    try {
      const result = await new BashTool().execute(
        { command: "echo hi", cwd: sensitive, timeoutSeconds: SHELL_TIMEOUT_SECONDS },
        ctx(root),
      );
      expect(result.isError).toBe(true);
      expect(result.output).toContain("Sensitive path:");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects sensitive path operands before spawning the shell", async () => {
    const root = mkdtempSync(join(tmpdir(), "lvis-bash-sensitive-operand-"));
    const target = join(root, ".ssh", "id_rsa");
    mkdirSync(join(root, ".ssh"), { recursive: true });
    writeFileSync(target, "secret", "utf8");
    try {
      const result = await new BashTool().execute(
        { command: `cat ${target}`, timeoutSeconds: SHELL_TIMEOUT_SECONDS },
        ctx(root),
      );
      expect(result.isError).toBe(true);
      expect(result.output).toContain("Sensitive path:");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects bare sensitive filename operands before spawning the shell", async () => {
    const root = mkdtempSync(join(tmpdir(), "lvis-bash-bare-sensitive-"));
    writeFileSync(join(root, ".env"), "SECRET=1\n", "utf8");
    try {
      const result = await new BashTool().execute(
        { command: "cat .env", timeoutSeconds: SHELL_TIMEOUT_SECONDS },
        ctx(root),
      );
      expect(result.isError).toBe(true);
      expect(result.output).toContain("Sensitive path:");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects redirection-attached sensitive operands before spawning the shell", async () => {
    const result = await new BashTool().execute(
      { command: "cat<$HOME/.ssh/id_rsa", timeoutSeconds: SHELL_TIMEOUT_SECONDS },
      ctx(),
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Sensitive path:");
  });

  it("rejects unsupported ~user operands instead of validating a fake cwd-relative path", async () => {
    const result = await new BashTool().execute(
      { command: "cat ~ken/Documents/not-in-sandbox.txt", timeoutSeconds: SHELL_TIMEOUT_SECONDS },
      ctx(),
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("unsupported user-home expansion");
  });

  it("rejects bare ~user operands before shell expansion", async () => {
    const result = await new BashTool().execute(
      { command: "ls ~ken", timeoutSeconds: SHELL_TIMEOUT_SECONDS },
      ctx(),
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("unsupported user-home expansion");
  });

  it("rejects redirection targets outside the sandbox before spawning the shell", async () => {
    const root = mkdtempSync(join(tmpdir(), "lvis-bash-redirection-"));
    try {
      const result = await new BashTool().execute(
        { command: "printf x>/private/tmp/lvis-outside-redirection", timeoutSeconds: SHELL_TIMEOUT_SECONDS },
        ctx(root),
      );
      expect(result.isError).toBe(true);
      expect(result.output).toContain("Sandbox:");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects recursive filesystem traversal before spawning the shell", async () => {
    const root = mkdtempSync(join(tmpdir(), "lvis-bash-recursive-traversal-"));
    try {
      const result = await new BashTool().execute(
        { command: "grep -R SECRET .", timeoutSeconds: SHELL_TIMEOUT_SECONDS },
        ctx(root),
      );
      expect(result.isError).toBe(true);
      expect(result.output).toContain("recursive shell filesystem traversal");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("BashTool — schema default", () => {
  it("input schema defaults timeoutSeconds to policy.shellDefaultMs / 1000 when omitted", () => {
    const parsed = BashToolInputSchema.parse({ command: "echo hi" });
    expect(parsed.timeoutSeconds).toBe(TOOL_TIMEOUT_POLICY.shellDefaultMs / 1000);
  });

  it("input schema rejects timeoutSeconds above policy.shellMaxMs / 1000", () => {
    const above = TOOL_TIMEOUT_POLICY.shellMaxMs / 1000 + 1;
    expect(() => BashToolInputSchema.parse({ command: "echo hi", timeoutSeconds: above })).toThrow();
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
        { command: "env | grep LVIS_TEST_SECRET || true", timeoutSeconds: SHELL_TIMEOUT_SECONDS },
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
        { command: "env | grep ANTHROPIC_API_KEY || true", timeoutSeconds: SHELL_TIMEOUT_SECONDS },
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
      { command: "which echo || true", timeoutSeconds: SHELL_TIMEOUT_SECONDS },
      ctx(),
    );
    // We expect either "/bin/echo", "/usr/bin/echo", or similar — just
    // verify PATH was not stripped (output contains "echo")
    expect(result.output).toContain("echo");
  });
});
