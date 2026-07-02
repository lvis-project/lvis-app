/**
 * pty-manager.ts — interactive PTY terminal sessions for the workspace rail
 * (#1444). One long-lived pseudo-terminal per workspace tab, spawned INSIDE the
 * ASRT OS sandbox (architecture §6.3.9) so an arbitrary interactive shell
 * inherits the SAME deny-by-default egress floor + filesystem confinement as a
 * bash tool / MCP worker.
 *
 * SECURITY MODEL (why this is worker-wrap, not tool-wrap):
 *   A terminal is a LONG-LIVED process that runs a SEQUENCE of arbitrary
 *   user-typed commands with NO per-command AST validation and NO reviewer gate
 *   (that is the nature of an interactive shell). The ONLY load-bearing control
 *   is therefore the OS sandbox confinement. So this module FAILS CLOSED: it
 *   refuses to spawn unless the active sandbox contains shell effects
 *   (`isActiveSandboxShellContained()` — filesystem + process confinement). On
 *   a degraded / gate-off / Windows fs+network partial host, subprocess/process
 *   residuals remain uncontained, which is strictly worse than a one-shot bash
 *   tool, so we do NOT plain-spawn (No-Fallback rule). See PR body §security.
 *
 * The wrap contract mirrors {@link ../../permissions/worker-spawn.ts} exactly:
 *   `wrapWorkerCommand(cmdline, { filesystem })` returns `{ argv, env }`; the
 *   host spawns `argv[0]` with `argv.slice(1)` — here through `pty.spawn` so the
 *   inner shell gets a real controlling TTY. Per-command `denyRead`/`denyWrite`
 *   REPLACE the shared boot floors in ASRT, so we RESTATE
 *   `getDefaultSensitiveReadDenyPaths()` (else the shell regains read of
 *   `~/.ssh` / `~/.lvis/secrets` / …) AND `getDefaultSensitiveWriteDenyPaths()`
 *   (else the shell could WRITE `~/.zshrc` / `~/.ssh` / `~/.config` /
 *   `~/Library/LaunchAgents` / cron — persistence/re-exec that later runs
 *   OUTSIDE the sandbox; cluster-review MAJOR).
 *
 * WRITE-JAIL ANCHOR: the cwd anchors the write-jail, so it DEFAULTS to the
 * workspace root (process.cwd(), anchored to `~/.lvis/workspace` at boot), NEVER
 * `$HOME` — a `$HOME`-anchored jail would let the shell write those persistence
 * files even before the `denyWrite` floor. A renderer-supplied cwd is validated
 * (absolute + within the workspace root) before it anchors the jail.
 */
import { isAbsolute } from "node:path";
import type { IPty } from "node-pty";
import { createLogger } from "../../lib/logger.js";
import { shellQuote } from "../../lib/shell-resolver.js";
import { buildSandboxedChildEnv } from "../../tools/safe-env.js";
import {
  getDefaultSensitiveReadDenyPaths,
  getDefaultSensitiveWriteDenyPaths,
  wrapWorkerCommand,
  cleanupAsrtSandboxAfterCommand,
  isAsrtSandboxActive,
} from "../../permissions/asrt-sandbox.js";
import { isActiveSandboxShellContained } from "../../permissions/sandbox-capability.js";
import { deriveSandboxWritePaths } from "../../permissions/sandbox-write-jail.js";
import { canonicalizePathForMatch } from "../../permissions/sensitive-paths.js";

const log = createLogger("lvis");

/** Scrollback ring cap per session (bytes). Bounds main-process memory + the
 * replay payload sent to a remounting renderer. */
const RING_MAX_BYTES = 256 * 1024;
/** Hard bounds on the PTY geometry a renderer may request (anti-DoS). */
const MIN_DIM = 1;
const MAX_COLS = 1000;
const MAX_ROWS = 1000;
/** Anti-DoS: max concurrent PTY sessions across all tabs. A new spawn past this
 * is refused so an arbitrary/looping tabId can never spawn unbounded PTYs. */
const MAX_TERMINALS = 16;
/** Anti-DoS: max bytes accepted for a single {@link writeTerminal} (keystroke /
 * paste) forward. An oversized write is dropped rather than streamed to the PTY. */
const MAX_INPUT_BYTES = 1024 * 1024;

