/**
 * Native PowerShell tool.
 *
 * This is a distinct shell surface, not a bash alias. The executable is
 * deterministic per platform: Windows uses `powershell.exe`; other platforms
 * use `pwsh`. Missing executables are reported as tool errors.
 */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createHash } from "node:crypto";
import { isAbsolute, resolve as pathResolve } from "node:path";
import type { Readable } from "node:stream";
import { z } from "zod";

import {
  ZodTool,
  type ToolCategory,
  type ToolExecutionContext,
  type ToolResult,
} from "./base.js";
import { buildSafeChildEnv } from "./safe-env.js";
import {
  validateShellCommandPathPolicy,
  validateShellWorkingDirectory,
} from "./shell-path-policy.js";

type PipedChild = ChildProcessByStdio<null, Readable, Readable>;
type PowerShellParser = (command: string) => Promise<PowerShellAstSummary>;

export const PowerShellToolInputSchema = z.object({
  command: z.string().min(1).describe("PowerShell command to execute"),
  cwd: z.string().optional().describe("Working directory override"),
  timeoutSeconds: z.number().int().min(1).max(600).default(600),
});

const OUTPUT_CAP = 12_000;
const TRUNCATION_MARKER = "\n...[truncated]...";

const BLOCKED_COMMANDS = new Map<string, string>([
  ["invoke-expression", "Invoke-Expression is not allowed"],
  ["iex", "Invoke-Expression is not allowed"],
  ["set-executionpolicy", "execution policy changes are not allowed"],
  ["start-process", "process detachment is not allowed"],
  ["saps", "process detachment is not allowed"],
  ["start", "process detachment is not allowed"],
  ["read-host", "interactive prompts are not allowed"],
  ["pause", "interactive prompts are not allowed"],
  ["set-alias", "alias mutation is not allowed"],
  ["new-alias", "alias mutation is not allowed"],
]);

const ENCODED_COMMAND_FLAGS = new Set(["-encodedcommand", "-enc"]);
const REMOVE_ITEM_COMMANDS = new Set(["remove-item", "rm", "del", "erase", "rd", "rmdir", "ri"]);
const RECURSE_FLAGS = new Set(["-recurse", "-r", "-rec"]);
const FORCE_FLAGS = new Set(["-force", "-fo"]);

export interface PowerShellAstCommand {
  name: string | null;
  elements: string[];
  text: string;
}

export interface PowerShellAstSummary {
  errors: string[];
  commands: PowerShellAstCommand[];
}

export class PowerShellTool extends ZodTool<typeof PowerShellToolInputSchema> {
  readonly name = "powershell";
  readonly description = "Run a non-interactive PowerShell command in the local repository.";
  readonly inputSchema = PowerShellToolInputSchema;
  override readonly category: ToolCategory = "shell";

  override isReadOnly(): boolean {
    return false;
  }

  approvalCacheKey(input: unknown): string {
    const parsed = PowerShellToolInputSchema.parse(input);
    return createHash("sha256")
      .update(JSON.stringify({ command: parsed.command, cwd: parsed.cwd ?? null }))
      .digest("hex");
  }

  protected async executeTyped(
    input: z.infer<typeof PowerShellToolInputSchema>,
    ctx: ToolExecutionContext,
  ): Promise<ToolResult> {
    const resolvedCwd = input.cwd
      ? isAbsolute(input.cwd)
        ? pathResolve(input.cwd)
        : pathResolve(ctx.cwd, input.cwd)
      : ctx.cwd;
    const cwdViolation = validateShellWorkingDirectory(resolvedCwd, ctx.cwd, ctx.allowedDirectories);
    if (cwdViolation) {
      return { output: cwdViolation, isError: true };
    }
    const commandPathViolation = validateShellCommandPathPolicy(
      input.command,
      resolvedCwd,
      ctx.cwd,
      ctx.allowedDirectories,
    );
    if (commandPathViolation) {
      return { output: commandPathViolation, isError: true };
    }

    const preflightError = await validatePowerShellCommand(input.command);
    if (preflightError) {
      return { output: preflightError, isError: true, metadata: { preflightDenied: true } };
    }

    return spawnPowerShell(input.command, resolvedCwd, input.timeoutSeconds);
  }
}

