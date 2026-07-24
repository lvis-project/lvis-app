/**
 * Permission policy — Layer 6 hook script runner.
 *
 * Spec ref: docs/architecture/permission-policy-design.md §3 Layer 6 +
 * docs/architecture/hook-runtime-expansion-design.md §4 / §6 (#811).
 *
 * Executes one hook handler — either a legacy `pre/post/perm-*.sh` file or a
 * declarative `hooks.json` `command` handler (Python / Node / shell + local
 * script). Both collapse to the SAME execution contract:
 *   - receives the wire-shape JSON on stdin
 *   - returns `{ action, reason }` JSON on stdout
 *   - exit !=0  → treated as deny (fail-safe)
 *   - timeout   → treated as deny
 *   - bad JSON  → treated as deny + warn
 *   - spawn err → treated as deny
 *
 * SECURITY INVARIANTS (do not regress — #811):
 *   - **Env allowlist**: the child sees ONLY `buildSafeChildEnv`'s generic
 *     non-secret allowlist plus the injected `LVIS_HOOK_*` vars. No
 *     `ANTHROPIC_API_KEY` / `AWS_*` / `GITHUB_TOKEN` / `LVIS_*` secret ever
 *     reaches a hook.
 *   - **No shell parser for generic commands**: a `hooks.json` `command` is an
 *     already-split argv — we spawn `argv[0]` directly with `argv.slice(1)` as
 *     args (NO `sh -c`), so a crafted matcher/arg can't inject a second shell
 *     command. The legacy `.sh` single-file path still goes through the resolved
 *     shell for Windows interpreter resolution (Git-Bash / WSL), unchanged.
 *   - **Fail-closed**: timeout / nonzero exit / bad JSON / spawn-error → deny.
 *
 * Composition rule (v1, §3 Layer 6 critic M3):
 *   - hook *can* deny what upstream allowed (deny precedence)
 *   - hook *cannot* allow what upstream denied — enforced at the caller.
 *
 * DLP applied at the *caller* — input is already redacted before this module
 * sees it.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { buildSafeChildEnv } from "../tools/safe-env.js";
import {
  resolveShell,
  shellEnvForChild,
  shellCommandForHookPath,
  shellQuote,
  ShellMismatchError,
} from "../lib/shell-resolver.js";
import { createLogger } from "../lib/logger.js";
import {
  forceKillManagedChildProcess,
  trackManagedChildProcess,
} from "../main/managed-child-processes.js";
import {
  DEFAULT_HOOK_TIMEOUT_MS,
  MAX_HOOK_STDOUT_BYTES,
  type HookEvent,
  type ScriptHookInvocationResult,
  type ScriptHookStdin,
  type ScriptHookStdout,
} from "./script-hook-types.js";
import type { DiscoveredHook } from "./hook-discovery.js";
import type { PluginHookOwner } from "./hook-registry.js";

const log = createLogger("hook-runner");

export interface RunOneHookOptions {
  /** Per-hook timeout in ms. Defaults to {@link DEFAULT_HOOK_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Working directory for the spawned hook. Defaults to `process.cwd()`. */
  cwd?: string;
}

/**
 * The minimal shape the runner needs to execute one hook handler. Both a
 * legacy `.sh` `DiscoveredHook` and a declarative `hooks.json` `command`
 * handler normalize into this (see `hook-registry.ts`). Decoupling the runner
 * from `DiscoveredHook` is what lets a generic `command` argv run through the
 * SAME fail-closed / env-allowlist / timeout machinery as a `.sh` file.
 */
