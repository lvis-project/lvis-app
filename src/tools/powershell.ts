/**
 * Native PowerShell tool.
 *
 * This is a distinct shell surface, not a bash alias. The executable is
 * deterministic per platform: Windows uses `powershell.exe`; other platforms
 * use `pwsh`. Missing executables are reported as tool errors.
 */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve as pathResolve } from "node:path";
import type { Readable } from "node:stream";
import { z } from "zod";

import {
  ZodTool,
  type ToolCategory,
  type ToolExecutionContext,
  type ToolResult,
} from "./base.js";
import { buildSafeChildEnv, buildSandboxedChildEnv } from "./safe-env.js";
import {
  validateShellCommandPathPolicy,
  validateShellWorkingDirectory,
} from "./shell-path-policy.js";
import {
  isAsrtSandboxActive,
  wrapToolCommand,
  cleanupAsrtSandboxAfterCommand,
  getDefaultSensitiveReadDenyPaths,
  getDefaultSensitiveWriteDenyPaths,
} from "../permissions/asrt-sandbox.js";
import { isActiveSandboxShellContained } from "../permissions/sandbox-capability.js";
import { deriveSandboxWritePaths } from "../permissions/sandbox-write-jail.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import { trackManagedChildProcess } from "../main/managed-child-processes.js";

type PipedChild = ChildProcessByStdio<null, Readable, Readable>;
type PowerShellParser = (command: string) => Promise<PowerShellAstSummary>;

export const PowerShellToolInputSchema = z.object({
  command: z.string().min(1).describe("PowerShell command to execute"),
  cwd: z.string().optional().describe("Working directory override"),
  timeoutSeconds: z
    .number()
    .int()
    .min(1)
    .max(TOOL_TIMEOUT_POLICY.shellMaxMs / 1000)
    .default(TOOL_TIMEOUT_POLICY.shellDefaultMs / 1000),
});

const OUTPUT_CAP = 12_000;
const TRUNCATION_MARKER = "\n...[truncated]...";

const POWERSHELL_ALIASES = new Map<string, string>([
  ["ac", "add-content"],
  ["cat", "get-content"],
  ["clc", "clear-content"],
  ["copy", "copy-item"],
  ["cp", "copy-item"],
  ["cpi", "copy-item"],
  ["del", "remove-item"],
  ["dir", "get-childitem"],
  ["erase", "remove-item"],
  ["gc", "get-content"],
  ["gci", "get-childitem"],
  ["gi", "get-item"],
  ["iex", "invoke-expression"],
  ["ls", "get-childitem"],
  ["mkdir", "new-item"],
  ["md", "new-item"],
  ["mi", "move-item"],
  ["move", "move-item"],
  ["mv", "move-item"],
  ["ni", "new-item"],
  ["rd", "remove-item"],
  ["ren", "rename-item"],
  ["ri", "remove-item"],
  ["rm", "remove-item"],
  ["rmdir", "remove-item"],
  ["rni", "rename-item"],
  ["saps", "start-process"],
  ["sc", "set-content"],
  ["si", "set-item"],
  ["sp", "set-itemproperty"],
  ["start", "start-process"],
  ["type", "get-content"],
]);

const BLOCKED_COMMANDS = new Map<string, string>([
  ["invoke-expression", "Invoke-Expression is not allowed"],
  ["set-executionpolicy", "execution policy changes are not allowed"],
  ["start-process", "process detachment is not allowed"],
  ["read-host", "interactive prompts are not allowed"],
  ["pause", "interactive prompts are not allowed"],
  ["set-alias", "alias mutation is not allowed"],
  ["new-alias", "alias mutation is not allowed"],
  ["join-path", "dynamic path composition is not allowed"],
  ["resolve-path", "dynamic path resolution is not allowed"],
  ["convert-path", "dynamic path resolution is not allowed"],
  ["new-psdrive", "dynamic filesystem drive mapping is not allowed"],
  ["start-job", "background jobs are not allowed"],
  ["start-threadjob", "background jobs are not allowed"],
  ["invoke-command", "remote command invocation is not allowed"],
  ["get-wmiobject", "WMI command invocation is not allowed"],
  ["invoke-wmimethod", "WMI command invocation is not allowed"],
  ["invoke-cimmethod", "CIM command invocation is not allowed"],
  ["powershell", "nested PowerShell shells are not allowed"],
  ["powershell.exe", "nested PowerShell shells are not allowed"],
  ["pwsh", "nested PowerShell shells are not allowed"],
]);

