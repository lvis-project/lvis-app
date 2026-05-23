/**
 * Portions adapted from OpenHarness (MIT License)
 * https://github.com/HKUDS/OpenHarness/blob/main/src/openharness/tools/bash_tool.py
 * Copyright (c) 2025 OpenHarness Contributors
 *
 * SafeBashExecutor (Tier A1) — non-interactive shell execution with
 * preflight detection for interactive scaffolds, timeout handling with
 * partial-output drain, graceful terminate→kill ladder, and output cap.
 *
 * AF3: the `cwd` sandbox check in `execute()` is a **heuristic hint**,
 * not a sandbox boundary. A user-supplied `input.cwd` that points outside
 * the session cwd is rejected before spawn, but the real enforcement of
 * which commands may run lives in {@link ../main/bash-ast-validator.ts}.
 * Do not rely on this function to stop shell escapes — only BashAstValidator
 * (Step 2.5 of the tool executor pipeline) prevents dangerous syntax.
 */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createHash } from "node:crypto";
import { resolveShell, shellEnvForChild } from "../lib/shell-resolver.js";
import type { Readable } from "node:stream";
import { isAbsolute, resolve as pathResolve } from "node:path";
import { z } from "zod";

type PipedChild = ChildProcessByStdio<null, Readable, Readable>;

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
import { getSandboxRunner } from "../permissions/sandbox-runner.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import { trackManagedChildProcess } from "../main/managed-child-processes.js";

