/**
 * Host-mediated long-lived plugin-worker spawn primitive.
 *
 * ⚠️ HOST PRIMITIVE — TOOL PRODUCER NOT WIRED YET ⚠️
 * {@link spawnWorker} is the host half of worker-confinement-via-ASRT for an
 * HTTP plugin worker the HOST connects INBOUND to. It is added to the host +
 * hostApi surface here, but no production Tool descriptor is host-routed
 * through it yet. Until that producer exists, manifest `toolSchemas.workerId`
 * remains advisory and must not be promoted to `Tool.workerId`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A UDS CONTROL CHANNEL (the egress gap this closes)
 * The real dynamic-endpoint egress doer is the long-lived plugin worker (e.g.
 * local-indexer's embedding/caption HTTP worker), not a one-shot tool. To
 * confine it under ASRT while the HOST still drives it, the host must reach the
 * worker. The worker is an HTTP worker the host connects INBOUND to — but on
 * Linux ASRT runs the worker under bwrap `--unshare-net`, which puts it in its
 * OWN network namespace, so loopback TCP (127.0.0.1) inside the jail is NOT the
 * host's loopback. The fix is a Unix-domain-socket (UDS) control channel:
 *   - Linux: the host allocates a writable socketDir; ASRT `--bind`s every
 *     `filesystem.allowWrite` path into the namespace (the SAME mechanism it
 *     uses for its own proxy sockets), so a socket created there is reachable
 *     from BOTH sides. The worker also needs the trusted `allowAllUnixSockets`
 *     weakening to call `socket(AF_UNIX)` past the default seccomp filter.
 *   - macOS: no network namespace, but seatbelt blocks Unix sockets by default;
 *     the socketDir on `network.allowUnixSockets` emits the seatbelt allow rule
 *     so the worker may BIND the socket. The host connects from OUTSIDE the
 *     sandbox (unconstrained).
 *   - Windows: no reliable UDS-bind primitive, so this HTTP-worker control path
 *     FAILS CLOSED when ASRT is active. The legacy unwrapped TCP branch is kept
 *     only while the gate is OFF. Windows worker wrapping needs a separate
 *     TCP-control-channel design; do not infer it from the mac/linux UDS path.
 *
 * ⚠️ The Unix-socket ALLOW config (macOS `allowUnixSockets` / Linux
 * `allowAllUnixSockets`) is INERT per-command in current ASRT — it MUST be set on
 * the SHARED config. {@link spawnWorker} therefore calls
 * {@link registerWorkerUnixSocketDir} (a live, additive shared-config update)
 * BEFORE wrapping, and {@link unregisterWorkerUnixSocketDir} on cleanup. The
 * per-command wrap carries ONLY the filesystem jail (the `--bind`). This was
 * VERIFIED empirically: a per-command allowUnixSockets ⇒ the worker's `listen()`
 * fails with EPERM; the SAME value on the shared config ⇒ the bind succeeds.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * STORAGE NAMESPACE (CLAUDE.md `~/.lvis/plugins/<id>/` rule): the socketDir is
 * the plugin's own sandbox-root subtree `~/.lvis/plugins/<pluginId>/run/
 * <workerId>/` — host-controlled, never a plugin-supplied path. mkdir 0o700;
 * the worker binds the socket 0o600.
 *
 * GATE DEFAULT-OFF: when {@link isAsrtSandboxActive} is false, this is a plain
 * spawn of the exact command — byte-for-byte the legacy behaviour — and returns
 * `socketPath: null` so the consumer falls back to the legacy TCP channel. No
 * UDS dir is created, nothing is wrapped.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { unlinkSync, rmdirSync, chmodSync, lstatSync } from "node:fs";
import { join, resolve as pathResolve } from "node:path";

import { lvisHome } from "../shared/lvis-home.js";
import { shellQuote } from "../lib/shell-resolver.js";
import { buildSandboxedChildEnv } from "../tools/safe-env.js";
import { trackManagedChildProcess } from "../main/managed-child-processes.js";
import {
  isAsrtSandboxActive,
  wrapWorkerCommand,
  cleanupAsrtSandboxAfterCommand,
  registerWorkerUnixSocketDir,
  unregisterWorkerUnixSocketDir,
  getDefaultSensitiveReadDenyPaths,
  getDefaultSensitiveWriteDenyPaths,
} from "./asrt-sandbox.js";
import {
  markPluginWorkerWrapped,
  unmarkPluginWorkerWrapped,
} from "./sandbox-capability.js";

/** Listener registered through {@link SpawnedWorker.onStdout}/`onStderr`. */
export type WorkerOutputListener = (chunk: string) => void;