export async function validatePowerShellCommand(
  command: string,
  parser: PowerShellParser = parsePowerShellAst,
): Promise<string | null> {
  const ast = await parser(command);
  const astError = validatePowerShellAst(ast);
  return astError ? `PowerShell command blocked: ${astError}` : null;
}

export function validatePowerShellAst(ast: PowerShellAstSummary): string | null {
  if (ast.errors.length > 0) {
    return `parse error: ${ast.errors[0]}`;
  }
  for (const command of ast.commands) {
    const name = command.name?.trim().toLowerCase() ?? "";
    if (!name) {
      return "dynamic command invocation is not allowed";
    }
    const blocked = BLOCKED_COMMANDS.get(name);
    if (blocked) return blocked;

    const elements = command.elements.map((element) => element.trim().toLowerCase());
    if (elements.some((element) => ENCODED_COMMAND_FLAGS.has(element))) {
      return "encoded commands are not allowed";
    }
    if (REMOVE_ITEM_COMMANDS.has(name) && hasRecursiveForcedDeletion(elements)) {
      return "recursive forced deletion is not allowed";
    }
  }
  return null;
}

function hasRecursiveForcedDeletion(elements: string[]): boolean {
  return (
    elements.some((element) => isSwitchEnabled(element, RECURSE_FLAGS)) &&
    elements.some((element) => isSwitchEnabled(element, FORCE_FLAGS))
  );
}

function isSwitchEnabled(element: string, switches: ReadonlySet<string>): boolean {
  const [name, value] = element.split(":", 2);
  if (!switches.has(name)) return false;
  return value === undefined || value === "" || value === "true" || value === "$true";
}

function resolvePowerShellExecutable(): string {
  return process.platform === "win32" ? "powershell.exe" : "pwsh";
}

async function parsePowerShellAst(command: string): Promise<PowerShellAstSummary> {
  return new Promise<PowerShellAstSummary>((resolve, reject) => {
    const executable = resolvePowerShellExecutable();
    const parser = spawn(
      executable,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", POWER_SHELL_AST_PARSER],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: buildSafeChildEnv(),
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    parser.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    parser.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    parser.on("error", (err) => {
      const message = err && "code" in err && err.code === "ENOENT"
        ? `PowerShell executable not found: ${executable}`
        : `PowerShell parser failed: ${err.message}`;
      reject(new Error(message));
    });
    parser.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`PowerShell parser exited with ${code}: ${Buffer.concat(stderr).toString("utf-8").trim()}`));
        return;
      }
      try {
        resolve(normalizePowerShellAstSummary(JSON.parse(Buffer.concat(stdout).toString("utf-8"))));
      } catch (err) {
        reject(new Error(`PowerShell parser returned invalid JSON: ${(err as Error).message}`));
      }
    });
    parser.stdin.end(command);
  }).catch((err) => ({
    errors: [(err as Error).message],
    commands: [],
  }));
}

function normalizePowerShellAstSummary(raw: unknown): PowerShellAstSummary {
  const obj = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const errors = Array.isArray(obj.errors)
    ? obj.errors.filter((item): item is string => typeof item === "string")
    : [];
  const commands = Array.isArray(obj.commands)
    ? obj.commands.map((item) => {
      const command = item && typeof item === "object" ? item as Record<string, unknown> : {};
      return {
        name: typeof command.name === "string" ? command.name : null,
        text: typeof command.text === "string" ? command.text : "",
        elements: Array.isArray(command.elements)
          ? command.elements.filter((element): element is string => typeof element === "string")
          : [],
      };
    })
    : [];
  return { errors, commands };
}

const POWER_SHELL_AST_PARSER = `
$ErrorActionPreference = 'Stop'
$cmd = [Console]::In.ReadToEnd()
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($cmd, [ref]$tokens, [ref]$errors)
$commands = @(
  $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.CommandAst] }, $true) |
    ForEach-Object {
      [ordered]@{
        name = $_.GetCommandName()
        text = $_.Extent.Text
        elements = @($_.CommandElements | ForEach-Object { $_.Extent.Text })
      }
    }
)
[ordered]@{
  errors = @($errors | ForEach-Object { $_.Message })
  commands = $commands
} | ConvertTo-Json -Depth 8 -Compress
`;

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
