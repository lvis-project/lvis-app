/**
 * Permission policy — Layer 6 hook script runner.
 *
 * Spec ref: docs/architecture/permission-policy-design.md §3 Layer 6.
 *
 * Executes one or more pre/post/perm hook scripts. Each script:
 *   - receives the wire-shape JSON on stdin
 *   - returns `{ action, reason }` JSON on stdout
 *   - exit !=0  → treated as deny (fail-safe)
 *   - timeout   → treated as deny
 *   - bad JSON  → treated as deny + warn
 *
 * Composition rule (v1, §3 Layer 6 critic M3):
 *   - hook *can* deny what upstream allowed (deny precedence)
 *   - hook *cannot* allow what upstream denied — that's enforced at the
 *     caller (the Layer 6 result is downgrade-only). This module returns
 *     the verdict; pipeline merge logic lives in the integration site.
 *
 * DLP applied at the *caller* — input is already redacted before this
 * module sees it. We do not re-mask here because mismatched mask rules
 * across call sites would surface as test flakes.
 */
import { spawn } from "node:child_process";
import { buildSafeChildEnv } from "../tools/safe-env.js";
import {
  resolveShell,
  shellEnvForChild,
  shellCommandForHookPath,
  shellQuote,
  ShellMismatchError,
} from "../lib/shell-resolver.js";
import { createLogger } from "../lib/logger.js";
import { trackManagedChildProcess } from "../main/managed-child-processes.js";
import {
  DEFAULT_HOOK_TIMEOUT_MS,
  MAX_HOOK_STDOUT_BYTES,
  type ScriptHookInvocationResult,
  type ScriptHookStdin,
  type ScriptHookStdout,
} from "./script-hook-types.js";
import type { DiscoveredHook } from "./hook-discovery.js";

const log = createLogger("hook-runner");

export interface RunOneHookOptions {
  /** Per-hook timeout in ms. Defaults to {@link DEFAULT_HOOK_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Working directory for the spawned hook. Defaults to `process.cwd()`. */
  cwd?: string;
}

/**
 * Run a single hook script. Pipes the canonical stdin payload, captures
 * stdout (capped), enforces the timeout, and parses the verdict.
 *
 * Exit code !=0, malformed stdout, or timeout all collapse to
 * `decision: "deny"` per the spec's fail-safe rule.
 */
