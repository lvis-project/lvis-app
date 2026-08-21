/**
 * Shell tool family tests — bash, powershell, and the background-shell
 * registry with its bash_output / bash_kill tools, colocated with
 * {@link ../shell-tools.ts}. Each original suite keeps its own enclosing
 * describe so its hooks and helpers stay scoped to its own tests.
 *
 * The spawnWithSandbox isolated-HOME integration test stays in
 * bash-sandbox-home-integration.test.ts: it vi.mocks asrt-sandbox.js
 * file-wide, which must not leak onto the unmocked suites here.
 */

import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { __resetManagedChildProcessesForTest } from "../../main/managed-child-processes.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import type { ToolExecutionContext } from "../base.js";
import { ToolRegistry } from "../registry.js";
import {
  backgroundShellManager,
  BashTool,
  BashToolInputSchema,
  binShellForExecutable,
  createBashKillTool,
  createBashOutputTool,
  MAX_OUTPUT_CHARS,
  PowerShellTool,
  PowerShellToolInputSchema,
  resolvePowerShellExecutable,
  validatePowerShellAst,
  validatePowerShellCommand,
  type PowerShellAstSummary,
} from "../shell-tools.js";

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
describe("bash tool", () => {
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
        // Expiry is a RETRYABLE tool error, not a thrown failure: the call
        // returns a normal ToolResult and tells the caller how to escalate.
        expect(result.output).toMatch(/retry with a larger `timeoutSeconds`/i);
      },
    );

    it(
      "a retry with a larger timeoutSeconds runs the same command to completion",
      { timeout: 15000 },
      async () => {
        const tool = new BashTool();
        const timedOut = await tool.execute({ command: "sleep 3", timeoutSeconds: 1 }, ctx());
        expect(timedOut.metadata?.timedOut).toBe(true);
        // Same command, larger budget — the escalation path the timeout message
        // advertises must actually work.
        const retried = await tool.execute({ command: "sleep 3", timeoutSeconds: 10 }, ctx());
        expect(retried.isError).toBe(false);
        expect(retried.metadata?.timedOut).toBeFalsy();
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
        await cleanupTmpDir(root);
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
        await cleanupTmpDir(root);
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
        await cleanupTmpDir(root);
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
        { command: "cat ~example/Documents/not-in-sandbox.txt", timeoutSeconds: SHELL_TIMEOUT_SECONDS },
        ctx(),
      );
      expect(result.isError).toBe(true);
      expect(result.output).toContain("unsupported user-home expansion");
    });

    it("rejects bare ~user operands before shell expansion", async () => {
      const result = await new BashTool().execute(
        { command: "ls ~example", timeoutSeconds: SHELL_TIMEOUT_SECONDS },
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
        await cleanupTmpDir(root);
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
        await cleanupTmpDir(root);
      }
    });
  });

  describe("BashTool — schema default", () => {
    // Hardcoded numeric expectations pin the model-facing contract. If the
    // SOT changes (e.g. shellDefaultMs becomes 61_000), these tests break and
    // force an explicit decision instead of silently drifting the contract.
    it("input schema defaults timeoutSeconds to 120 when omitted — a deadline always exists", () => {
      const parsed = BashToolInputSchema.parse({ command: "echo hi" });
      expect(parsed.timeoutSeconds).toBe(120);
    });

    it("input schema accepts a timeoutSeconds well above the default (escalated retry)", () => {
      expect(BashToolInputSchema.parse({ command: "echo hi", timeoutSeconds: 600 }).timeoutSeconds)
        .toBe(600);
      expect(BashToolInputSchema.parse({ command: "echo hi", timeoutSeconds: 86_400 }).timeoutSeconds)
        .toBe(86_400);
    });

    it("input schema rejects every value that would mean 'wait forever' or is not a count of seconds", () => {
      expect(() => BashToolInputSchema.parse({ command: "echo hi", timeoutSeconds: 0 })).toThrow();
      expect(() => BashToolInputSchema.parse({ command: "echo hi", timeoutSeconds: -1 })).toThrow();
      expect(() => BashToolInputSchema.parse({ command: "echo hi", timeoutSeconds: 1.5 })).toThrow();
      expect(() =>
        BashToolInputSchema.parse({ command: "echo hi", timeoutSeconds: Number.POSITIVE_INFINITY }),
      ).toThrow();
      expect(() =>
        BashToolInputSchema.parse({ command: "echo hi", timeoutSeconds: Number.NaN }),
      ).toThrow();
      expect(() =>
        BashToolInputSchema.parse({ command: "echo hi", timeoutSeconds: null }),
      ).toThrow();
    });

    it("SOT stays in lockstep with the hardcoded contract (regression guard)", () => {
      expect(TOOL_TIMEOUT_POLICY.shellDefaultMs / 1000).toBe(120);
      expect("shellMaxMs" in TOOL_TIMEOUT_POLICY).toBe(false);
    });
  });

  // ── env allowlist — secrets must NOT leak to child process ────

  describe("BashTool — env allowlist: secrets must not reach child", () => {
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
});