export const BashToolInputSchema = z.object({
  command: z.string().min(1).describe("Shell command to execute"),
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

const INTERACTIVE_SCAFFOLDS = [
  "create-next-app",
  "npm create ",
  "pnpm create ",
  "yarn create ",
  "bun create ",
  "pnpm dlx ",
  "npm init ",
  "pnpm init ",
  "yarn init ",
  "bunx create-",
  "npx create-",
];

const NON_INTERACTIVE_MARKERS = [
  "--yes",
  " -y",
  "--skip-install",
  "--defaults",
  "--non-interactive",
  "--ci",
];

export class BashTool extends ZodTool<typeof BashToolInputSchema> {
  readonly name = "bash";
  readonly description = "Run a shell command in the local repository.";
  readonly inputSchema = BashToolInputSchema;
  override readonly category: ToolCategory = "shell";

  override isReadOnly(_input: unknown): boolean {
    return false;
  }

  approvalCacheKey(input: unknown): string {
    const parsed = BashToolInputSchema.parse(input);
    return createHash("sha256")
      .update(JSON.stringify({ command: parsed.command, cwd: parsed.cwd ?? null }))
      .digest("hex");
  }

  protected async executeTyped(
    input: z.infer<typeof BashToolInputSchema>,
    ctx: ToolExecutionContext,
  ): Promise<ToolResult> {
    // Preflight: interactive scaffolds would hang on stdin.
    const preflightError = preflightInteractiveCommand(input.command);
    if (preflightError !== null) {
      return {
        output: preflightError,
        isError: true,
        metadata: { interactiveRequired: true },
      };
    }

    // Sandbox path check on cwd (if overridden).
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

    // §691 PR-A2: SandboxRunner spawn path (first consumer of SandboxedProcess).
    // If a runner is registered for the current platform (Linux bwrap via PR-A2,
    // macOS/Win via PR-A3), delegate spawn to it. The sandboxed process exposes
    // stdout/stderr as WHATWG ReadableStream<Uint8Array>; we pipe through
    // TextDecoderStream for UTF-8 string capture (CJK multi-byte boundary safe).
    //
    // MEDIUM-2: Gated on LVIS_SANDBOX_ENABLED=1. Default off until PR-A4 R-2
    // wires the policy hook and enables always-on. This prevents bwrap from
    // breaking all Linux users before the full policy rollout.
    // TODO(PR-A4 R-2): remove the env-gate and make sandbox always-on.
    //
    // If no runner is registered or sandbox is not enabled (isolation=none per D8),
    // fall through to the existing spawnWithTimeout path unchanged — R-1 composition
    // rule + reviewer judgment remain the safety net.
    const sandboxRunner = getSandboxRunner(process.platform as NodeJS.Platform);
    const sandboxEnabled = process.env["LVIS_SANDBOX_ENABLED"] === "1";
    if (sandboxRunner && sandboxEnabled) {
      return await spawnWithSandbox(sandboxRunner, input.command, resolvedCwd, input.timeoutSeconds);
    }

    return await spawnWithTimeout(input.command, resolvedCwd, input.timeoutSeconds); // isolation=none path
  }
}

function preflightInteractiveCommand(command: string): string | null {
  const lowered = command.toLowerCase();
  const hasScaffold = INTERACTIVE_SCAFFOLDS.some((marker) => lowered.includes(marker));
  const hasNonInteractive = NON_INTERACTIVE_MARKERS.some((marker) =>
    lowered.includes(marker),
  );
  if (hasScaffold && !hasNonInteractive) {
    return (
      "This command appears to require interactive input before it can continue. " +
      "The bash tool is non-interactive, so it cannot answer installer/scaffold prompts live. " +
      "Prefer non-interactive flags (for example --yes, -y, --skip-install, --defaults, --non-interactive), " +
      "or run the scaffolding step once in an external terminal before asking the agent to continue."
    );
  }
  return null;
}

interface SpawnResult {
  output: string;
  isError: boolean;
  metadata: Record<string, unknown>;
}

/**
 * Execute a shell command via the registered {@link SandboxRunner} for the
 * current platform (PR-A2: Linux bwrap; PR-A3: macOS/Windows).
 *
 * The command is run as `bash -c <command>` inside the sandbox. stdout and
 * stderr are merged into a single string output (matching the behaviour of
 * {@link spawnWithTimeout}) via TextDecoderStream UTF-8 decoding.
 *
 * Timeout: after `timeoutSeconds` the process is aborted via `proc.abort()`
 * (SIGTERM to bwrap wrapper, which propagates into the namespace).
 *
 * The sandboxed process is given a conservative capability set:
 *   - `networkBlocked: true` — no outbound egress (D1 verified-kernel)
 *   - `fsReadPaths: ["/etc", "/usr"]` — minimal read mounts
 *   - `fsWritePaths: [resolvedCwd]` — write access only to the working dir
 *   - `processIsolated: true` — separate PID namespace
 *
 * Policy notes:
 *   - Network policy will be refined by R-2 hook in PR-A4.
 *   - fsReadPaths will be extended based on tool analysis in PR-A3.
 *   - The cwd bind is the only write path — tools that need broader write
 *     access must request it via the capability system (future R-3).
 *
 * @internal — only exported for testing.
 */
export async function spawnWithSandbox(
  runner: import("../permissions/sandbox-runner.js").SandboxRunner,
  command: string,
  resolvedCwd: string,
  timeoutSeconds: number,
): Promise<SpawnResult> {
  const shell = resolveShell();
  // Pass only string-valued env entries (SandboxRunner env type is Record<string,string>).
  // CRITICAL-1: runner uses --clearenv + --setenv so only these entries enter the sandbox.
  const safeEnv = Object.fromEntries(
    Object.entries(shellEnvForChild(shell, buildSafeChildEnv())).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );

  const proc = await runner.spawn(
    shell.cmd,
    shell.shellArgs(command),
    {
      networkBlocked: true,
      // MEDIUM-3: /lib /lib64 /bin /sbin are now provided by the runner's base
      // whitelist. Caller still specifies /etc /usr + HOME for shell/locale/git.
      fsReadPaths: [
        "/etc",
        "/usr",
        process.env["HOME"] ?? "/home",
      ],
      fsWritePaths: [resolvedCwd],
      processIsolated: true,
    },
    // CRITICAL-2: pass cwd so the runner applies --chdir inside the namespace.
    { env: safeEnv, cwd: resolvedCwd },
  );

  const chunks: string[] = [];

  // HIGH-2: per-stream TextDecoder instance — a single shared decoder would
  // corrupt multi-byte CJK sequences when stdout and stderr are drained
  // concurrently because TextDecoder is stateful (stream: true mode buffers
  // incomplete byte sequences across calls).
  async function drainStream(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder("utf-8");
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(decoder.decode(value, { stream: true }));
      }
      // Flush any remaining bytes held by the decoder.
      const flushed = decoder.decode(undefined, { stream: false });
      if (flushed) chunks.push(flushed);
    } finally {
      reader.releaseLock();
    }
  }

  let timedOut = false;
  let code: number | undefined;

  const timeoutHandle = setTimeout(async () => {
    timedOut = true;
    await proc.abort();
  }, timeoutSeconds * 1000);

  try {
    // Drain stdout and stderr concurrently, then wait for exit.
    await Promise.all([drainStream(proc.stdout), drainStream(proc.stderr)]);
    code = await proc.exitCode;
  } catch (err) {
    // HIGH-1: signal kill or spawn error — preserve the error message for
    // diagnostic parity with spawnWithTimeout's "spawn failed: …" path.
    code = undefined;
    chunks.push(`\nspawn failed: ${(err as Error).message}`);
  } finally {
    clearTimeout(timeoutHandle);
  }

  const combined = chunks.join("");
  const formatted = formatOutput(combined);

  if (timedOut) {
    return {
      output: formatTimeoutOutput(formatted, command, timeoutSeconds),
      isError: true,
      metadata: { returncode: code ?? null, timedOut: true, sandboxed: true },
    };
  }

  return {
    output: formatted,
    isError: code !== 0,
    metadata: { returncode: code ?? null, sandboxed: true },
  };
}

