/**
 * Host shell tool family: the `bash` and `powershell` execution tools, the
 * session-scoped background-shell registry, and the `bash_output` /
 * `bash_kill` tools that read from and stop shells `bash` started in the
 * background. The two shell dialects share one authorization preamble shape
 * (§691 plan sealing + one-shot fallback permit), one output-formatting
 * contract, and one spawn skeleton; colocating them keeps those in lockstep.
 *
 * Portions (the bash tool sections below) adapted from OpenHarness (MIT License)
 * https://github.com/HKUDS/OpenHarness/blob/main/src/openharness/tools/bash_tool.py
 * Copyright (c) 2025 OpenHarness Contributors
 */

import { spawn, type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { Readable } from "node:stream";
import { z } from "zod";

import { resolveShell, shellEnvForChild } from "../lib/shell-resolver.js";
import {
  createDynamicTool,
  ZodTool,
  type Tool,
  type ToolCategory,
  type ToolExecutionContext,
  type ToolExecutionResult,
} from "./base.js";
import { buildSafeChildEnv, buildSandboxedChildEnv } from "./safe-env.js";
import { terminateChildProcess } from "./terminate-child-process.js";
import { createSandboxProcessHome } from "../permissions/sandbox-process-home.js";
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
import {
  assertManagedChildProcessAdmissionOpen,
  trackManagedChildProcess,
} from "../main/managed-child-processes.js";

type PipedChild = ChildProcessByStdio<null, Readable, Readable>;

// Output-formatting contract shared verbatim by both shell dialects.
const OUTPUT_CAP = 12_000;
const TRUNCATION_MARKER = "\n...[truncated]...";

function formatOutput(raw: string): string {
  const text = raw.replace(/\r\n/g, "\n").trim();
  if (text.length === 0) return "(no output)";
  if (text.length > OUTPUT_CAP) return text.slice(0, OUTPUT_CAP) + TRUNCATION_MARKER;
  return text;
}

/**
 * Session-scoped registry for background shell processes started by the `bash`
 * tool with `run_in_background: true`. Mirrors the module-singleton shape of
 * {@link ../main/managed-child-processes.js} (which this also registers each
 * child with, so background shells are force-killed on app quit).
 *
 * Isolation: every entry is tagged with the `sessionId` that started it, and
 * `bash_output` / `bash_kill` reject a `shellId` that belongs to a different
 * session. Shell ids are unguessable UUIDs, so the session tag is defense in
 * depth on top of an already-unforgeable handle.
 *
 * Output model: stdout and stderr are appended to a single combined buffer in
 * arrival order (a terminal-like transcript), capped at
 * {@link MAX_OUTPUT_CHARS}. Once the cap is reached the buffer stops growing and
 * `truncated` latches true — so the read cursor is never invalidated and
 * incremental reads stay correct.
 */
export const MAX_OUTPUT_CHARS = 200_000;
/** Terminal statuses a background shell can settle into. */
type BackgroundShellStatus = "running" | "exited" | "killed" | "failed";

interface BackgroundShellEntry {
  shellId: string;
  sessionId: string;
  command: string;
  child: ChildProcess;
  status: BackgroundShellStatus;
  exitCode: number | null;
  output: string;
  outputTruncated: boolean;
  readCursor: number;
  startedAt: string;
  stopTracking: () => void;
}

interface BackgroundShellReadResult {
  shellId: string;
  status: BackgroundShellStatus;
  exitCode: number | null;
  /** New output since the previous read (advances the cursor). */
  output: string;
  /** True once total output hit the cap and later bytes were dropped. */
  truncated: boolean;
  command: string;
}

export interface BackgroundShellManager {
  register(input: {
    sessionId: string;
    command: string;
    child: ChildProcess;
    startedAt: string;
  }): string;
  read(sessionId: string, shellId: string): BackgroundShellReadResult | undefined;
  kill(sessionId: string, shellId: string): BackgroundShellReadResult | undefined;
  /** Kill + drop every shell owned by a session (call on session end). */
  disposeSession(sessionId: string): number;
  /** Test-only reset. */
  _resetForTest(): void;
  _size(): number;
}

function createManager(): BackgroundShellManager {
  const shells = new Map<string, BackgroundShellEntry>();

  const append = (entry: BackgroundShellEntry, chunk: string): void => {
    if (entry.outputTruncated) return;
    const remaining = MAX_OUTPUT_CHARS - entry.output.length;
    if (remaining <= 0) {
      entry.outputTruncated = true;
      return;
    }
    if (chunk.length <= remaining) {
      entry.output += chunk;
    } else {
      entry.output += chunk.slice(0, remaining);
      entry.outputTruncated = true;
    }
  };

  const snapshot = (entry: BackgroundShellEntry): BackgroundShellReadResult => {
    const output = entry.output.slice(entry.readCursor);
    entry.readCursor = entry.output.length;
    return {
      shellId: entry.shellId,
      status: entry.status,
      exitCode: entry.exitCode,
      output,
      truncated: entry.outputTruncated,
      command: entry.command,
    };
  };

  const owned = (sessionId: string, shellId: string): BackgroundShellEntry | undefined => {
    const entry = shells.get(shellId);
    if (!entry || entry.sessionId !== sessionId) return undefined;
    return entry;
  };

  return {
    register({ sessionId, command, child, startedAt }): string {
      // Keep the registry lean within a long-lived session: drop this session's
      // already-finished shells whose output has been fully read before adding a
      // new one. Never-read terminal shells are preserved (the model may still
      // fetch their final output); everything else is reaped at session end via
      // disposeSession(). This bounds in-session growth without surprising an
      // active poller.
      for (const e of [...shells.values()]) {
        if (
          e.sessionId === sessionId &&
          e.status !== "running" &&
          e.readCursor > 0 &&
          e.readCursor >= e.output.length
        ) {
          e.stopTracking();
          shells.delete(e.shellId);
        }
      }
      const shellId = randomUUID();
      const entry: BackgroundShellEntry = {
        shellId,
        sessionId,
        command,
        child,
        status: "running",
        exitCode: null,
        output: "",
        outputTruncated: false,
        readCursor: 0,
        startedAt,
        stopTracking: trackManagedChildProcess(child, { label: "tool:bash:background" }),
      };
      shells.set(shellId, entry);

      const onStdout = (c: Buffer): void => append(entry, c.toString("utf-8"));
      const onStderr = (c: Buffer): void => append(entry, c.toString("utf-8"));
      child.stdout?.on("data", onStdout);
      child.stderr?.on("data", onStderr);
      child.on("close", (code) => {
        if (entry.status === "running") {
          entry.status = "exited";
          entry.exitCode = code;
        }
      });
      child.on("error", (err) => {
        if (entry.status === "running") {
          entry.status = "failed";
          append(entry, `\n[spawn error] ${err.message}\n`);
        }
      });
      return shellId;
    },

    read(sessionId, shellId): BackgroundShellReadResult | undefined {
      const entry = owned(sessionId, shellId);
      return entry ? snapshot(entry) : undefined;
    },

    kill(sessionId, shellId): BackgroundShellReadResult | undefined {
      const entry = owned(sessionId, shellId);
      if (!entry) return undefined;
      if (entry.status === "running") {
        entry.status = "killed";
        try {
          entry.child.kill("SIGTERM");
        } catch {
          // already gone
        }
      }
      return snapshot(entry);
    },

    disposeSession(sessionId): number {
      let disposed = 0;
      for (const entry of [...shells.values()]) {
        if (entry.sessionId !== sessionId) continue;
        if (entry.status === "running") {
          try {
            entry.child.kill("SIGKILL");
          } catch {
            // already gone
          }
        }
        entry.stopTracking();
        shells.delete(entry.shellId);
        disposed += 1;
      }
      return disposed;
    },

    _resetForTest(): void {
      for (const entry of [...shells.values()]) {
        entry.stopTracking();
      }
      shells.clear();
    },
    _size(): number {
      return shells.size;
    },
  };
}

/** Process-wide singleton, mirroring managed-child-processes.ts. */
export const backgroundShellManager: BackgroundShellManager = createManager();

/**
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

export const BashToolInputSchema = z.object({
  command: z.string().min(1).describe("Shell command to execute"),
  cwd: z.string().optional().describe("Working directory override"),
  // Optional-but-defaulted and strictly positive: a command always has a
  // deadline, so nothing waits forever. No upper bound — a timeout is a clean,
  // retryable error whose retry exists precisely to name a LARGER budget.
  timeoutSeconds: z
    .number()
    .int()
    .min(1)
    .default(TOOL_TIMEOUT_POLICY.shellDefaultMs / 1000)
    .describe(
      "Seconds to wait before the command is killed. Positive integer; defaults to " +
        `${TOOL_TIMEOUT_POLICY.shellDefaultMs / 1000}. Start with the default and only pass a ` +
        "larger value when a previous call timed out.",
    ),
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
  ): Promise<ToolExecutionResult> {
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
 * requested but unavailable on the active execution path (the ASRT sandbox or a
 * requested-sandbox approval fallback). The command still ran; the caller just
 * did not get a background handle. (The `blocked` plan returns its error before
 * this wrap, so it never carries the flag — nothing ran to background.)
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
  assertManagedChildProcessAdmissionOpen("tool:bash:background");
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
  let sandboxHome: ReturnType<typeof createSandboxProcessHome>;
  try {
    sandboxHome = createSandboxProcessHome();
  } catch (err) {
    return {
      output: `spawn failed: could not create isolated HOME: ${(err as Error).message}`,
      isError: true,
      metadata: { sandboxed: false, sandboxAttempted: true, isolation: "unavailable" },
    };
  }
  const home = process.env["HOME"];
  // Read-jail HOME-leak fix: deny the whole home dir, then re-allow the working
  // tree (cwd + write paths). Omitting denyRead when HOME is unset avoids
  // denying nothing-meaningful; the write paths are always re-allowed for read.
  const sandboxWritePaths = [...writePaths, sandboxHome.path];
  const allowRead = [resolvedCwd, ...sandboxWritePaths];
  const denyRead = [
    ...getDefaultSensitiveReadDenyPaths(),
    ...(home !== undefined && home !== "" ? [home] : []),
  ];
  const filesystem = {
    allowWrite: sandboxWritePaths,
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
    sandboxHome.cleanup();
    return {
      output: `spawn failed: ${(err as Error).message}`,
      isError: true,
      metadata: { sandboxed: false, sandboxAttempted: true, isolation: "unavailable" },
    };
  }

  const [cmd, ...args] = wrapped.argv;
  if (cmd === undefined) {
    void cleanupAsrtSandboxAfterCommand();
    sandboxHome.cleanup();
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
  const childEnv = buildSandboxedChildEnv(wrapped.env, { ...sandboxHome.env });

  return await new Promise<SpawnResult>((resolveResult) => {
    // CRITICAL: shell:false — the wrapper argv is the literal program+args; a
    // shell here would re-parse and break quoting / inject a second shell.
    let child: PipedChild;
    try {
      assertManagedChildProcessAdmissionOpen("tool:bash:asrt");
      child = spawn(cmd, args, {
        cwd: resolvedCwd,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        env: childEnv,
      });
    } catch (err) {
      void cleanupAsrtSandboxAfterCommand();
      sandboxHome.cleanup();
      resolveResult({
        output: `spawn failed: ${(err as Error).message}`,
        isError: true,
        metadata: { sandboxed: false, sandboxAttempted: true, isolation: "unavailable" },
      });
      return;
    }
    trackManagedChildProcess(child, { label: "tool:bash:asrt" });

    const chunks: Buffer[] = [];
    const collect = (c: Buffer): void => {
      chunks.push(c);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    let settled = false;
    let timedOut = false;
    let lifecycleCleaned = false;
    const cleanupAfterTermination = (): void => {
      if (lifecycleCleaned) return;
      lifecycleCleaned = true;
      void cleanupAsrtSandboxAfterCommand();
      sandboxHome.cleanup();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      abortController.abort();
      terminateChildProcess(child);
    }, timeoutSeconds * 1000);

    const finish = (code: number | null): void => {
      cleanupAfterTermination();
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Per-command cleanup (proxy/helper state) after the wrapped command ends.
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
      // Node can emit `error` for a failed process operation while the child
      // remains alive. The later `close` event owns ASRT/HOME finalization.
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
    assertManagedChildProcessAdmissionOpen("tool:bash");
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
      terminateChildProcess(child);
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

function formatTimeoutOutput(
  partial: string,
  command: string,
  timeoutSeconds: number,
): string {
  // Expiry is retryable, and saying so is what makes the unbounded
  // `timeoutSeconds` usable: the caller escalates the budget instead of
  // treating the timeout as a dead end.
  const parts = [
    `Command timed out after ${timeoutSeconds} seconds. Retry with a larger ` +
      "`timeoutSeconds` if the command legitimately needs longer.",
  ];
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

function sessionIdOf(ctx: ToolExecutionContext | undefined): string {
  const raw = ctx?.metadata?.["sessionId"];
  return typeof raw === "string" && raw !== "" ? raw : "unknown";
}

function shellIdOf(rawInput: unknown): string {
  const args = (rawInput ?? {}) as Record<string, unknown>;
  return typeof args.shellId === "string" ? args.shellId.trim() : "";
}

function present(result: BackgroundShellReadResult): { output: string; isError: boolean } {
  return {
    output: JSON.stringify({
      shellId: result.shellId,
      command: result.command,
      status: result.status,
      exitCode: result.exitCode,
      output: result.output,
      truncated: result.truncated,
    }),
    isError: false,
  };
}

const NOT_FOUND =
  "no background shell with that id is running in this session (it may have already been reaped, or belongs to another session)";

/**
 * `bash_output` — read newly-accumulated output (and current status/exit code)
 * from a background shell started by `bash` with `run_in_background: true`.
 * Returns only the output produced since the previous call. Read-only.
 */
export function createBashOutputTool(
  manager: BackgroundShellManager = backgroundShellManager,
): Tool {
  return createDynamicTool({
    name: "bash_output",
    description:
      "Read output produced since your last check from a background shell started by `bash` " +
      "with run_in_background: true. Returns the new output plus the shell's status " +
      "(running | exited | killed | failed) and exit code. Poll this to follow a long-running command.",
    source: "builtin",
    category: "read",
    isReadOnly: () => true,
    jsonSchema: {
      type: "object",
      required: ["shellId"],
      properties: {
        shellId: { type: "string", description: "The shell id returned by the background bash call." },
      },
    },
    execute: async (rawInput, ctx) => {
      const shellId = shellIdOf(rawInput);
      if (shellId === "") {
        return { output: "bash_output: `shellId` is required.", isError: true };
      }
      const result = manager.read(sessionIdOf(ctx), shellId);
      if (!result) {
        return { output: `bash_output: ${NOT_FOUND}.`, isError: true };
      }
      return present(result);
    },
  });
}

/**
 * `bash_kill` — terminate a background shell started by `bash` with
 * `run_in_background: true`. Sends SIGTERM and returns the shell's final
 * status plus any remaining unread output.
 */
export function createBashKillTool(
  manager: BackgroundShellManager = backgroundShellManager,
): Tool {
  return createDynamicTool({
    name: "bash_kill",
    description:
      "Terminate a background shell started by `bash` with run_in_background: true, by its shell id. " +
      "Returns the shell's final status and any remaining unread output.",
    source: "builtin",
    category: "shell",
    isReadOnly: () => false,
    jsonSchema: {
      type: "object",
      required: ["shellId"],
      properties: {
        shellId: { type: "string", description: "The shell id returned by the background bash call." },
      },
    },
    execute: async (rawInput, ctx) => {
      const shellId = shellIdOf(rawInput);
      if (shellId === "") {
        return { output: "bash_kill: `shellId` is required.", isError: true };
      }
      const result = manager.kill(sessionIdOf(ctx), shellId);
      if (!result) {
        return { output: `bash_kill: ${NOT_FOUND}.`, isError: true };
      }
      return present(result);
    },
  });
}

/**
 * Native PowerShell tool.
 *
 * This is a distinct shell surface, not a bash alias. The executable is
 * deterministic per platform: Windows uses `powershell.exe`; other platforms
 * use `pwsh`. Missing executables are reported as tool errors.
 */
type PowerShellParser = (command: string) => Promise<PowerShellAstSummary>;

export const PowerShellToolInputSchema = z.object({
  command: z.string().min(1).describe("PowerShell command to execute"),
  cwd: z.string().optional().describe("Working directory override"),
  // Optional-but-defaulted and strictly positive — see BashToolInputSchema.
  timeoutSeconds: z
    .number()
    .int()
    .min(1)
    .default(TOOL_TIMEOUT_POLICY.shellDefaultMs / 1000)
    .describe(
      "Seconds to wait before the command is killed. Positive integer; defaults to " +
        `${TOOL_TIMEOUT_POLICY.shellDefaultMs / 1000}. Start with the default and only pass a ` +
        "larger value when a previous call timed out.",
    ),
});

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

interface PowerShellAstCommand {
  name: string | null;
  elements: string[];
  text: string;
}

export interface PowerShellAstSummary {
  errors: string[];
  commands: PowerShellAstCommand[];
}

const canonicalPowerShellTools = new WeakSet<object>();

export function isCanonicalPowerShellTool(tool: unknown): tool is PowerShellTool {
  return typeof tool === "object" && tool !== null && canonicalPowerShellTools.has(tool);
}

export class PowerShellTool extends ZodTool<typeof PowerShellToolInputSchema> {
  constructor() {
    super();
    if (new.target === PowerShellTool) canonicalPowerShellTools.add(this);
  }

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
  ): Promise<ToolExecutionResult> {
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
        output: "PowerShell spawn failed: shell execution plan was not issued by the host.",
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
        toolName: "powershell",
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
          output: "PowerShell spawn failed: requested-sandbox shell execution requires a one-shot host approval permit.",
          isError: true,
          metadata: { sandboxed: false, isolation: "none" },
        };
      }
    }
    // The structural AST deny for this command string is Step 2.5 in the
    // invocation runner (one stage for both shell dialects), NOT here. Running
    // it here put it AFTER `consumeHostShellExecutionPermit` had burned the
    // user's one-shot allow, so a refused command still cost the permit.
    if (hostShellPlan.mode === "blocked") {
      return {
        output:
          "PowerShell spawn failed: ASRT shell tools require filesystem and process isolation; " +
          "the active sandbox is only partially confined.",
        isError: true,
        metadata: { sandboxed: false, isolation: "none" },
      };
    }
    if (hostShellPlan.mode === "asrt") {
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

    const plainResult = await spawnPowerShell(input.command, resolvedCwd, input.timeoutSeconds);
    if (!hostShellPlan.requiresExplicitUserApproval) return plainResult;
    return {
      ...plainResult,
      metadata: {
        ...plainResult.metadata,
        sandboxed: false,
        isolation: "none",
        sandboxExecutionPlan: getHostShellExecutionPlanAuditProjection(hostShellPlan),
      },
    };
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
 * `powershell.exe` (Windows PowerShell 5.1, always present). The
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
    assertManagedChildProcessAdmissionOpen("tool:powershell-parser");
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
 * Windows ASRT is not shell-contained and ASRT 0.0.73 cannot accept the
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
): Promise<ToolExecutionResult> {
  // Resolve before allocating the temporary profile so a missing PowerShell
  // executable cannot leave an orphaned sandbox HOME behind.
  const executable = resolvePowerShellExecutable();
  let sandboxHome: ReturnType<typeof createSandboxProcessHome>;
  try {
    sandboxHome = createSandboxProcessHome();
  } catch (err) {
    return {
      output: `PowerShell spawn failed: could not create isolated HOME: ${(err as Error).message}`,
      isError: true,
      metadata: { sandboxed: false, sandboxAttempted: true, isolation: "unavailable" },
    };
  }
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
  const sandboxWritePaths = [...writePaths, sandboxHome.path];
  const allowRead = [cwd, ...sandboxWritePaths];
  const denyRead = [
    ...getDefaultSensitiveReadDenyPaths(),
    ...(home !== undefined && home !== "" ? [home] : []),
  ];
  const filesystem = {
    allowWrite: sandboxWritePaths,
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
    sandboxHome.cleanup();
    return {
      output: `PowerShell spawn failed: ${(err as Error).message}`,
      isError: true,
      metadata: { sandboxed: false, sandboxAttempted: true, isolation: "unavailable" },
    };
  }

  const [cmd, ...args] = wrapped.argv;
  if (cmd === undefined) {
    void cleanupAsrtSandboxAfterCommand();
    sandboxHome.cleanup();
    return {
      output: "PowerShell spawn failed: ASRT returned an empty argv",
      isError: true,
      metadata: { sandboxed: false, sandboxAttempted: true, isolation: "unavailable" },
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
  const childEnv = buildSandboxedChildEnv(wrapped.env, { ...sandboxHome.env });

  return await new Promise<ToolExecutionResult>((resolveResult) => {
    let child: PipedChild;
    try {
      assertManagedChildProcessAdmissionOpen("tool:powershell:asrt");
      child = spawn(cmd, args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        env: childEnv,
      });
    } catch (err) {
      void cleanupAsrtSandboxAfterCommand();
      sandboxHome.cleanup();
      resolveResult({
        output: `PowerShell spawn failed: ${(err as Error).message}`,
        isError: true,
        metadata: { sandboxed: false, sandboxAttempted: true, isolation: "unavailable" },
      });
      return;
    }
    trackManagedChildProcess(child, { label: "tool:powershell:asrt" });

    const chunks: Buffer[] = [];
    const collect = (chunk: Buffer): void => {
      chunks.push(chunk);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    let settled = false;
    let timedOut = false;
    let lifecycleCleaned = false;
    const cleanupAfterTermination = (): void => {
      if (lifecycleCleaned) return;
      lifecycleCleaned = true;
      void cleanupAsrtSandboxAfterCommand();
      sandboxHome.cleanup();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      abortController.abort();
      terminateChildProcess(child);
    }, timeoutSeconds * 1000);

    const finish = (code: number | null): void => {
      cleanupAfterTermination();
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
      // `error` may be a failed operation on a live process. The definitive
      // `close` event retains ASRT/HOME cleanup ownership.
      resolveResult({
        output: err && "code" in err && err.code === "ENOENT"
          ? `PowerShell executable not found: ${executable}`
          : `PowerShell spawn failed: ${err.message}`,
        isError: true,
        metadata: { sandboxed: false, sandboxAttempted: true, isolation: "unavailable" },
      });
    });
  });
}

async function spawnPowerShell(
  command: string,
  cwd: string,
  timeoutSeconds: number,
): Promise<ToolExecutionResult> {
  return new Promise((resolve) => {
    const executable = resolvePowerShellExecutable();
    assertManagedChildProcessAdmissionOpen("tool:powershell");
    const child: PipedChild = spawn(
      executable,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
      {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: buildSafeChildEnv(),
        shell: false,
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
      terminateChildProcess(child);
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