describe("powershell tool", () => {
  const ctx = (cwd: string = process.cwd()): ToolExecutionContext => ({
    cwd,
    extraAllowedDirectories: [],
    metadata: {},
  });

  function ast(commands: Array<Partial<PowerShellAstSummary["commands"][number]>>, errors: string[] = []): PowerShellAstSummary {
    return {
      errors,
      commands: commands.map((command) => ({
        name: command.name ?? null,
        text: command.text ?? command.name ?? "",
        elements: command.elements ?? (command.name ? [command.name] : []),
      })),
    };
  }

  describe("PowerShellTool — policy surface", () => {
    it("registers as a native shell-category tool", () => {
      const registry = new ToolRegistry();
      registry.register(new PowerShellTool());

      const found = registry.findByName("powershell");
      expect(found).toBeDefined();
      expect(found?.source).toBe("builtin");
      expect(found?.category).toBe("shell");
      expect(found?.isReadOnly({ command: "Get-ChildItem" })).toBe(false);
    });

    it("defaults timeoutSeconds to 120 when omitted — a deadline always exists", () => {
      const parsed = PowerShellToolInputSchema.parse({ command: "Get-ChildItem" });
      expect(parsed.timeoutSeconds).toBe(120);
    });

    it("accepts a timeoutSeconds well above the default (escalated retry)", () => {
      expect(
        PowerShellToolInputSchema.parse({ command: "Get-ChildItem", timeoutSeconds: 600 }).timeoutSeconds,
      ).toBe(600);
    });

    it("rejects every value that would mean 'wait forever' or is not a count of seconds", () => {
      expect(() => PowerShellToolInputSchema.parse({ command: "Get-ChildItem", timeoutSeconds: 0 })).toThrow();
      expect(() => PowerShellToolInputSchema.parse({ command: "Get-ChildItem", timeoutSeconds: -1 })).toThrow();
      expect(() => PowerShellToolInputSchema.parse({ command: "Get-ChildItem", timeoutSeconds: 1.5 })).toThrow();
      expect(() =>
        PowerShellToolInputSchema.parse({ command: "Get-ChildItem", timeoutSeconds: Number.POSITIVE_INFINITY }),
      ).toThrow();
    });

    it("SOT stays in lockstep with the hardcoded contract (regression guard)", () => {
      expect(TOOL_TIMEOUT_POLICY.shellDefaultMs / 1000).toBe(120);
      expect("shellMaxMs" in TOOL_TIMEOUT_POLICY).toBe(false);
    });

    it("blocks expression execution and encoded command forms from the AST summary", () => {
      expect(validatePowerShellAst(ast([{ name: "Invoke-Expression" }]))).toContain("Invoke-Expression");
      expect(validatePowerShellAst(ast([{ name: "iex" }]))).toContain("Invoke-Expression");
      expect(validatePowerShellAst(ast([{ name: "Get-Content", elements: ["Get-Content", "-EncodedCommand", "AAAA"] }]))).toContain("encoded commands");
    });

    it("blocks interactive prompts from the AST summary", () => {
      expect(validatePowerShellAst(ast([{ name: "Read-Host" }]))).toContain("interactive prompts");
      expect(validatePowerShellAst(ast([{ name: "Pause" }]))).toContain("interactive prompts");
    });

    it("blocks dynamic path composition from the AST summary", () => {
      expect(
        validatePowerShellAst(ast([{ name: "Join-Path", elements: ["Join-Path", "$HOME", "\"Desktop/out.txt\""] }])),
      ).toContain("dynamic path composition");
      expect(
        validatePowerShellAst(ast([{ name: "Set-Content", elements: ["Set-Content", "([IO.Path]::Combine($HOME,'.ssh','id_rsa'))", "x"] }])),
      ).toContain("dynamic path argument");
      expect(
        validatePowerShellAst(ast([{ name: "Set-Content", elements: ["Set-Content", "($HOME + '/.ssh/id_rsa')", "x"] }])),
      ).toContain("dynamic path argument");
      expect(validatePowerShellAst(ast([{ name: "Resolve-Path" }]))).toContain("dynamic path resolution");
      expect(
        validatePowerShellAst(ast([{ name: "sc", elements: ["sc", "($HOME + '/.ssh/id_rsa')", "x"] }])),
      ).toContain("dynamic path argument");
      expect(
        validatePowerShellAst(ast([{ name: "ac", elements: ["ac", "('.e' + 'nv')", "x"] }])),
      ).toContain("dynamic path argument");
      expect(
        validatePowerShellAst(ast([{ name: "dir", elements: ["dir", "('.s' + 'sh')"] }])),
      ).toContain("dynamic path argument");
      expect(
        validatePowerShellAst(ast([{ name: "ri", elements: ["ri", "('.e' + 'nv')"] }])),
      ).toContain("dynamic path argument");
    });

    it("blocks recursive forced deletion regardless of flag order", () => {
      expect(validatePowerShellAst(ast([{ name: "Remove-Item", elements: ["Remove-Item", "./x", "-Recurse", "-Force"] }]))).toContain(
        "recursive forced deletion",
      );
      expect(validatePowerShellAst(ast([{ name: "Remove-Item", elements: ["Remove-Item", "./x", "-Force", "-Recurse"] }]))).toContain(
        "recursive forced deletion",
      );
      expect(validatePowerShellAst(ast([{ name: "rm", elements: ["rm", "./x", "-r", "-fo"] }]))).toContain(
        "recursive forced deletion",
      );
      expect(validatePowerShellAst(ast([{ name: "Remove-Item", elements: ["Remove-Item", "./x", "-Recurse:$true", "-Force:$true"] }]))).toContain(
        "recursive forced deletion",
      );
    });

    it("blocks recursive filesystem traversal before shell execution", () => {
      expect(validatePowerShellAst(ast([{ name: "Get-ChildItem", elements: ["Get-ChildItem", "-Recurse", "."] }]))).toContain(
        "recursive shell filesystem traversal",
      );
      expect(validatePowerShellAst(ast([{ name: "dir", elements: ["dir", "-r", "."] }]))).toContain(
        "recursive shell filesystem traversal",
      );
    });

    it("blocks process-detach aliases from the AST summary", () => {
      expect(validatePowerShellAst(ast([{ name: "saps" }]))).toContain("process detachment");
      expect(validatePowerShellAst(ast([{ name: "start" }]))).toContain("process detachment");
    });

    it("fails closed when the parser reports syntax errors or dynamic dispatch", () => {
      expect(validatePowerShellAst(ast([], ["Unexpected token"]))).toContain("parse error");
      expect(validatePowerShellAst(ast([{ name: null, text: "& ($x)" }]))).toContain("dynamic command");
    });

    it("uses the AST parser result before spawn", async () => {
      const parser = async (): Promise<PowerShellAstSummary> => ast([{ name: "Start-Process" }]);
      await expect(validatePowerShellCommand("Start-Process calc", parser)).resolves.toContain(
        "process detachment",
      );
    });

    it("rejects cwd outside the sandbox before spawn", async () => {
      const result = await new PowerShellTool().execute(
        { command: "Get-ChildItem", cwd: "/etc", timeoutSeconds: 5 },
        ctx(),
      );

      expect(result.isError).toBe(true);
      expect(result.output).toContain("Sandbox:");
    });

    it("rejects sensitive cwd even when it is inside the sandbox boundary", async () => {
      const root = mkdtempSync(join(tmpdir(), "lvis-pwsh-sensitive-cwd-"));
      const sensitive = join(root, ".lvis", "secrets");
      mkdirSync(sensitive, { recursive: true });
      try {
        const result = await new PowerShellTool().execute(
          { command: "Get-ChildItem", cwd: sensitive, timeoutSeconds: 5 },
          ctx(root),
        );

        expect(result.isError).toBe(true);
        expect(result.output).toContain("Sensitive path:");
      } finally {
        await cleanupTmpDir(root);
      }
    });

    it("rejects sensitive path operands before PowerShell AST parsing", async () => {
      const root = mkdtempSync(join(tmpdir(), "lvis-pwsh-sensitive-operand-"));
      const target = join(root, ".ssh", "id_rsa");
      mkdirSync(join(root, ".ssh"), { recursive: true });
      writeFileSync(target, "secret", "utf8");
      try {
        const result = await new PowerShellTool().execute(
          { command: `Get-Content ${target}`, timeoutSeconds: 5 },
          ctx(root),
        );

        expect(result.isError).toBe(true);
        expect(result.output).toContain("Sensitive path:");
      } finally {
        await cleanupTmpDir(root);
      }
    });

    it("rejects bare sensitive filename operands before PowerShell AST parsing", async () => {
      const root = mkdtempSync(join(tmpdir(), "lvis-pwsh-bare-sensitive-"));
      writeFileSync(join(root, ".env"), "SECRET=1\n", "utf8");
      try {
        const result = await new PowerShellTool().execute(
          { command: "Get-Content .env", timeoutSeconds: 5 },
          ctx(root),
        );

        expect(result.isError).toBe(true);
        expect(result.output).toContain("Sensitive path:");
      } finally {
        await cleanupTmpDir(root);
      }
    });

    it("rejects variable-expanded sensitive operands before PowerShell AST parsing", async () => {
      const result = await new PowerShellTool().execute(
        { command: "Get-Content $HOME/.ssh/id_rsa", timeoutSeconds: 5 },
        ctx(),
      );

      expect(result.isError).toBe(true);
      expect(result.output).toContain("Sensitive path:");
    });

    it("rejects unsupported ~user operands before PowerShell AST parsing", async () => {
      const result = await new PowerShellTool().execute(
        { command: "Get-Content ~example/Documents/not-in-sandbox.txt", timeoutSeconds: 5 },
        ctx(),
      );

      expect(result.isError).toBe(true);
      expect(result.output).toContain("unsupported user-home expansion");
    });

    it("rejects bare ~user operands before PowerShell AST parsing", async () => {
      const result = await new PowerShellTool().execute(
        { command: "Get-ChildItem ~example", timeoutSeconds: 5 },
        ctx(),
      );

      expect(result.isError).toBe(true);
      expect(result.output).toContain("unsupported user-home expansion");
    });
  });
});