async function spawnWithTimeout(
  command: string,
  cwd: string,
  timeoutSeconds: number,
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const shell = resolveShell();
    const child: PipedChild = spawn(shell.cmd, shell.shellArgs(command), {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      // Strip secrets (LVIS_*, *_API_KEY, GITHUB_TOKEN, AWS_*, etc.) from
      // the child's environment. Only generic shell/locale vars pass through.
      env: shellEnvForChild(shell, buildSafeChildEnv()),
    });
    trackManagedChildProcess(child, { label: "tool:bash" });

    const chunks: Buffer[] = [];
    const collect = (c: Buffer): void => {
      chunks.push(c);
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
      const combined = Buffer.concat(chunks).toString("utf-8");
      const formatted = formatOutput(combined);
      if (timedOut) {
        resolve({
          output: formatTimeoutOutput(formatted, command, timeoutSeconds),
          isError: true,
          metadata: { returncode: code, timedOut: true },
        });
      } else {
        resolve({
          output: formatted,
          isError: code !== 0,
          metadata: { returncode: code },
        });
      }
    };

    child.on("close", (code) => finish(code));
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        output: `spawn failed: ${err.message}`,
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

function formatTimeoutOutput(
  partial: string,
  command: string,
  timeoutSeconds: number,
): string {
  const parts = [`Command timed out after ${timeoutSeconds} seconds.`];
  if (partial !== "(no output)") {
    parts.push("", "Partial output:", partial);
  }
  const hint = interactiveHint(command, partial);
  if (hint !== null) {
    parts.push("", hint);
  }
  return parts.join("\n");
}

function interactiveHint(command: string, output: string): string | null {
  const lowered = command.toLowerCase();
  const outputLower = output.toLowerCase();
  const looksInteractive = INTERACTIVE_SCAFFOLDS.some((m) => lowered.includes(m));
  const looksPrompt = [
    "would you like",
    "ok to proceed",
    "select an option",
    "press enter",
  ].some((m) => outputLower.includes(m));
  if (looksInteractive || looksPrompt) {
    return (
      "This command appears to require interactive input. " +
      "The bash tool is non-interactive, so prefer non-interactive flags " +
      "(for example --yes, -y, --skip-install, or similar) or run the " +
      "scaffolding step once in an external terminal before continuing."
    );
  }
  return null;
}
