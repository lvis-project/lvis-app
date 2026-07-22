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
import { z } from "zod";

type PipedChild = ChildProcessByStdio<null, Readable, Readable>;

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
  wrapToolCommand,
  cleanupAsrtSandboxAfterCommand,
  getDefaultSensitiveReadDenyPaths,
  getDefaultSensitiveWriteDenyPaths,
} from "../permissions/asrt-sandbox.js";
import {
  getHostShellExecutionPlan,
  isIssuedHostShellExecutionPlan,
} from "../permissions/sandbox-capability.js";
import {
  getHostShellExecutionPlanAuditProjection,
  requiresExplicitHostShellFallbackApproval,
} from "../permissions/host-shell-execution-plan.js";
import {
  canonicalizeHostShellAllowedDirectories,
  consumeHostShellExecutionPermit,
  resolveHostShellWorkingDirectory,
} from "../permissions/host-shell-execution-permit.js";
import { deriveSandboxWritePaths } from "../permissions/sandbox-write-jail.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import { trackManagedChildProcess } from "../main/managed-child-processes.js";
import { backgroundShellManager } from "./background-shell-manager.js";

export const BashToolInputSchema = z.object({
  command: z.string().min(1).describe("Shell command to execute"),
  cwd: z.string().optional().describe("Working directory override"),
  timeoutSeconds: z
    .number()
    .int()
    .min(1)
    .max(TOOL_TIMEOUT_POLICY.shellMaxMs / 1000)
    .default(TOOL_TIMEOUT_POLICY.shellDefaultMs / 1000),
  run_in_background: z
    .boolean()
    .optional()
    .describe(
      "Run the command in the background and return a shellId immediately instead of waiting. " +
        "Read incremental output with bash_output and stop it with bash_kill. `timeoutSeconds` " +
        "does not apply to a background shell. Only available on the plain host-shell path: under " +
        "the OS sandbox (ASRT) the command runs synchronously and the result is flagged " +
        "backgroundUnavailable, because the sandbox cannot safely run concurrent commands.",
    ),
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

const canonicalBashTools = new WeakSet<object>();

export function isCanonicalBashTool(tool: unknown): tool is BashTool {
  return typeof tool === "object" && tool !== null && canonicalBashTools.has(tool);
}

export class BashTool extends ZodTool<typeof BashToolInputSchema> {
  constructor() {
    super();
    if (new.target === BashTool) canonicalBashTools.add(this);
  }

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
    const resolvedCwd = resolveHostShellWorkingDirectory(ctx.cwd, input.cwd);
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

    // §691: the executor seals the host-shell substrate before permission
    // routing. The supplied plan must come from the live host provider; a
    // structural lookalike cannot downgrade an active ASRT route to plain spawn.
    const suppliedHostShellPlan = ctx.hostShellExecutionPlan;
    if (
      suppliedHostShellPlan !== undefined &&
      !isIssuedHostShellExecutionPlan(suppliedHostShellPlan)
    ) {
      return {
        output: "spawn failed: shell execution plan was not issued by the host.",
        isError: true,
        metadata: { sandboxed: false, isolation: "none" },
      };
    }
    const hostShellPlan = suppliedHostShellPlan ?? getHostShellExecutionPlan();
    // A requested-sandbox fallback is an honest plain host child, never an ASRT child.
    // Its opaque permit exists only after an allow-once approval for this exact
    // command/cwd/tool-use tuple and is consumed before spawn.
    if (requiresExplicitHostShellFallbackApproval(hostShellPlan)) {
      const permitAccepted = consumeHostShellExecutionPermit({
        permit: ctx.hostShellExecutionPermit,
        plan: hostShellPlan,
        toolName: "bash",
        toolUseId:
          typeof ctx.metadata.toolUseId === "string"
            ? ctx.metadata.toolUseId
            : undefined,
        command: input.command,
        requestedCwd: input.cwd,
        executionCwd: ctx.cwd,
        resolvedCwd,
        timeoutSeconds: input.timeoutSeconds,
        allowedDirectories: canonicalizeHostShellAllowedDirectories(ctx.extraAllowedDirectories),
      });
      if (!permitAccepted) {
        return {
          output: "spawn failed: requested-sandbox shell execution requires a one-shot host approval permit.",
          isError: true,
          metadata: { sandboxed: false, isolation: "none" },
        };
      }
    }
    if (hostShellPlan.mode === "blocked") {
      return {
        output:
          "spawn failed: ASRT shell tools require filesystem and process isolation; " +
          "the active sandbox is only partially confined.",
        isError: true,
        metadata: { sandboxed: false, isolation: "none" },
      };
    }
    if (hostShellPlan.mode === "asrt") {
      // Write-jail = canonicalized union of the owner plugin sandbox root
      // (when plugin-owned) and the in-scope allowed directories
      // (cwd ∪ user-authorized extras). cwd stays readable but is no
      // longer the write boundary.
      const writePaths = deriveSandboxWritePaths({
        ...(ctx.ownerPluginSandboxRoot !== undefined
          ? { ownerPluginSandboxRoot: ctx.ownerPluginSandboxRoot }
          : {}),
        allowedDirectories: [resolvedCwd, ...ctx.extraAllowedDirectories],
      });
      const sandboxResult = await spawnWithSandbox(
        input.command,
        resolvedCwd,
        writePaths,
        input.timeoutSeconds,
      );
      return withBackgroundUnavailable(sandboxResult, input.run_in_background === true);
    }

    // Clean plain host-shell path — the ONLY path that may background. The ASRT
    // sandbox is a process-global singleton (cleanupAfterCommand), so a
    // backgrounded ASRT command running concurrently with the next tool would
    // corrupt the shared sandbox state; background execution is therefore
    // confined to the unsandboxed plain path, and the requested-sandbox
    // approval-fallback (requiresExplicitUserApproval) is excluded so a
    // one-shot-approved command cannot outlive its approval.
    if (input.run_in_background === true && !hostShellPlan.requiresExplicitUserApproval) {
      return spawnBackground(input.command, resolvedCwd, sessionIdFromContext(ctx));
    }

    const plainResult = await spawnWithTimeout(input.command, resolvedCwd, input.timeoutSeconds);
    if (!hostShellPlan.requiresExplicitUserApproval) {
      return withBackgroundUnavailable(plainResult, input.run_in_background === true);
    }
    return withBackgroundUnavailable(
      {
        ...plainResult,
        metadata: {
          ...plainResult.metadata,
          sandboxed: false,
          isolation: "none",
          sandboxExecutionPlan: getHostShellExecutionPlanAuditProjection(hostShellPlan),
        },
      },
      input.run_in_background === true,
    );
  }
}

/** Session id threaded by the executor in ctx.metadata; used to scope background shells. */
function sessionIdFromContext(ctx: ToolExecutionContext): string {
  const raw = ctx.metadata["sessionId"];
  return typeof raw === "string" && raw !== "" ? raw : "unknown";
}

/**
 * Flag a synchronous result that was produced because backgrounding was
 * requested but unavailable on the active execution path (ASRT sandbox, blocked,
 * or a requested-sandbox approval fallback). The command still ran; the caller
 * just did not get a background handle.
 */
function withBackgroundUnavailable(result: SpawnResult, requested: boolean): SpawnResult {
  if (!requested) return result;
  return { ...result, metadata: { ...result.metadata, backgroundUnavailable: true } };
}

/**
 * Spawn a plain host-shell child that outlives this call and hand it to the
 * background-shell manager (which tracks it for quit-kill and owns its output
 * buffer). Returns immediately with the shell id. Uses the same secret-stripped
 * environment as {@link spawnWithTimeout}; `timeoutSeconds` does not apply — a
 * background shell runs until it exits, bash_kill, session end, or app quit.
 */
function spawnBackground(command: string, cwd: string, sessionId: string): SpawnResult {
  const shell = resolveShell();
  const child: PipedChild = spawn(shell.cmd, shell.shellArgs(command), {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: shellEnvForChild(shell, buildSafeChildEnv()),
    shell: false,
  });
  const shellId = backgroundShellManager.register({
    sessionId,
    command,
    child,
    startedAt: new Date().toISOString(),
  });
  return {
    output: JSON.stringify({
      backgrounded: true,
      shellId,
      status: "running",
      hint: "Read output with bash_output({ shellId }); stop it with bash_kill({ shellId }).",
    }),
    isError: false,
    metadata: { backgrounded: true, shellId },
  };
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
 * Execute a shell command under the ASRT (Anthropic sandbox-runtime) sandbox.
 *
 * ASRT does not spawn the workload: {@link wrapToolCommand} returns the
 * `{ argv, env }` for the OS-confined wrapper (macOS Seatbelt profile, Linux
 * bwrap+seccomp) and the host spawns it here with `shell: false` (the wrapper
 * argv already contains the shell invocation; a second shell would double-parse
 * the command). Windows ASRT is not shell-contained and cannot accept the
 * per-exec allowRead/allowWrite grants this path needs, so executeTyped refuses
 * before reaching this function on win32. After exit,
 * {@link cleanupAsrtSandboxAfterCommand} releases the per-command proxy/helper
 * state.
 *
 * Filesystem jail (per-command, trust-safe — see asrt-sandbox.PerCommandFilesystem):
 *   - `allowWrite: writePaths` — the namespace-scoped write-jail derived by
 *     {@link ../permissions/sandbox-write-jail.js deriveSandboxWritePaths}
 *     (owner plugin sandbox root ∪ allowed directories), NOT the bare cwd.
 *   - read-jail HOME-leak fix: `denyRead: [$HOME]` then re-allow the cwd and
 *     the write paths via `allowRead`. ASRT's denyRead takes precedence over
 *     allowRead's parent, so this denies the broad home dir while keeping the
 *     working tree readable — closing the old bwrap/sandbox-exec leak where the
 *     entire HOME was mounted readable.
 *
 * Network egress is governed by the SHARED boot config, NOT per command: boot
 * sets `strictAllowlist: true` + the UNION of every loaded plugin's manifest
 * allow-list (see asrt-sandbox.ts NETWORK ENFORCEMENT MODEL header). Under
 * strict, any out-of-union host is HARD-DENIED at the egress proxy with NO
 * askCb fallthrough — there is no interactive prompt for unmatched hosts.
 *
 * @internal — only exported for testing.
 */
export async function spawnWithSandbox(
  command: string,
  resolvedCwd: string,
  writePaths: readonly string[],
  timeoutSeconds: number,
): Promise<SpawnResult> {
  const home = process.env["HOME"];
  // Read-jail HOME-leak fix: deny the whole home dir, then re-allow the working
  // tree (cwd + write paths). Omitting denyRead when HOME is unset avoids
  // denying nothing-meaningful; the write paths are always re-allowed for read.
  const allowRead = [resolvedCwd, ...writePaths];
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

  // binShell threading: the bash tool runs a POSIX shell command. On
  // mac/linux ASRT defaults to `/bin/bash` for the `-c` wrapper, so we leave
  // binShell undefined (unchanged behaviour). The win32 branch below is
  // defensive only: executeTyped refuses partial Windows ASRT before this
  // function because shell execution requires process isolation and per-exec
  // allow grants.
  let binShell: string | undefined;
  if (process.platform === "win32") {
    try {
      const resolved = resolveShell().cmd;
      if (/^[A-Za-z]:[\\/]/.test(resolved)) binShell = resolved;
    } catch {
      // Shell resolution failed (no POSIX shell on PATH); let ASRT default and
      // surface any resulting error through the normal spawn path.
    }
  }

  const abortController = new AbortController();
  let wrapped: { argv: string[]; env: NodeJS.ProcessEnv };
  try {
    wrapped = await wrapToolCommand(command, {
      filesystem,
      abortSignal: abortController.signal,
      ...(binShell !== undefined ? { binShell } : {}),
    });
  } catch (err) {
    return {
      output: `spawn failed: ${(err as Error).message}`,
      isError: true,
      metadata: { sandboxed: false, sandboxAttempted: true, isolation: "unavailable" },
    };
  }

  const [cmd, ...args] = wrapped.argv;
  if (cmd === undefined) {
    return {
      output: "spawn failed: ASRT returned an empty argv",
      isError: true,
      metadata: { sandboxed: false, sandboxAttempted: true, isolation: "unavailable" },
    };
  }

  // Per-platform env: on win32 ASRT returns a REAL env carrying the proxy
  // set (srt-win forwards its env verbatim — the proxy vars are NOT baked into
  // the command string as on mac/linux, where `wrapped.env` IS process.env).
  // buildSandboxedChildEnv composes the SAME secret-stripped result on both: the
  // safe whitelist baseline + ONLY the allow-listed proxy/CA/SANDBOX_RUNTIME
  // keys ASRT set/changed. So the Windows proxy set is propagated (the "spread")
  // while mac/linux gains nothing extra, and host secrets stay stripped on both.
  const childEnv = buildSandboxedChildEnv(wrapped.env);

  return await new Promise<SpawnResult>((resolveResult) => {
    // CRITICAL: shell:false — the wrapper argv is the literal program+args; a
    // shell here would re-parse and break quoting / inject a second shell.
    const child: PipedChild = spawn(cmd, args, {
      cwd: resolvedCwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      env: childEnv,
    });
    trackManagedChildProcess(child, { label: "tool:bash:asrt" });

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
      abortController.abort();
      terminateProcess(child);
    }, timeoutSeconds * 1000);

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Per-command cleanup (proxy/helper state) after the wrapped command ends.
      void cleanupAsrtSandboxAfterCommand();
      const combined = Buffer.concat(chunks).toString("utf-8");
      const formatted = formatOutput(combined);
      if (timedOut) {
        resolveResult({
          output: formatTimeoutOutput(formatted, command, timeoutSeconds),
          isError: true,
          metadata: { returncode: code, timedOut: true, sandboxed: true },
        });
      } else {
        resolveResult({
          output: formatted,
          isError: code !== 0,
          metadata: { returncode: code, sandboxed: true },
        });
      }
    };

    child.on("close", (code) => finish(code));
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void cleanupAsrtSandboxAfterCommand();
      resolveResult({
        output: `spawn failed: ${err.message}`,
        isError: true,
        metadata: { sandboxed: false, sandboxAttempted: true, isolation: "unavailable" },
      });
    });
  });
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
      shell: false,
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