export interface SpawnTerminalOptions {
  readonly tabId: string;
  readonly cwd?: string;
  readonly cols?: number;
  readonly rows?: number;
}

export type SpawnTerminalResult =
  | { ok: true; tabId: string; replayed: boolean }
  | {
      ok: false;
      reason: "not-fs-contained" | "bad-request" | "spawn-failed" | "too-many-terminals";
      message: string;
    };

/** main→renderer emitter. Registered ONCE by the terminal IPC domain, which
 * fans out to the app window(s) via safe-send. Kept as an injected sink so this
 * module stays free of `electron` imports (unit-testable in node). */
export type TerminalEmit = (
  event: "data" | "exit",
  payload:
    | { tabId: string; chunk: string }
    | { tabId: string; exitCode: number; signal?: number },
) => void;

let _emit: TerminalEmit = () => {};

/** Register the main→renderer output sink (called once at IPC registration). */
export function setTerminalEmitter(fn: TerminalEmit): void {
  _emit = fn;
}

interface TerminalSession {
  pty: IPty;
  /** FIFO scrollback chunks, capped to {@link RING_MAX_BYTES}. */
  ring: string[];
  ringBytes: number;
  disposeData: () => void;
  disposeExit: () => void;
  exited: boolean;
}

const sessions = new Map<string, TerminalSession>();

/** Lazy, cached ESM import of the native (external, asarUnpack'd) node-pty. Kept
 * dynamic like ASRT's loadSandboxManager so merely importing this module pulls
 * no native addon into non-terminal contexts. */
let _ptyModule: typeof import("node-pty") | null = null;
async function loadPty(): Promise<typeof import("node-pty")> {
  if (_ptyModule) return _ptyModule;
  _ptyModule = await import("node-pty");
  return _ptyModule;
}

function clampDim(value: number | undefined, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const n = Math.floor(value);
  if (n < MIN_DIM) return MIN_DIM;
  if (n > max) return max;
  return n;
}

/** Resolve the interactive login shell. Never derived from workspace content —
 * only `$SHELL` (validated absolute) or a per-platform default. */
function resolveLoginShell(): string {
  const envShell = process.env.SHELL;
  if (typeof envShell === "string" && isAbsolute(envShell)) return envShell;
  return process.platform === "darwin" ? "/bin/zsh" : "/bin/bash";
}

/**
 * Resolve + VALIDATE the working directory that ANCHORS the write-jail.
 *
 * Default (no request): the workspace root — `process.cwd()`, anchored to
 * `~/.lvis/workspace` at boot (ensureWorkspaceCwd) — NEVER `$HOME`, whose jail
 * would let the shell write shell-rc / login-agent persistence files. A
 * renderer-supplied cwd is a trust-sensitive input (it widens the write-jail),
 * so it is honored ONLY when it is absolute, canonicalizes cleanly, and stays
 * WITHIN the workspace root; anything else is REJECTED (No-Fallback: never
 * silently substitute an out-of-root cwd). Canonicalization uses the SAME helper
 * as {@link deriveSandboxWritePaths} so the validated path and the derived jail
 * see bit-identical strings.
 */
function resolveTerminalCwd(
  requested: string | undefined,
): { ok: true; cwd: string } | { ok: false; message: string } {
  const root = canonicalizePathForMatch(process.cwd());
  if (requested === undefined) return { ok: true, cwd: root };
  if (typeof requested !== "string" || !isAbsolute(requested)) {
    return { ok: false, message: "terminal cwd must be an absolute path" };
  }
  const canonical = canonicalizePathForMatch(requested);
  if (canonical !== root && !canonical.startsWith(`${root}/`)) {
    return { ok: false, message: "terminal cwd must be within the workspace root" };
  }
  return { ok: true, cwd: canonical };
}

/** The command string ASRT runs under its `-c` wrapper: exec the interactive
 * login shell so it takes over the PTY node-pty allocated for the sandbox
 * wrapper process (fd 0/1/2 inherit down sandbox-exec/bwrap → shell). */
function buildShellCommand(): string {
  const shell = resolveLoginShell();
  // `exec` replaces the wrapper's `/bin/bash -c` shell so there is no extra
  // process layer; `-l -i` = login + interactive (prompt, job control, rc).
  return `exec ${shellQuote(shell)} -l -i`;
}