/**
 * The spec the HOST hands {@link spawnWorker}. Every field originates from
 * TRUSTED host code (the hostApi factory binds `pluginId`); none is a plugin-
 * supplied path. `allowWritePaths` is the worker's filesystem write-jail; the
 * host-allocated socketDir is unioned onto it automatically.
 */
export interface SpawnWorkerSpec {
  /** Owning plugin id — selects the `~/.lvis/plugins/<pluginId>/` sandbox root. */
  readonly pluginId: string;
  /** Stable per-worker id — names the `run/<workerId>/` control dir + the
   *  reviewer wrapped-registry key. Sanitized to a single safe path segment. */
  readonly workerId: string;
  /** The worker executable to spawn (absolute path or PATH-resolved name). */
  readonly command: string;
  /** Argv for the worker. The UDS path is injected per {@link udsArgName}. */
  readonly args?: readonly string[];
  /** Extra env merged onto the secret-stripped base env. */
  readonly env?: NodeJS.ProcessEnv;
  /** Paths the worker may write (its sandbox root etc.). The host-allocated
   *  socketDir is added automatically so the `--bind` (Linux) comes for free. */
  readonly allowWritePaths?: readonly string[];
  /**
   * How the host tells the worker WHERE to bind the control socket (gate ON,
   * non-win32 only — when `socketPath` is non-null):
   *   - a string like `"--uds"` → appends `[udsArgName, socketPath]` to args;
   *   - `{ env: "LVIS_CONTROL_SOCKET" }` → sets that env var to socketPath.
   * The actual worker contract is plugin-specific; this primitive only provides
   * the injection mechanism. Omitted ⇒ the worker is NOT told the path here (a
   * future contract may discover it another way).
   */
  readonly udsArgName?: string | { readonly env: string };
}

/**
 * The handle {@link spawnWorker} returns. `socketPath` is the host-side path to
 * connect to (undici `Agent({ connect: { socketPath } })` / `http.request({
 * socketPath })`) — or `null` when the worker was plain-spawned (gate OFF),
 * signalling the consumer to use the legacy TCP channel. Windows with ASRT
 * active throws before spawn until a Windows control-channel design exists.
 */
export interface SpawnedWorker {
  /** Host-side UDS path, or null on the legacy gate-OFF path. */
  readonly socketPath: string | null;
  /** The child pid (undefined only if spawn produced no pid). */
  readonly pid: number | undefined;
  /** Stop the worker (SIGTERM → SIGKILL after a grace period) + run cleanup. */
  stop(): void;
  /** Subscribe to worker stdout (utf-8, trimmed-per-chunk false). */
  onStdout(listener: WorkerOutputListener): void;
  /** Subscribe to worker stderr (utf-8). */
  onStderr(listener: WorkerOutputListener): void;
  /**
   * Subscribe to worker EXIT (crash or normal). Fires once when the child
   * process exits — the consumer needs this to mark the worker dead and recover
   * (the handle owns lifecycle, so without it a crashed worker is undetectable).
   */
  onExit(listener: (info: { code: number | null; signal: NodeJS.Signals | null }) => void): void;
}