const ENCODED_COMMAND_FLAGS = new Set(["-encodedcommand", "-enc"]);
const REMOVE_ITEM_COMMANDS = new Set(["remove-item"]);
const FILESYSTEM_COMMANDS = new Set([
  "add-content",
  "clear-content",
  "copy-item",
  "get-childitem",
  "get-content",
  "get-item",
  "move-item",
  "new-item",
  "out-file",
  "remove-item",
  "rename-item",
  "set-content",
  "set-item",
  "set-itemproperty",
  "test-path",
]);
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
    const cwdViolation = validateShellWorkingDirectory(resolvedCwd, ctx.cwd, ctx.extraAllowedDirectories);
    if (cwdViolation) {
      return { output: cwdViolation, isError: true };
    }
    const commandPathViolation = validateShellCommandPathPolicy(
      input.command,
      resolvedCwd,
      ctx.cwd,
      ctx.extraAllowedDirectories,
    );
    if (commandPathViolation) {
      return { output: commandPathViolation, isError: true };
    }

    const preflightError = await validatePowerShellCommand(input.command);
    if (preflightError) {
      return { output: preflightError, isError: true, metadata: { preflightDenied: true } };
    }

    // §691: ASRT (Anthropic sandbox-runtime) adoption for the PowerShell spawn
    // path — parity with bash.ts. The sandbox is gated once at boot
    // (`initializeAsrtSandbox`); `isAsrtSandboxActive()` reflects that decision
    // with no runtime re-evaluation. On Windows this becomes true after the
    // one-time srt-win setup is ready; before then boot degrades and pwsh falls
    // through to the plain spawn.
    //
    // When the gate is OFF (the DEFAULT), this is skipped and pwsh runs via the
    // unchanged `spawnPowerShell` path.
    if (isAsrtSandboxActive()) {
      if (!isActiveSandboxShellContained()) {
        return {
          output:
            "PowerShell spawn failed: ASRT shell tools require filesystem and process isolation; " +
            "the active sandbox is only partially confined.",
          isError: true,
          metadata: { sandboxed: true },
        };
      }
      // Namespace-scoped write-jail (owner plugin sandbox root ∪ allowed
      // directories), not the bare cwd. cwd stays readable.
      const writePaths = deriveSandboxWritePaths({
        ...(ctx.ownerPluginSandboxRoot !== undefined
          ? { ownerPluginSandboxRoot: ctx.ownerPluginSandboxRoot }
          : {}),
        allowedDirectories: [resolvedCwd, ...ctx.extraAllowedDirectories],
      });
      return await spawnPowerShellWithSandbox(
        input.command,
        resolvedCwd,
        writePaths,
        input.timeoutSeconds,
      );
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
    const rawName = command.name?.trim().toLowerCase() ?? "";
    const name = canonicalPowerShellCommandName(rawName);
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
    if (FILESYSTEM_COMMANDS.has(name)) {
      if (elements.some((element) => isSwitchEnabled(element, RECURSE_FLAGS))) {
        return "recursive shell filesystem traversal is not allowed";
      }
      const dynamic = elements.slice(1).find(isDynamicPowerShellPathArgument);
      if (dynamic) {
        return `dynamic path argument is not allowed: ${dynamic}`;
      }
    }
  }
  return null;
}

function canonicalPowerShellCommandName(name: string): string {
  return POWERSHELL_ALIASES.get(name) ?? name;
}