export interface RunnableHook {
  /** Stable identity for audit / logs (registry id or `.sh` fileName). */
  id: string;
  /** Closed-set internal event (tool-use pre|post|perm OR a lifecycle event). */
  hookType: HookEvent;
  /**
   * argv to execute. A single-element argv ending in `.sh` is the legacy path
   * (runs through the resolved shell for Windows interpreter resolution);
   * anything else is spawned directly with NO shell (argv[0] = program).
   */
  command: string[];
  /** Optional glob matcher — surfaced to the hook via `LVIS_HOOK_MATCHER`. */
  matcher?: string;
  /** Path for audit/forensics — `.sh` abs path, or the resolved script arg. */
  hookPath: string;
  /**
   * Optional per-hook timeout (ms). Config entries carry their own clamped
   * budget here; when set it takes precedence over `RunOneHookOptions.timeoutMs`
   * so each hook in a mixed chain runs on its own ceiling. `.sh` hooks leave it
   * unset and fall back to the option / default.
   */
  timeoutMs?: number;
  /**
   * Origin discriminant — `.sh` legacy hook vs declarative `hooks.json`
   * `command` entry. Carried through onto every {@link ScriptHookInvocationResult}
   * so the audit layer can tell config-hook vs `.sh`-hook denials apart (#811
   * cluster-review follow-up). Defaults to `"sh"` for the legacy adapter.
   */
  source?: "sh" | "config";
  /**
   * Trust identity of the executed code — the resolved local-script sha256 for a
   * `.sh` hook, or a sha256 of the verbatim command argv for a generic command.
   * The runner falls back to hashing `command` when this is absent so the result
   * always carries a forensic anchor.
   */
  commandIdentity?: string;
  pluginOwner?: PluginHookOwner;
}

/** sha256 (hex) of a verbatim command argv — the forensic anchor for a generic
 * `command` hook that has no on-disk local-script sha. */
function hashCommandArgv(command: string[]): string {
  return createHash("sha256").update(command.join("\0")).digest("hex");
}

/** Adapt a legacy `DiscoveredHook` to the {@link RunnableHook} shape. */
export function runnableFromDiscovered(hook: DiscoveredHook): RunnableHook {
  return {
    id: hook.fileName,
    hookType: hook.hookType,
    command: [hook.path],
    ...(hook.matcher !== undefined ? { matcher: hook.matcher } : {}),
    hookPath: hook.path,
    source: "sh",
    // The `.sh` file IS the trusted local script — its content sha256 is the
    // canonical command identity.
    commandIdentity: hook.sha256,
  };
}

/** Expand a leading `~` / `~/` to the user's home directory. */
function expandHome(token: string): string {
  if (token === "~") return homedir();
  if (token.startsWith("~/") || token.startsWith("~\\")) {
    return homedir() + token.slice(1);
  }
  return token;
}

/**
 * Is this a single legacy `.sh` file that must run through the resolved shell
 * (so Windows Git-Bash / WSL can pick the right interpreter)? Only a
 * single-element argv whose lone token ends in `.sh` qualifies — a generic
 * `command` (even `sh ./x.sh` or `python3 p.py`) is spawned directly.
 */
function isLegacyShellScript(command: string[]): boolean {
  return command.length === 1 && command[0].toLowerCase().endsWith(".sh");
}

/**
 * Build the injected hook env. PRESERVES the existing `LVIS_HOOK_*` set and
 * ADDS `LVIS_HOOK_EVENT` / `LVIS_HOOK_MATCHER` (#811 §6.2). No secret vars are
 * ever added here — `buildSafeChildEnv` is the only env the child sees.
 */