/** Sanitize an id to a single safe path segment (mirrors mcp-manager). */
function safeSegment(id: string, kind: string): string {
  const safe = id.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  if (safe.length === 0) {
    throw new Error(
      `[worker-spawn] cannot derive a path segment for ${kind} '${id}' (empty after sanitization)`,
    );
  }
  return safe;
}

/**
 * Best-effort, idempotent removal of a stale control socket + its dir. Used
 * before spawn (crash-safe: a previous worker may have died without cleanup)
 * and on stop/exit. Sync so it can run inside an exit handler. Never throws.
 */
function removeSocketArtifacts(socketPath: string, socketDir: string): void {
  try {
    unlinkSync(socketPath);
  } catch {
    // Already gone / never created — fine.
  }
  try {
    // Only removes the dir if empty — leaves a non-empty dir intact rather than
    // deleting worker state we don't own.
    rmdirSync(socketDir);
  } catch {
    // Non-empty or already gone — fine.
  }
}

/**
 * Spawn a long-lived plugin worker, host-mediated and (gate ON) ASRT-wrapped
 * with a bind-mounted UDS control channel. See the module header for the model.
 *
 * @returns a {@link SpawnedWorker}. `socketPath` is non-null only on the wrapped
 *   (gate ON, non-win32) path; null on the gate-OFF legacy TCP fallback.
 */