function isDynamicPowerShellPathArgument(element: string): boolean {
  if (element.length === 0 || element.startsWith("-")) return false;
  return (
    element.includes("$") ||
    element.includes("[") ||
    element.includes("]") ||
    element.includes("(") ||
    element.includes(")") ||
    element.includes("+")
  );
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

/**
 * Resolve the PowerShell executable for the host.
 *
 * Off-Windows: `pwsh` (PowerShell 7 — the only flavor that exists there).
 *
 * Windows: prefer `pwsh.exe` (PowerShell 7) when it is on PATH, falling back to
 * `powershell.exe` (Windows PowerShell 5.1, always present). PR2 finding c: the
 * UNSANDBOXED spawn path already runs whatever this resolves, so the SANDBOXED
 * path must pass a matching `binShell` ('pwsh' vs 'powershell') to ASRT —
 * otherwise an enabled sandbox would silently downgrade a pwsh-7 host to
 * Windows PowerShell 5.1 (different language/cmdlet surface). `binShellForExecutable`
 * derives the ASRT binShell token from this result so the two stay in lockstep.
 */
export function resolvePowerShellExecutable(): string {
  if (process.platform !== "win32") return "pwsh";
  return win32PwshOnPath() ? "pwsh.exe" : "powershell.exe";
}

/**
 * Synchronous PATH probe for `pwsh.exe` on Windows. Walks `PATH` entries and
 * appends each `PATHEXT` suffix (defaulting to the standard set) so a bare
 * `pwsh` directory entry is matched. Pure existence check — no spawn — so it is
 * cheap and side-effect-free.
 */
function win32PwshOnPath(): boolean {
  const pathEnv = process.env["PATH"] ?? process.env["Path"] ?? "";
  if (pathEnv === "") return false;
  const exts = (process.env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((e) => e.trim())
    .filter((e) => e !== "");
  for (const dir of pathEnv.split(delimiter)) {
    if (dir === "") continue;
    if (existsSync(join(dir, "pwsh.exe"))) return true;
    for (const ext of exts) {
      if (existsSync(join(dir, `pwsh${ext}`))) return true;
    }
  }
  return false;
}

/**
 * Map a resolved PowerShell executable to the ASRT cross-platform `binShell`
 * token. `parseWindowsBinShell` accepts both 'pwsh'/'pwsh.exe' and
 * 'powershell'/'powershell.exe'; we hand it the bare token so the inner shell
 * ASRT renders matches the flavor the unsandboxed path would have run.
 */
export function binShellForExecutable(executable: string): "pwsh" | "powershell" {
  return executable.toLowerCase().startsWith("pwsh") ? "pwsh" : "powershell";
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
    trackManagedChildProcess(parser, { label: "tool:powershell-parser" });
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

/**
 * POSIX single-quote escape one argument so it survives the `<shell> -c <wrap>`
 * layer that ASRT's `wrapWithSandboxArgv` returns on macOS/Linux. Wrap in single
 * quotes and replace each embedded `'` with `'\''`. Self-contained (no
 * shell-quote dependency, which is only transitively present).
 */
function posixSingleQuote(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Execute a PowerShell command under the ASRT sandbox — parity with bash.ts's
 * {@link spawnWithSandbox}.
 *
 * BINSHELL THREADING (fixes a Windows double-shell bug):
 *   ASRT renders the inner shell ITSELF from the `binShell` argument
 *   (`wrapWithSandboxArgv(command, binShell, …)` → on Windows
 *   `parseWindowsBinShell('powershell')` → `powershell.exe -NoProfile -Command
 *   <command>`). So on win32 we hand ASRT the BARE command and pass
 *   `binShell='powershell'` ('pwsh' off-Windows). Pre-rendering `powershell.exe
 *   -Command '<command>'` AND leaving binShell undefined (the prior code)
 *   defaulted ASRT to `cmd` and produced `cmd /c "powershell.exe -Command …"` —
 *   a DOUBLE shell. ASRT's `parseWindowsBinShell` accepts 'powershell'/'pwsh'.
 *
 *   On mac/linux ASRT wraps a SHELL COMMAND STRING (argv `[<shell>, -c,
 *   <wrapped>]`). pwsh is invoked there only as a `-Command` payload of the
 *   POSIX shell, so we still render the pwsh invocation as a single POSIX-quoted
 *   command line for that path (preserving the established mac/linux behaviour).
 *
 * Filesystem jail mirrors bash.ts: `allowWrite` = the derived write-jail, and
 * the read-jail HOME-leak fix denies `$HOME` then re-allows cwd + write paths.
 * Windows ASRT is not shell-contained and ASRT 0.0.64 cannot accept the
 * per-exec allowRead/allowWrite grants this path needs, so executeTyped refuses
 * before this function on win32; the win32 binShell branch remains defensive
 * for future ASRT capability changes.
 *
 * @internal — called only when the ASRT sandbox is active (user opt-in).
 */
async function spawnPowerShellWithSandbox(
  command: string,
  cwd: string,
  writePaths: readonly string[],
  timeoutSeconds: number,
): Promise<ToolResult> {
  const executable = resolvePowerShellExecutable();
  const isWindows = process.platform === "win32";
  // Windows: hand ASRT the BARE command + binShell='powershell' so ASRT renders
  // `powershell.exe -NoProfile -Command <command>` itself (no pre-render → no
  // double shell). mac/linux: render the pwsh invocation into the command
  // string ASRT runs under its POSIX `-c` shell, as before.
  const sandboxCommand = isWindows
    ? command
    : [
        executable,
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        posixSingleQuote(command),
      ].join(" ");
  // ASRT's cross-platform binShell string. On win32 it MUST match the flavor
  // `resolvePowerShellExecutable()` chose ('pwsh' when PowerShell 7 is on PATH,
  // else 'powershell' for Windows PowerShell 5.1) so the sandboxed inner shell
  // equals the unsandboxed one — both tokens are accepted by ASRT's
  // parseWindowsBinShell. Off-Windows binShell is only meaningful as the inner
  // shell name; the mac/linux path renders pwsh into the command string above,
  // so we keep binShell undefined there to leave ASRT's established
  // `/bin/bash -c` wrapping unchanged.
  const binShell = isWindows ? binShellForExecutable(executable) : undefined;

  const home = process.env["HOME"];
  const allowRead = [cwd, ...writePaths];
  const denyRead = [
    ...getDefaultSensitiveReadDenyPaths(),
    ...(home !== undefined && home !== "" ? [home] : []),
  ];
  const filesystem = {
    allowWrite: [...writePaths],
    allowRead,
    denyRead,
    denyWrite: getDefaultSensitiveWriteDenyPaths(),
  };

  const abortController = new AbortController();
  let wrapped: { argv: string[]; env: NodeJS.ProcessEnv };
  try {
    wrapped = await wrapToolCommand(sandboxCommand, {
      filesystem,
      abortSignal: abortController.signal,
      ...(binShell !== undefined ? { binShell } : {}),
    });
  } catch (err) {
    return {
      output: `PowerShell spawn failed: ${(err as Error).message}`,
      isError: true,
      metadata: { sandboxed: true },
    };
  }

  const [cmd, ...args] = wrapped.argv;
  if (cmd === undefined) {
    return {
      output: "PowerShell spawn failed: ASRT returned an empty argv",
      isError: true,
      metadata: { sandboxed: true },
    };
  }

  // Per-platform env: on win32 ASRT returns a REAL env carrying the proxy
  // set the sandboxed child needs (srt-win forwards its env verbatim — the proxy
  // vars are NOT baked into the command string as they are on mac/linux). On
  // mac/linux `wrapped.env` IS process.env (the proxy is in the wrapped command
  // string). Either way buildSandboxedChildEnv composes the SAME secret-stripped
  // result: it starts from the safe whitelist baseline and overlays ONLY the
  // allow-listed proxy/CA/SANDBOX_RUNTIME keys ASRT set/changed — so on win32
  // the proxy set is propagated (the "spread") and on mac/linux nothing extra
  // leaks (ASRT changed nothing in process.env). Secrets stay stripped on both.
  const childEnv = buildSandboxedChildEnv(wrapped.env);

  return await new Promise<ToolResult>((resolveResult) => {
    const child: PipedChild = spawn(cmd, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      env: childEnv,
    });
    trackManagedChildProcess(child, { label: "tool:powershell:asrt" });

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
      abortController.abort();
      terminateProcess(child);
    }, timeoutSeconds * 1000);

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void cleanupAsrtSandboxAfterCommand();
      const output = formatOutput(Buffer.concat(chunks).toString("utf-8"));
      resolveResult({
        output: timedOut
          ? `PowerShell command timed out after ${timeoutSeconds} seconds.\n${output}`
          : output,
        isError: timedOut || code !== 0,
        metadata: { returncode: code, timedOut, sandboxed: true },
      });
    };

    child.on("close", (code) => finish(code));
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void cleanupAsrtSandboxAfterCommand();
      resolveResult({
        output: err && "code" in err && err.code === "ENOENT"
          ? `PowerShell executable not found: ${executable}`
          : `PowerShell spawn failed: ${err.message}`,
        isError: true,
        metadata: { sandboxed: true },
      });
    });
  });
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
    trackManagedChildProcess(child, { label: "tool:powershell" });

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