/**
 * pwsh 7 binShell threading.
 *
 * `resolvePowerShellExecutable()` must prefer PowerShell 7 (`pwsh.exe`) on
 * win32 when it is on PATH, falling back to Windows PowerShell 5.1
 * (`powershell.exe`). The sandbox spawn path derives ASRT's `binShell` token
 * from that resolved flavor via `binShellForExecutable`, so the sandboxed inner
 * shell equals the unsandboxed one (no silent 7→5.1 downgrade under the sandbox).
 *
 * These tests exercise the pure resolver + token mapper. The actual ASRT spawn
 * (`wrapToolCommand`) is not invoked — the binShell wiring inside
 * spawnPowerShellWithSandbox simply reads `binShellForExecutable(executable)`.
 */
describe("powershell binShell resolution", () => {
  const ORIGINAL_PLATFORM = process.platform;
  const ORIGINAL_PATH = process.env["PATH"];
  const ORIGINAL_PATHEXT = process.env["PATHEXT"];
  const testDirs = new Set<string>();

  function createTestDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    testDirs.add(dir);
    return dir;
  }

  afterEach(async () => {
    setProcessPlatform(ORIGINAL_PLATFORM);
    if (ORIGINAL_PATH === undefined) delete process.env["PATH"];
    else process.env["PATH"] = ORIGINAL_PATH;
    if (ORIGINAL_PATHEXT === undefined) delete process.env["PATHEXT"];
    else process.env["PATHEXT"] = ORIGINAL_PATHEXT;
    vi.restoreAllMocks();
    for (const dir of testDirs) {
      await cleanupTmpDir(dir);
    }
    testDirs.clear();
  });

  describe("binShellForExecutable", () => {
    it("maps pwsh.exe / pwsh → 'pwsh'", () => {
      expect(binShellForExecutable("pwsh.exe")).toBe("pwsh");
      expect(binShellForExecutable("pwsh")).toBe("pwsh");
      expect(binShellForExecutable("PWSH.EXE")).toBe("pwsh");
    });

    it("maps powershell.exe / powershell → 'powershell'", () => {
      expect(binShellForExecutable("powershell.exe")).toBe("powershell");
      expect(binShellForExecutable("powershell")).toBe("powershell");
      expect(binShellForExecutable("POWERSHELL.EXE")).toBe("powershell");
    });
  });

  describe("resolvePowerShellExecutable off-win32", () => {
    it("returns pwsh on darwin/linux regardless of PATH", () => {
      setProcessPlatform("darwin");
      process.env["PATH"] = "/usr/bin";
      expect(resolvePowerShellExecutable()).toBe("pwsh");
      setProcessPlatform("linux");
      expect(resolvePowerShellExecutable()).toBe("pwsh");
    });
  });

  describe("resolvePowerShellExecutable on win32", () => {
    it("prefers pwsh.exe when it is on PATH (sandboxed flavor == unsandboxed)", () => {
      setProcessPlatform("win32");
      const dir = createTestDir("lvis-pwsh-");
      const pwshPath = join(dir, "pwsh.exe");
      writeFileSync(pwshPath, "");
      chmodSync(pwshPath, 0o755);
      process.env["PATH"] = dir;
      process.env["PATHEXT"] = ".COM;.EXE;.BAT;.CMD";

      const resolved = resolvePowerShellExecutable();
      expect(resolved).toBe("pwsh.exe");
      // The sandbox path would hand ASRT 'pwsh', matching the resolved binary.
      expect(binShellForExecutable(resolved)).toBe("pwsh");
    });

    it("falls back to powershell.exe when pwsh.exe is absent from PATH", () => {
      setProcessPlatform("win32");
      // A directory with no pwsh.exe in it.
      const dir = createTestDir("lvis-nopwsh-");
      process.env["PATH"] = dir;
      process.env["PATHEXT"] = ".COM;.EXE;.BAT;.CMD";

      const resolved = resolvePowerShellExecutable();
      expect(resolved).toBe("powershell.exe");
      expect(binShellForExecutable(resolved)).toBe("powershell");
    });

    it("finds pwsh via a bare PATHEXT suffix entry (pwsh + .EXE)", () => {
      setProcessPlatform("win32");
      const dir = createTestDir("lvis-pwshext-");
      // Only the suffix-appended form exists; the bare 'pwsh.exe' literal probe
      // and the PATHEXT loop both look at the same path here, but assert the
      // suffix branch resolves when PATH lists a directory containing pwsh.exe.
      writeFileSync(join(dir, "pwsh.exe"), "");
      process.env["PATH"] = ["/nonexistent", dir].join(delimiter);
      process.env["PATHEXT"] = ".EXE";

      expect(resolvePowerShellExecutable()).toBe("pwsh.exe");
    });

    it("returns powershell.exe when PATH is empty", () => {
      setProcessPlatform("win32");
      process.env["PATH"] = "";
      expect(resolvePowerShellExecutable()).toBe("powershell.exe");
    });
  });
});