export async function spawnWorker(spec: SpawnWorkerSpec): Promise<SpawnedWorker> {
  const safePlugin = safeSegment(spec.pluginId, "pluginId");
  const safeWorker = safeSegment(spec.workerId, "workerId");
  const args = [...(spec.args ?? [])];

  // Secret-stripped base env (Least Privilege), mirroring the MCP stdio worker.
  const baseEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME ?? process.env.USERPROFILE,
    USERPROFILE: process.env.USERPROFILE,
    APPDATA: process.env.APPDATA,
    LANG: process.env.LANG,
    NODE_ENV: process.env.NODE_ENV,
    ...spec.env,
  };

  // ── Gate OFF → LEGACY plain spawn ───────────────────────────────────
  // Byte-for-byte the pre-existing spawn behaviour for this branch.
  if (!isAsrtSandboxActive()) {
    const child = spawn(spec.command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      env: baseEnv,
    });
    trackManagedChildProcess(child, { label: `worker:${safePlugin}:${safeWorker}` });
    return makeHandle(child, null, () => {
      /* no ASRT/UDS state to release on the legacy path */
    });
  }

  // Windows: this primitive's confinement path depends on a UDS control channel
  // that does not exist on win32. Fail closed while the ASRT gate is active so
  // callers cannot mistake an unwrapped TCP worker for a contained substrate.
  if (process.platform === "win32") {
    throw new Error(
      "[worker-spawn] ASRT-wrapped plugin workers on Windows are disabled: this UDS control-channel primitive has no Windows equivalent. Keep fail-closed until a Windows TCP control-channel/session-grant design lands.",
    );
  }

  // ── Gate ON, mac/linux → ASRT-wrapped with a bind-mounted UDS ──
  // socketDir under the plugin's OWN sandbox root (storage-namespace rule),
  // host-controlled. mkdir 0o700; the worker binds the socket 0o600.
  const socketDir = pathResolve(
    lvisHome(),
    "plugins",
    safePlugin,
    "run",
    safeWorker,
  );
  const socketPath = join(socketDir, "control.sock");
  // Crash-safe: unlink any stale socket from a previous worker that died
  // without cleanup BEFORE recreating the dir.
  removeSocketArtifacts(socketPath, socketDir);
  await mkdir(socketDir, { recursive: true, mode: 0o700 });
  // `mkdir({recursive,mode})` only applies `mode` to dirs it CREATES — a
  // pre-existing leaf (e.g. left by an older build under a looser umask) keeps
  // its old mode. Force 0o700 unconditionally, and reject a symlinked socketDir
  // (a same-user attacker pre-seeding the path can't redirect the bind/binds).
  chmodSync(socketDir, 0o700);
  if (lstatSync(socketDir).isSymbolicLink()) {
    throw new Error(`[worker-spawn] refusing symlinked control dir: ${socketDir}`);
  }

  // Tell the worker where to bind. Either append `[name, path]` to argv or set
  // an env var; the higher-level worker protocol remains plugin-specific.
  if (typeof spec.udsArgName === "string") {
    args.push(spec.udsArgName, socketPath);
  } else if (spec.udsArgName && typeof spec.udsArgName === "object") {
    baseEnv[spec.udsArgName.env] = socketPath;
  }

  // FAIL-CLOSED write jail: socketDir (so the Linux `--bind` exposes it + the
  // socket file can be created on macOS) ∪ the host-supplied write paths. The
  // worker also needs to READ its socketDir + tmp.
  const allowWrite = [socketDir, ...(spec.allowWritePaths ?? [])];
  const tmpDir = process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP;
  const allowRead = [socketDir, ...(spec.allowWritePaths ?? []), ...(tmpDir ? [tmpDir] : [])];

  // FAIL-CLOSED read jail: a per-command `denyRead` REPLACES the shared boot
  // floor in ASRT (`customConfig?.filesystem?.denyRead ?? config.filesystem
  // .denyRead` — an empty-but-present array is NOT nullish), so it must be
  // restated here or the worker regains read of `~/.lvis/secrets`, `~/.ssh`,
  // `~/.aws`, … — the SAME SOT bash/MCP wraps restate (the #1365 floor).
  const denyRead = getDefaultSensitiveReadDenyPaths();
  // FAIL-CLOSED write floor: per-command `denyWrite` also replaces the shared
  // boot array, so restate the centralized persistence-vector SOT here.
  // This keeps long-lived plugin workers symmetric with terminal/MCP wraps.
  const denyWrite = getDefaultSensitiveWriteDenyPaths();

  // UDS allow — SHARED config, NOT per-command (the per-command channel is INERT
  // for the seatbelt/seccomp UDS rules in current ASRT; see asrt-sandbox.ts's
  // WORKER UDS header). Register the socketDir so the live shared config grants
  // the worker's bind: macOS `allowUnixSockets:(subpath <dir>)`, Linux the
  // `allowAllUnixSockets` weakening (the `--bind` of the writable dir scopes
  // WHERE). MUST happen BEFORE the wrap so the spawned profile carries it.
  let registered = false;
  let wrapped = false;
  try {
    await registerWorkerUnixSocketDir(socketDir);
    registered = true;

    // Assemble the command DEFENSIVELY: shell-quote the binary + every arg so a
    // path with spaces/metacharacters cannot mis-split. ASRT runs it under a
    // POSIX shell (mac/linux); win32 is handled by the legacy branch above. The
    // per-command wrap carries ONLY the filesystem jail (the `--bind`).
    const cmdline = [spec.command, ...args].map((part) => shellQuote(part)).join(" ");
    const { argv, env } = await wrapWorkerCommand(cmdline, {
      filesystem: { allowWrite, allowRead, denyRead, denyWrite },
    });
    // The wrap incremented ASRT's per-command state (Linux activeSandboxCount,
    // proxy ref); from here a failure MUST decrement it (see the catch).
    wrapped = true;

    const [cmd, ...wrappedArgs] = argv;
    if (cmd === undefined) {
      throw new Error("[worker-spawn] ASRT returned an empty argv for the worker wrap");
    }

    // Mark the reviewer wrapped-registry: this worker genuinely runs under ASRT.
    // Keyed plugin-scoped (NOT workerId alone) so two plugins sharing a workerId
    // (e.g. "main") cannot collide into a false `asrt` no-leak signal.
    markPluginWorkerWrapped(safePlugin, safeWorker);

    const child = spawn(cmd, wrappedArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      // Overlay the ASRT proxy env (none on mac/linux — proxy is baked into the
      // command string) onto the secret-stripped base env.
      env: buildWrappedWorkerEnv(baseEnv, env),
    });
    trackManagedChildProcess(child, { label: `worker:${safePlugin}:${safeWorker}:asrt` });

    // Idempotent any-exit cleanup (mirrors mcp-client runAsrtCleanupOnce):
    // whoever fires first (process exit/error/close OR stop()) runs it once.
    // Drops the reviewer marker, releases the shared-config UDS allow + the
    // per-command ASRT state, and removes the socket artifacts (crash-safe).
    let cleanupRan = false;
    const cleanupOnce = (): void => {
      if (cleanupRan) return;
      cleanupRan = true;
      unmarkPluginWorkerWrapped(safePlugin, safeWorker);
      void unregisterWorkerUnixSocketDir(socketDir);
      void cleanupAsrtSandboxAfterCommand();
      removeSocketArtifacts(socketPath, socketDir);
    };
    child.once("exit", cleanupOnce);
    child.once("error", cleanupOnce);
    child.once("close", cleanupOnce);

    return makeHandle(child, socketPath, cleanupOnce);
  } catch (err) {
    // FAIL CLOSED: wrap/spawn setup failed. Roll back the shared-config UDS
    // allow + socket artifacts so a failed spawn leaves no lingering allowance.
    // If the wrap had SUCCEEDED (failure was the post-wrap spawn / empty-argv),
    // also decrement ASRT's per-command state and drop the reviewer marker —
    // `cleanupOnce` never wired up, so the catch owns that teardown.
    if (wrapped) {
      unmarkPluginWorkerWrapped(safePlugin, safeWorker);
      void cleanupAsrtSandboxAfterCommand();
    }
    if (registered) void unregisterWorkerUnixSocketDir(socketDir);
    removeSocketArtifacts(socketPath, socketDir);
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/**
 * Compose the WRAPPED worker's env: the secret-stripped per-worker base env
 * plus ONLY the ASRT proxy/CA keys ASRT actually CHANGED relative to
 * `process.env` (none on mac/linux — proxy baked into the command string).
 * Mirrors mcp-client's buildWrappedStdioEnv.
 */
function buildWrappedWorkerEnv(
  baseEnv: NodeJS.ProcessEnv,
  wrappedEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const asrtComposed = buildSandboxedChildEnv(wrappedEnv);
  const safeBaseline = buildSandboxedChildEnv(process.env);
  const proxyOverlay: Record<string, string> = {};
  for (const [key, value] of Object.entries(asrtComposed)) {
    if (value === undefined) continue;
    if (safeBaseline[key] === value) continue;
    proxyOverlay[key] = value;
  }
  return { ...baseEnv, ...proxyOverlay };
}

/** Build the {@link SpawnedWorker} handle around a spawned child. */
function makeHandle(
  child: ChildProcess,
  socketPath: string | null,
  cleanup: () => void,
): SpawnedWorker {
  let stopped = false;
  return {
    socketPath,
    pid: child.pid,
    onStdout(listener: WorkerOutputListener): void {
      child.stdout?.on("data", (chunk: Buffer) => listener(chunk.toString("utf-8")));
    },
    onStderr(listener: WorkerOutputListener): void {
      child.stderr?.on("data", (chunk: Buffer) => listener(chunk.toString("utf-8")));
    },
    onExit(listener): void {
      child.once("exit", (code, signal) => listener({ code, signal }));
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      // Release ASRT/UDS state up front (idempotent with the exit handlers).
      cleanup();
      try {
        child.kill("SIGTERM");
        const force = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // Already gone.
          }
        }, 3000);
        child.once("exit", () => clearTimeout(force));
      } catch {
        // Already gone.
      }
    },
  };
}
