/**
 * Native PowerShell tool.
 *
 * This is a distinct shell surface, not a bash alias. The executable is
 * deterministic per platform: Windows uses `powershell.exe`; other platforms
 * use `pwsh`. Missing executables are reported as tool errors.
 */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { isAbsolute, resolve as pathResolve } from "node:path";
import type { Readable } from "node:stream";
import { z } from "zod";

import { validateSandboxPath } from "../sandbox/path-validator.js";
import {
  ZodTool,
  type ToolCategory,
  type ToolExecutionContext,
  type ToolResult,
} from "./base.js";
import { buildSafeChildEnv } from "./safe-env.js";

type PipedChild = ChildProcessByStdio<null, Readable, Readable>;

export const PowerShellToolInputSchema = z.object({
  command: z.string().min(1).describe("PowerShell command to execute"),
  cwd: z.string().optional().describe("Working directory override"),
  timeoutSeconds: z.number().int().min(1).max(600).default(600),
});

const OUTPUT_CAP = 12_000;
const TRUNCATION_MARKER = "\n...[truncated]...";

const BLOCKED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\b(Invoke-Expression|iex)\b/i, reason: "Invoke-Expression is not allowed" },
  { pattern: /(^|\s)-(EncodedCommand|enc)\b/i, reason: "encoded commands are not allowed" },
  { pattern: /\bSet-ExecutionPolicy\b/i, reason: "execution policy changes are not allowed" },
  { pattern: /\bStart-Process\b/i, reason: "process detachment is not allowed" },
  { pattern: /\b(Read-Host|Pause)\b/i, reason: "interactive prompts are not allowed" },
  {
    pattern: /\bRemove-Item\b(?=[\s\S]*(^|\s)-(Recurse|r)\b)(?=[\s\S]*(^|\s)-(Force|fo)\b)/i,
    reason: "recursive forced deletion is not allowed",
  },
];

export class PowerShellTool extends ZodTool<typeof PowerShellToolInputSchema> {
  readonly name = "powershell";
  readonly description = "Run a non-interactive PowerShell command in the local repository.";
  readonly inputSchema = PowerShellToolInputSchema;
  override readonly category: ToolCategory = "shell";

  override isReadOnly(): boolean {
    return false;
  }

  protected async executeTyped(
    input: z.infer<typeof PowerShellToolInputSchema>,
    ctx: ToolExecutionContext,
  ): Promise<ToolResult> {
    const preflightError = validatePowerShellCommand(input.command);
    if (preflightError) {
      return { output: preflightError, isError: true, metadata: { preflightDenied: true } };
    }

    const resolvedCwd = input.cwd
      ? isAbsolute(input.cwd)
        ? pathResolve(input.cwd)
        : pathResolve(ctx.cwd, input.cwd)
      : ctx.cwd;
    if (input.cwd) {
      const check = validateSandboxPath(resolvedCwd, ctx.cwd);
      if (!check.allowed) {
        return { output: `Sandbox: ${check.reason}`, isError: true };
      }
    }

    return spawnPowerShell(input.command, resolvedCwd, input.timeoutSeconds);
  }
}

export function validatePowerShellCommand(command: string): string | null {
  for (const blocked of BLOCKED_PATTERNS) {
    if (blocked.pattern.test(command)) {
      return `PowerShell command blocked: ${blocked.reason}`;
    }
  }
  return null;
}

function resolvePowerShellExecutable(): string {
  return process.platform === "win32" ? "powershell.exe" : "pwsh";
}

async function spawnPowerShell(
  command: string,
  cwd: string,
  timeoutSeconds: number,
): Promise<ToolResult> {
  return new Promise((resolve) => {
    const executable = resolvePowerShellExecutable();
    const child: PipedChild = spawn(
      executable,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
      {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: buildSafeChildEnv(),
      },
    );

    const chunks: Buffer[] = [];
    const collect = (chunk: Buffer): void => {
      chunks.push(chunk);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcess(child);
    }, timeoutSeconds * 1000);

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const output = formatOutput(Buffer.concat(chunks).toString("utf-8"));
      resolve({
        output: timedOut
          ? `PowerShell command timed out after ${timeoutSeconds} seconds.\n${output}`
          : output,
        isError: timedOut || code !== 0,
        metadata: { returncode: code, timedOut },
      });
    };

    child.on("close", (code) => finish(code));
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        output: err && "code" in err && err.code === "ENOENT"
          ? `PowerShell executable not found: ${executable}`
          : `PowerShell spawn failed: ${err.message}`,
        isError: true,
        metadata: {},
      });
    });
  });
}

function terminateProcess(child: PipedChild): void {
  child.kill("SIGTERM");
  setTimeout(() => {
    if (child.exitCode === null && !child.killed) {
      child.kill("SIGKILL");
    }
  }, 2000);
}

function formatOutput(raw: string): string {
  const text = raw.replace(/\r\n/g, "\n").trim();
  if (text.length === 0) return "(no output)";
  if (text.length > OUTPUT_CAP) return text.slice(0, OUTPUT_CAP) + TRUNCATION_MARKER;
  return text;
}