function buildHookEnv(payload: ScriptHookStdin, matcher: string | undefined): Record<string, string> {
  // `event` is the closed-set surface (lifecycle events carry it explicitly;
  // tool-use shapes leave it undefined → fall back to `hookType`).
  const event = payload.event ?? payload.hookType;
  return {
    LVIS_HOOK_TYPE: payload.hookType,
    // #811 — `LVIS_HOOK_EVENT` is the closed-set event (alias of TYPE for the
    // generic-command surface; the lifecycle event for lifecycle dispatches);
    // `LVIS_HOOK_MATCHER` exposes the configured glob.
    LVIS_HOOK_EVENT: event,
    ...(matcher !== undefined ? { LVIS_HOOK_MATCHER: matcher } : {}),
    // `toolName` is present on tool-use + PostToolUseFailure/PermissionDenied
    // lifecycle payloads; absent on session-only lifecycle events.
    ...(payload.toolName !== undefined ? { LVIS_HOOK_TOOL_NAME: payload.toolName } : {}),
    // sessionId is on every shape — lifecycle hooks key their policy on it.
    LVIS_HOOK_SESSION_ID: payload.sessionId,
    LVIS_HOOK_TRUST_ORIGIN: payload.trustOrigin,
    // Per-request MCP-aligned origin (#811 hooks-on-mcp-calls): a hook can deny
    // by the SPECIFIC server/plugin via env (the convenient path, alongside the
    // full stdin JSON). Only present on the tool-use shape.
    ...("mcpServerId" in payload && payload.mcpServerId !== undefined ? { LVIS_HOOK_MCP_SERVER_ID: payload.mcpServerId } : {}),
    ...("pluginId" in payload && payload.pluginId !== undefined ? { LVIS_HOOK_PLUGIN_ID: payload.pluginId } : {}),
  };
}

/**
 * Run a single hook handler. Pipes the canonical stdin payload, captures
 * stdout (capped), enforces the timeout, and parses the verdict.
 *
 * Accepts either a legacy `DiscoveredHook` (back-compat) or a normalized
 * {@link RunnableHook} (declarative `command` handler). Exit code !=0,
 * malformed stdout, timeout, or spawn error all collapse to `decision: "deny"`
 * per the spec's fail-safe rule.
 */