function pushRing(session: TerminalSession, chunk: string): void {
  session.ring.push(chunk);
  session.ringBytes += Buffer.byteLength(chunk, "utf-8");
  while (session.ringBytes > RING_MAX_BYTES && session.ring.length > 1) {
    const dropped = session.ring.shift();
    if (dropped !== undefined) session.ringBytes -= Buffer.byteLength(dropped, "utf-8");
  }
}

/**
 * Spawn (or, if a session already exists for `tabId`, REPLAY) an interactive
 * terminal. Idempotent per tab: a renderer remount re-invokes spawn with the
 * same `tabId` and receives the buffered scrollback rather than a fresh shell —
 * the PTY survives ChatSidePanel unmount (redesign "state survives" goal).
 */
export async function spawnTerminal(options: SpawnTerminalOptions): Promise<SpawnTerminalResult> {
  const tabId = typeof options.tabId === "string" ? options.tabId : "";
  if (!tabId) {
    return { ok: false, reason: "bad-request", message: "missing tabId" };
  }

  // Idempotent replay for a remounting renderer.
  const existing = sessions.get(tabId);
  if (existing && !existing.exited) {
    if (existing.ring.length > 0) {
      _emit("data", { tabId, chunk: existing.ring.join("") });
    }
    return { ok: true, tabId, replayed: true };
  }

  // ── FAIL CLOSED: an interactive arbitrary-command shell may spawn ONLY when
  // the active OS sandbox contains shell effects (filesystem + process). No
  // plain-spawn fallback (No-Fallback rule) — a terminal outside shell
  // confinement is strictly more dangerous than a one-shot bash tool. ──
  if (!isAsrtSandboxActive() || !isActiveSandboxShellContained()) {
    return {
      ok: false,
      reason: "not-fs-contained",
      message:
        "Terminal requires the OS tool sandbox with filesystem and process isolation active " +
        "(Settings → Permissions). Unavailable on a degraded / disabled / " +
        "partial sandbox host.",
    };
  }

  // Anti-DoS: bound concurrent PTYs. A remount of an EXISTING tab was replayed
  // above and does not reach here; only a genuinely NEW session counts.
  if (sessions.size >= MAX_TERMINALS) {
    return {
      ok: false,
      reason: "too-many-terminals",
      message: `Too many terminal sessions open (max ${MAX_TERMINALS}). Close one and retry.`,
    };
  }

  // cwd ANCHORS the write-jail: default = workspace root, never $HOME; a
  // renderer-supplied cwd is validated absolute + within the workspace root.
  const resolvedCwd = resolveTerminalCwd(options.cwd);
  if (!resolvedCwd.ok) {
    return { ok: false, reason: "bad-request", message: resolvedCwd.message };
  }
  const cwd = resolvedCwd.cwd;

  const cols = clampDim(options.cols, 80, MAX_COLS);
  const rows = clampDim(options.rows, 24, MAX_ROWS);

  // Filesystem jail (mirrors worker-spawn): write = cwd ∪ authorized dirs;
  // read = jail ∪ cwd; denyRead = the RESTATED shared sensitive read floor (a
  // per-command denyRead REPLACES ASRT's boot floor, so omit-it-and-leak).
  // denyWrite = the RESTATED sensitive WRITE floor (shell-rc / ~/.ssh / ~/.config
  // / LaunchAgents / cron persistence + the read floor): ASRT applies it as
  // denyWithinAllow with PRECEDENCE over allowWrite, so even if the write-jail
  // ever covers $HOME the shell can never write these re-exec vectors
  // (cluster-review MAJOR).
  const allowWrite = deriveSandboxWritePaths({ allowedDirectories: [cwd] });
  const allowRead = [cwd, ...allowWrite];
  const denyRead = getDefaultSensitiveReadDenyPaths();
  const denyWrite = getDefaultSensitiveWriteDenyPaths();

  let wrapped = false;
  try {
    const cmdline = buildShellCommand();
    const { argv, env } = await wrapWorkerCommand(cmdline, {
      filesystem: { allowWrite, allowRead, denyRead, denyWrite },
    });
    wrapped = true;

    const [cmd, ...wrappedArgs] = argv;
    if (cmd === undefined) {
      throw new Error("ASRT returned an empty argv for the terminal wrap");
    }

    // Secret-stripped env + only the ASRT proxy/CA keys ASRT actually changed,
    // plus the TTY hints the shell/xterm expect. buildSandboxedChildEnv already
    // strips LVIS_*/*_API_KEY/GITHUB_TOKEN/AWS_* and overlays the proxy.
    const childEnv: Record<string, string> = {
      ...buildSandboxedChildEnv(env),
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      LANG: process.env.LANG ?? "en_US.UTF-8",
    };

    const { spawn: ptySpawn } = await loadPty();
    const pty = ptySpawn(cmd, wrappedArgs, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: childEnv,
    });

    const session: TerminalSession = {
      pty,
      ring: [],
      ringBytes: 0,
      disposeData: () => {},
      disposeExit: () => {},
      exited: false,
    };

    const dataSub = pty.onData((chunk) => {
      pushRing(session, chunk);
      _emit("data", { tabId, chunk });
    });
    session.disposeData = () => dataSub.dispose();

    const exitSub = pty.onExit(({ exitCode, signal }) => {
      session.exited = true;
      _emit("exit", { tabId, exitCode, signal });
      // Per-command ASRT state decrement (mirrors worker-spawn cleanupOnce) +
      // drop the session so a later spawn for the same tab starts fresh.
      void cleanupAsrtSandboxAfterCommand();
      session.disposeData();
      session.disposeExit();
      sessions.delete(tabId);
    });
    session.disposeExit = () => exitSub.dispose();

    sessions.set(tabId, session);
    log.info({ tabId, cwd, cols, rows, pid: pty.pid }, "terminal: spawned sandboxed PTY");
    return { ok: true, tabId, replayed: false };
  } catch (err) {
    // FAIL CLOSED: the wrap succeeded but pty.spawn threw → decrement the ASRT
    // per-command state so a failed spawn leaves no lingering ref (mirrors
    // worker-spawn's catch).
    if (wrapped) void cleanupAsrtSandboxAfterCommand();
    const message = err instanceof Error ? err.message : String(err);
    log.error({ tabId, err: message }, "terminal: spawn failed");
    return { ok: false, reason: "spawn-failed", message };
  }
}