export async function runOneHookScript(
  hook: DiscoveredHook,
  payload: ScriptHookStdin,
  options: RunOneHookOptions = {},
): Promise<ScriptHookInvocationResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
  const cwd = options.cwd ?? process.cwd();
  const start = Date.now();

  let shell;
  try {
    shell = resolveShell();
  } catch (err) {
    if (err instanceof ShellMismatchError) {
      return {
        hookPath: hook.path,
        hookType: hook.hookType,
        decision: "deny",
        reason: `shell unavailable: ${err.message}`,
        rawStdout: "",
        timedOut: false,
        durationMs: Date.now() - start,
      };
    }
    throw err;
  }

  return new Promise<ScriptHookInvocationResult>((resolve) => {
    // Run via the resolved shell — so a hook can be `bash hook.sh` even
    // on Windows under Git Bash. The hook file path is passed as $0 via
    // `shell.shellArgs(...)` so the script's own `$0` reflects its path.
    const hookEnv = {
      LVIS_HOOK_TYPE: payload.hookType,
      LVIS_HOOK_TOOL_NAME: payload.toolName,
      LVIS_HOOK_TRUST_ORIGIN: payload.trustOrigin,
    };
    const hookCommand = `${shellEnvAssignments(hookEnv)} ${shellCommandForHookPath(shell, hook.path)}`;
    const child = spawn(shell.cmd, shell.shellArgs(hookCommand), {
      cwd,
      // Allowlist env — do not leak ANTHROPIC_API_KEY, AWS_*, GITHUB_TOKEN
      // etc. to hook scripts. The hook receives only the LVIS_HOOK_* vars.
      env: shellEnvForChild(shell, buildSafeChildEnv(hookEnv)),
      stdio: ["pipe", "pipe", "pipe"],
      // Run in a new process group so SIGKILL on timeout reaps the
      // entire descendant tree (sh → script → sleep). Without this the
      // child shell dies but its descendants keep running.
      detached: process.platform !== "win32",
    });
    trackManagedChildProcess(child, {
      label: "hook:script",
      killProcessGroup: process.platform !== "win32",
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stdoutCapped = false;

    child.stdout?.on("data", (c: Buffer) => {
      stdoutBytes += c.byteLength;
      if (stdoutBytes > MAX_HOOK_STDOUT_BYTES) {
        if (!stdoutCapped) {
          stdoutCapped = true;
          // Keep what we already have; don't grow further.
          stdoutChunks.push(c.subarray(0, Math.max(0, MAX_HOOK_STDOUT_BYTES - (stdoutBytes - c.byteLength))));
        }
        return;
      }
      stdoutChunks.push(c);
    });
    child.stderr?.on("data", (c: Buffer) => {
      // Cap stderr at the same byte budget; we use it only for diagnostic logging.
      if (stderrChunks.reduce((s, b) => s + b.byteLength, 0) >= MAX_HOOK_STDOUT_BYTES) return;
      stderrChunks.push(c);
    });
    child.stdin?.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EPIPE") return;
      log.warn("hook stdin error: %s (%s)", hook.fileName, err.message);
    });

    let settled = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timeoutFallback: ReturnType<typeof setTimeout> | undefined;

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (timeoutFallback) clearTimeout(timeoutFallback);
      const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
      const stderr = Buffer.concat(stderrChunks).toString("utf-8");
      const durationMs = Date.now() - start;

      if (timedOut) {
        log.warn("hook timeout: %s (%dms)", hook.fileName, timeoutMs);
        resolve({
          hookPath: hook.path,
          hookType: hook.hookType,
          decision: "deny",
          reason: `hook timed out after ${timeoutMs}ms`,
          rawStdout: stdout,
          exitCode: code ?? undefined,
          timedOut: true,
          durationMs,
        });
        return;
      }

      if (code !== 0) {
        // Fail-safe: non-zero exit → deny. Stderr surfaces the cause.
        const tail = stderr.length > 0 ? stderr.trim().slice(0, 200) : `exit ${code}`;
        resolve({
          hookPath: hook.path,
          hookType: hook.hookType,
          decision: "deny",
          reason: `hook exited non-zero: ${tail}`,
          rawStdout: stdout,
          exitCode: code ?? undefined,
          timedOut: false,
          durationMs,
        });
        return;
      }

      const parsed = parseHookStdout(stdout);
      if (!parsed) {
        resolve({
          hookPath: hook.path,
          hookType: hook.hookType,
          decision: "deny",
          reason: `hook stdout not valid {action,reason} JSON`,
          rawStdout: stdout,
          exitCode: code,
          timedOut: false,
          durationMs,
        });
        return;
      }
      resolve({
        hookPath: hook.path,
        hookType: hook.hookType,
        decision: parsed.action,
        reason: parsed.reason,
        rawStdout: stdout,
        exitCode: code,
        timedOut: false,
        durationMs,
      });
    };

    timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform !== "win32" && child.pid !== undefined) {
          // Kill the whole process group (negative pid). detached:true
          // above made the child a group leader so this reaps any
          // descendants spawned inside the script (e.g. `sleep 30`).
          process.kill(-child.pid, "SIGKILL");
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        // Already exited or pid invalid.
      }
      timeoutFallback = setTimeout(() => finish(child.exitCode), 1000);
    }, timeoutMs);

    child.on("close", (code: number | null) => finish(code));

    child.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (timeoutFallback) clearTimeout(timeoutFallback);
      resolve({
        hookPath: hook.path,
        hookType: hook.hookType,
        decision: "deny",
        reason: `hook spawn error: ${err.message}`,
        rawStdout: "",
        timedOut: false,
        durationMs: Date.now() - start,
      });
    });

    try {
      const json = JSON.stringify(payload);
      child.stdin?.write(json);
      child.stdin?.end();
    } catch (err) {
      clearTimeout(timer);
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
      resolve({
        hookPath: hook.path,
        hookType: hook.hookType,
        decision: "deny",
        reason: `failed to serialise hook payload: ${(err as Error).message}`,
        rawStdout: "",
        timedOut: false,
        durationMs: Date.now() - start,
      });
    }
  });
}

function shellEnvAssignments(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(" ");
}

/**
 * Parse a hook script's stdout into the canonical wire shape. Returns
 * null for any malformed input — caller treats null as deny.
 *
 * v1 enum is "allow" | "deny" only; "modify" deferred to hook-signing follow-up.
 */
export function parseHookStdout(stdout: string): ScriptHookStdout | null {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return null;
  // Tolerate code-fence wrapping.
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  const slice = trimmed.slice(start, end + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(slice);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.action !== "allow" && obj.action !== "deny") return null;
  if (typeof obj.reason !== "string") return null;
  // v1 forbids "modify" — even if the script returned it, downgrade is
  // not a thing we silently ignore. Treat as malformed → caller denies.
  return {
    action: obj.action,
    reason: obj.reason.length > 280 ? obj.reason.slice(0, 280) : obj.reason,
  };
}

/**
 * Run a chain of hooks of the same type. Order = caller-supplied
 * (alphabetical from {@link discoverHooks}). Stops at the first deny —
 * subsequent hooks are not invoked (deny precedence + don't waste cycles).
 */
export async function runHookChain(
  hooks: DiscoveredHook[],
  payload: ScriptHookStdin,
  options: RunOneHookOptions = {},
): Promise<{
  decision: "allow" | "deny";
  reason: string;
  results: ScriptHookInvocationResult[];
}> {
  const results: ScriptHookInvocationResult[] = [];
  for (const hook of hooks) {
    const r = await runOneHookScript(hook, payload, options);
    results.push(r);
    if (r.decision === "deny") {
      return { decision: "deny", reason: `${hook.fileName}: ${r.reason}`, results };
    }
  }
  return {
    decision: "allow",
    reason: hooks.length === 0 ? "no hooks" : `${hooks.length} hook(s) allowed`,
    results,
  };
}