export async function runOneHookScript(
  hook: DiscoveredHook | RunnableHook,
  payload: ScriptHookStdin,
  options: RunOneHookOptions = {},
): Promise<ScriptHookInvocationResult> {
  const runnable = normalizeRunnable(hook);
  // Per-hook timeout precedence: the runnable's own (clamped) budget wins, then
  // the caller-supplied option, then the default. This lets a mixed chain run
  // each config entry on its own ceiling.
  const timeoutMs = runnable.timeoutMs ?? options.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
  const cwd = options.cwd ?? process.cwd();
  const start = Date.now();

  // Forensic anchors carried onto EVERY result this invocation produces. `source`
  // discriminates `.sh` vs config; `commandIdentity` is the local-script sha (sh)
  // or a hash of the verbatim argv (config). These let the audit layer tell
  // config-hook from `.sh`-hook denials apart (#811 cluster-review follow-up).
  const forensics = {
    hookPath: runnable.hookPath,
    hookType: runnable.hookType,
    source: runnable.source ?? "sh",
    commandIdentity: runnable.commandIdentity ?? hashCommandArgv(runnable.command),
    ...(runnable.pluginOwner ? { pluginOwner: runnable.pluginOwner } : {}),
  } as const;

  const deny = (reason: string, extra: Partial<ScriptHookInvocationResult> = {}): ScriptHookInvocationResult => ({
    ...forensics,
    decision: "deny",
    reason,
    rawStdout: "",
    timedOut: false,
    durationMs: Date.now() - start,
    ...extra,
  });

  const hookEnv = buildHookEnv(payload, runnable.matcher);
  const childEnvBase = buildSafeChildEnv(hookEnv);

  // Decide the spawn shape. Legacy single `.sh` → resolved shell (Windows
  // interpreter resolution). Generic command → direct spawn, NO shell.
  let spawnCmd: string;
  let spawnArgs: string[];
  let spawnEnv: Record<string, string>;
  if (isLegacyShellScript(runnable.command)) {
    let shell;
    try {
      shell = resolveShell();
    } catch (err) {
      if (err instanceof ShellMismatchError) {
        return deny(`shell unavailable: ${err.message}`);
      }
      throw err;
    }
    // The hook file path is passed via `shellCommandForHookPath` so the script's
    // own `$0` reflects its path. Env vars are injected as inline assignments
    // (the shell consumes them) AND via the spawn env allowlist.
    const hookCommand = `${shellEnvAssignments(hookEnv)} ${shellCommandForHookPath(shell, runnable.command[0])}`;
    spawnCmd = shell.cmd;
    spawnArgs = shell.shellArgs(hookCommand);
    spawnEnv = shellEnvForChild(shell, childEnvBase);
  } else {
    // Generic command-hook: spawn argv[0] directly with NO shell. Expand a
    // leading `~` in each token (the shell would have done this; a direct
    // spawn does not). NO shell quoting / parsing → no shell-injection surface.
    const argv = runnable.command.map(expandHome);
    spawnCmd = argv[0];
    spawnArgs = argv.slice(1);
    spawnEnv = childEnvBase;
  }

  return new Promise<ScriptHookInvocationResult>((resolve) => {
    const child = spawn(spawnCmd, spawnArgs, {
      cwd,
      // Allowlist env — do not leak ANTHROPIC_API_KEY, AWS_*, GITHUB_TOKEN
      // etc. to hook scripts. The hook receives only the LVIS_HOOK_* vars.
      env: spawnEnv,
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
      log.warn("hook stdin error: %s (%s)", runnable.id, err.message);
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
      try {
        // Root completion is the hook's effect boundary. Reap any background
        // descendants before returning the verdict so a generation update
        // cannot admit new governed work while old hook code is still alive.
        forceKillManagedChildProcess(child, {
          killProcessGroup: process.platform !== "win32",
        });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ESRCH") {
          log.warn(
            "hook descendant cleanup failed: %s (%s)",
            runnable.id,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
      const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
      const stderr = Buffer.concat(stderrChunks).toString("utf-8");
      const durationMs = Date.now() - start;

      if (timedOut) {
        log.warn("hook timeout: %s (%dms)", runnable.id, timeoutMs);
        resolve({
          ...forensics,
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
        const tail = stderr.length > 0
          ? stderr.trim().slice(0, 200)
          : child.signalCode
            ? `signal ${child.signalCode}`
            : `exit ${code}`;
        resolve({
          ...forensics,
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
          ...forensics,
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
        ...forensics,
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
      try {
        forceKillManagedChildProcess(child, {
          killProcessGroup: process.platform !== "win32",
        });
      } catch {
        // Spawn failed or the process tree has already disappeared.
      }
      resolve({
        ...forensics,
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
      try {
        forceKillManagedChildProcess(child, {
          killProcessGroup: process.platform !== "win32",
        });
      } catch {
        // Already exited.
      }
      resolve({
        ...forensics,
        decision: "deny",
        reason: `failed to serialise hook payload: ${(err as Error).message}`,
        rawStdout: "",
        timedOut: false,
        durationMs: Date.now() - start,
      });
    }
  });
}

/** Coerce a `DiscoveredHook` or `RunnableHook` into the runner's working shape. */
function normalizeRunnable(hook: DiscoveredHook | RunnableHook): RunnableHook {
  // A RunnableHook carries `command` (string[]); a DiscoveredHook carries
  // `path` + `fileName`. Discriminate on `command`.
  if (Array.isArray((hook as RunnableHook).command)) {
    return hook as RunnableHook;
  }
  return runnableFromDiscovered(hook as DiscoveredHook);
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
 * (alphabetical from {@link discoverHooks}, then config file order). Stops at
 * the first deny — subsequent hooks are not invoked (deny precedence + don't
 * waste cycles). Each entry may be a legacy `.sh` `DiscoveredHook` or a
 * normalized {@link RunnableHook}.
 */
export async function runHookChain(
  hooks: Array<DiscoveredHook | RunnableHook>,
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
      const label = identityLabel(hook);
      return { decision: "deny", reason: `${label}: ${r.reason}`, results };
    }
  }
  return {
    decision: "allow",
    reason: hooks.length === 0 ? "no hooks" : `${hooks.length} hook(s) allowed`,
    results,
  };
}

/** Human-readable identity for chain deny messages (`.sh` fileName or registry id). */
function identityLabel(hook: DiscoveredHook | RunnableHook): string {
  if (Array.isArray((hook as RunnableHook).command)) {
    return (hook as RunnableHook).id;
  }
  return (hook as DiscoveredHook).fileName;
}