/** Forward user keystrokes to the PTY. No-op for an unknown/exited tab. An
 * oversized single write (> {@link MAX_INPUT_BYTES}) is DROPPED — a hostile or
 * buggy renderer must not flood an unbounded buffer into the shell (anti-DoS). */
export function writeTerminal(tabId: string, data: string): void {
  const session = sessions.get(tabId);
  if (!session || session.exited) return;
  if (typeof data !== "string") return;
  const bytes = Buffer.byteLength(data, "utf-8");
  if (bytes > MAX_INPUT_BYTES) {
    log.warn({ tabId, bytes, max: MAX_INPUT_BYTES }, "terminal: dropped oversized input write");
    return;
  }
  session.pty.write(data);
}

/** Resize the PTY (FitAddon / ResizeObserver). Clamped, no-op for unknown tab. */
export function resizeTerminal(tabId: string, cols: number, rows: number): void {
  const session = sessions.get(tabId);
  if (!session || session.exited) return;
  session.pty.resize(clampDim(cols, 80, MAX_COLS), clampDim(rows, 24, MAX_ROWS));
}

/** Kill + tear down one terminal (tab close / teardown). Idempotent. */
export function killTerminal(tabId: string): void {
  const session = sessions.get(tabId);
  if (!session) return;
  sessions.delete(tabId);
  try {
    session.disposeData();
    session.disposeExit();
    if (!session.exited) {
      session.pty.kill();
      // The exit handler was disposed, so decrement ASRT state here (the exit
      // event will not run our cleanup for this explicit kill path).
      void cleanupAsrtSandboxAfterCommand();
    }
  } catch (err) {
    log.warn({ tabId, err: err instanceof Error ? err.message : String(err) }, "terminal: kill failed");
  }
}

/** Force-kill every live terminal (app shutdown). Returns the count killed. */
export function killAllTerminals(): number {
  const ids = [...sessions.keys()];
  for (const id of ids) killTerminal(id);
  return ids.length;
}

/** Test-only: number of live sessions. */
export function __terminalSessionCountForTest(): number {
  return sessions.size;
}

/** Test-only: reset module state between tests. */
export function __resetTerminalsForTest(): void {
  for (const id of [...sessions.keys()]) killTerminal(id);
  sessions.clear();
  _emit = () => {};
}