describe("background shells", () => {
  /** Minimal ChildProcess stand-in: stdout/stderr emitters + kill + exit/close/error. */
  function fakeChild(): {
    child: import("node:child_process").ChildProcess;
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
    emitClose: (code: number | null) => void;
    emitError: (message: string) => void;
  } {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const emitter = new EventEmitter() as unknown as import("node:child_process").ChildProcess;
    const kill = vi.fn(() => true);
    Object.assign(emitter, { stdout, stderr, kill, exitCode: null, pid: 1234 });
    return {
      child: emitter,
      stdout,
      stderr,
      kill,
      emitClose: (code) => emitter.emit("close", code),
      emitError: (message) => emitter.emit("error", new Error(message)),
    };
  }

  const ctx = (sessionId: string) => ({ metadata: { sessionId } }) as never;

  beforeEach(() => {
    backgroundShellManager._resetForTest();
    __resetManagedChildProcessesForTest();
  });

  describe("backgroundShellManager", () => {
    it("registers a shell and reads its incremental output", () => {
      const f = fakeChild();
      const id = backgroundShellManager.register({
        sessionId: "s1",
        command: "npm run dev",
        child: f.child,
        startedAt: "t0",
      });
      expect(id).toMatch(/[0-9a-f-]{36}/);
      expect(backgroundShellManager._size()).toBe(1);

      f.stdout.emit("data", Buffer.from("hello "));
      f.stderr.emit("data", Buffer.from("warn"));
      const first = backgroundShellManager.read("s1", id);
      expect(first?.output).toBe("hello warn");
      expect(first?.status).toBe("running");

      // Second read returns only what arrived since the first.
      f.stdout.emit("data", Buffer.from("!"));
      const second = backgroundShellManager.read("s1", id);
      expect(second?.output).toBe("!");
    });

    it("transitions to exited with the exit code on close", () => {
      const f = fakeChild();
      const id = backgroundShellManager.register({ sessionId: "s1", command: "x", child: f.child, startedAt: "t" });
      f.emitClose(0);
      const r = backgroundShellManager.read("s1", id);
      expect(r?.status).toBe("exited");
      expect(r?.exitCode).toBe(0);
    });

    it("transitions to failed on spawn error and captures the message", () => {
      const f = fakeChild();
      const id = backgroundShellManager.register({ sessionId: "s1", command: "x", child: f.child, startedAt: "t" });
      f.emitError("ENOENT");
      const r = backgroundShellManager.read("s1", id);
      expect(r?.status).toBe("failed");
      expect(r?.output).toContain("ENOENT");
    });

    it("kill sends SIGTERM and marks the shell killed", () => {
      const f = fakeChild();
      const id = backgroundShellManager.register({ sessionId: "s1", command: "x", child: f.child, startedAt: "t" });
      const r = backgroundShellManager.kill("s1", id);
      expect(f.kill).toHaveBeenCalledWith("SIGTERM");
      expect(r?.status).toBe("killed");
    });

    it("scopes read/kill to the owning session", () => {
      const f = fakeChild();
      const id = backgroundShellManager.register({ sessionId: "s1", command: "x", child: f.child, startedAt: "t" });
      expect(backgroundShellManager.read("s2", id)).toBeUndefined();
      expect(backgroundShellManager.kill("s2", id)).toBeUndefined();
      expect(f.kill).not.toHaveBeenCalled();
      // Owner still sees it.
      expect(backgroundShellManager.read("s1", id)).toBeDefined();
    });

    it("caps total output and latches truncated", () => {
      const f = fakeChild();
      const id = backgroundShellManager.register({ sessionId: "s1", command: "x", child: f.child, startedAt: "t" });
      f.stdout.emit("data", Buffer.from("a".repeat(MAX_OUTPUT_CHARS + 500)));
      const r = backgroundShellManager.read("s1", id);
      expect(r?.truncated).toBe(true);
      expect(r?.output.length).toBe(MAX_OUTPUT_CHARS);
      // Further output is dropped.
      f.stdout.emit("data", Buffer.from("more"));
      expect(backgroundShellManager.read("s1", id)?.output).toBe("");
    });

    it("disposeSession kills running shells of that session only", () => {
      const a = fakeChild();
      const b = fakeChild();
      backgroundShellManager.register({ sessionId: "s1", command: "a", child: a.child, startedAt: "t" });
      backgroundShellManager.register({ sessionId: "s2", command: "b", child: b.child, startedAt: "t" });
      const disposed = backgroundShellManager.disposeSession("s1");
      expect(disposed).toBe(1);
      expect(a.kill).toHaveBeenCalledWith("SIGKILL");
      expect(b.kill).not.toHaveBeenCalled();
      expect(backgroundShellManager._size()).toBe(1);
    });

    it("evicts a session's fully-read finished shell when a new one is registered", () => {
      const a = fakeChild();
      const idA = backgroundShellManager.register({ sessionId: "s1", command: "a", child: a.child, startedAt: "t" });
      a.stdout.emit("data", Buffer.from("done"));
      a.emitClose(0);
      expect(backgroundShellManager.read("s1", idA)?.output).toBe("done"); // fully consumed
      const b = fakeChild();
      backgroundShellManager.register({ sessionId: "s1", command: "b", child: b.child, startedAt: "t" });
      expect(backgroundShellManager.read("s1", idA)).toBeUndefined(); // reaped
      expect(backgroundShellManager._size()).toBe(1);
    });

    it("preserves a finished shell whose output was never read", () => {
      const a = fakeChild();
      const idA = backgroundShellManager.register({ sessionId: "s1", command: "a", child: a.child, startedAt: "t" });
      a.stdout.emit("data", Buffer.from("unread"));
      a.emitClose(0);
      const b = fakeChild();
      backgroundShellManager.register({ sessionId: "s1", command: "b", child: b.child, startedAt: "t" });
      expect(backgroundShellManager.read("s1", idA)?.output).toBe("unread"); // still fetchable
    });
  });

  describe("bash_output / bash_kill tools", () => {
    it("bash_output returns the shell's output for the owning session", async () => {
      const f = fakeChild();
      const id = backgroundShellManager.register({ sessionId: "s1", command: "tail -f log", child: f.child, startedAt: "t" });
      f.stdout.emit("data", Buffer.from("line1\n"));
      const tool = createBashOutputTool();
      const res = await tool.execute({ shellId: id }, ctx("s1"));
      expect(res.isError).toBe(false);
      const parsed = JSON.parse(res.output);
      expect(parsed).toMatchObject({ shellId: id, status: "running" });
      expect(parsed.output).toBe("line1\n");
    });

    it("bash_output rejects a shell from another session (not found)", async () => {
      const f = fakeChild();
      const id = backgroundShellManager.register({ sessionId: "s1", command: "x", child: f.child, startedAt: "t" });
      const tool = createBashOutputTool();
      const res = await tool.execute({ shellId: id }, ctx("other"));
      expect(res.isError).toBe(true);
      expect(res.output).toContain("no background shell");
    });

    it("bash_output requires a shellId", async () => {
      const tool = createBashOutputTool();
      const res = await tool.execute({}, ctx("s1"));
      expect(res.isError).toBe(true);
    });

    it("bash_kill terminates the owning session's shell", async () => {
      const f = fakeChild();
      const id = backgroundShellManager.register({ sessionId: "s1", command: "x", child: f.child, startedAt: "t" });
      const tool = createBashKillTool();
      const res = await tool.execute({ shellId: id }, ctx("s1"));
      expect(res.isError).toBe(false);
      expect(f.kill).toHaveBeenCalledWith("SIGTERM");
      expect(JSON.parse(res.output).status).toBe("killed");
    });

    it("bash_kill will not kill another session's shell", async () => {
      const f = fakeChild();
      const id = backgroundShellManager.register({ sessionId: "s1", command: "x", child: f.child, startedAt: "t" });
      const tool = createBashKillTool();
      const res = await tool.execute({ shellId: id }, ctx("attacker"));
      expect(res.isError).toBe(true);
      expect(f.kill).not.toHaveBeenCalled();
    });
  });
});
