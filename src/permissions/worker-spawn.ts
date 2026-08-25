/**
 * Host-mediated long-lived plugin-worker spawn primitive.
 *
 * ⚠️ HOST PRIMITIVE — TOOL PRODUCER NOT WIRED YET ⚠️
 * {@link spawnWorker} is the host half of worker-confinement-via-ASRT for an
 * HTTP plugin worker the HOST connects INBOUND to. It is added to the host +
 * hostApi surface here, but no production Tool descriptor is host-routed
 * through it yet. No manifest worker-routing field is accepted; a future
 * producer must introduce a Host-owned contract instead of reviving one.
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
 *   - Windows: no reliable UDS-bind primitive, so the worker keeps its TCP
 *     control channel. ASRT 0.0.73 cannot accept per-exec filesystem
 *     allowRead/allowWrite, but it DOES expose a live ACL grant primitive
 *     keyed by holder PID. The host therefore creates a dedicated holder
 *     process per worker, applies explicit worker-scoped read/write grants to
 *     that holder, wraps the command through srt-win, and revokes the grant on
 *     worker cleanup. No shared all-plugin data grant is ever used.
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
 * <workerId>/` — host-allocated from the host-bound pluginId and sanitized
 * workerId. mkdir 0o700; the worker binds the socket 0o600.
 *
 * GATE DEFAULT-OFF: when {@link isAsrtSandboxActive} is false, this is a plain
 * spawn of the exact command with the same secret-stripped worker env and returns
 * `socketPath: null` so the consumer falls back to the legacy TCP channel. No
 * UDS dir is created, nothing is wrapped.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { unlinkSync, rmdirSync, chmodSync, lstatSync } from "node:fs";
import { join, resolve as pathResolve } from "node:path";

import { lvisHome } from "../shared/lvis-home.js";
import {
  assertUnixSocketPathFits,
  PLUGIN_WORKER_RUN_DIR_NAME,
} from "../plugins/plugin-storage-layout.js";
import { buildSafeChildEnv } from "../tools/safe-env.js";
import { spawnConfinedChild } from "./confined-child.js";
import { terminateChildProcess } from "../tools/terminate-child-process.js";
import {
  assertManagedChildProcessAdmissionOpen,
  trackManagedChildProcess,
} from "../main/managed-child-processes.js";
import { createSandboxProcessHome } from "./sandbox-process-home.js";
import {
  isAsrtSandboxActive,
  cleanupAsrtSandboxAfterCommand,
  registerWorkerUnixSocketDir,
  unregisterWorkerUnixSocketDir,
  grantWindowsWorkerFilesystemAccess,
  type WindowsWorkerFilesystemGrant,
} from "./asrt-sandbox.js";
import {
  markPluginWorkerWrapped,
  unmarkPluginWorkerWrapped,
} from "./sandbox-capability.js";

/** Listener registered through {@link SpawnedWorker.onStdout}/`onStderr`. */
export type WorkerOutputListener = (chunk: string) => void;

/**
 * The spec the HOST hands {@link spawnWorker}. The hostApi factory binds
 * `pluginId` from the calling plugin instance; workerId/command/grant paths are
 * declared by trusted first-party plugin code and reviewed at the HostApi effect
 * boundary. `allowWritePaths` is the worker's filesystem write-jail; the
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
  /**
   * Paths the worker may read in addition to write-granted paths. This is
   * explicit by design: host code must declare trusted worker code/runtime
   * paths instead of the spawn primitive inferring path grants from argv.
   */
  readonly allowReadPaths?: readonly string[];
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

const activeWrappedWorkerKeys = new Set<string>();

function wrappedWorkerKey(pluginId: string, workerId: string): string {
  return `${pluginId.length}:${pluginId}:${workerId}`;
}

function reserveWrappedWorker(pluginId: string, workerId: string): () => void {
  const key = wrappedWorkerKey(pluginId, workerId);
  if (activeWrappedWorkerKeys.has(key)) {
    throw new Error(
      `[worker-spawn] worker ${pluginId}/${workerId} is already running or stopping`,
    );
  }
  activeWrappedWorkerKeys.add(key);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeWrappedWorkerKeys.delete(key);
  };
}

/** Test-only reset for mocked children that do not emit a definitive exit. */
export function __resetActiveWrappedWorkersForTest(): void {
  activeWrappedWorkerKeys.clear();
}

/**
 * The handle {@link spawnWorker} returns. `socketPath` is the host-side path to
 * connect to (undici `Agent({ connect: { socketPath } })` / `http.request({
 * socketPath })`) — or `null` when the worker should use TCP control. `null`
 * means gate-OFF plain spawn; callers must not infer sandbox status from
 * transport alone.
 */
export interface SpawnedWorker {
  /** Host-side UDS path, or null when the worker uses TCP control. */
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

const SAFE_WORKER_SEGMENT = /^[a-z0-9][a-z0-9._-]{0,127}$/;

/** Validate an id as one unambiguous path/registry segment. */
function safeSegment(id: string, kind: string): string {
  if (typeof id !== "string" || !SAFE_WORKER_SEGMENT.test(id)) {
    throw new Error(
      `[worker-spawn] invalid ${kind} '${String(id)}' ` +
        "(expected 1-128 lowercase characters matching [a-z0-9][a-z0-9._-]*)",
    );
  }
  return id;
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

function windowsSystemRoot(): string {
  const root = process.env.SystemRoot ?? process.env.WINDIR;
  if (root === undefined || root.trim().length === 0) {
    throw new Error("[worker-spawn] cannot start Windows ACL grant holder: SystemRoot is unset");
  }
  return root.replace(/[\\/]+$/, "");
}

function windowsSystem32Path(fileName?: string): string {
  const system32 = `${windowsSystemRoot()}\\System32`;
  return fileName === undefined ? system32 : `${system32}\\${fileName}`;
}

function windowsHolderEnv(): NodeJS.ProcessEnv {
  const root = windowsSystemRoot();
  return {
    SystemRoot: root,
    WINDIR: root,
  };
}

function startWindowsAclGrantHolder(label: string): ChildProcess {
  const system32 = windowsSystem32Path();
  assertManagedChildProcessAdmissionOpen(label);
  const child = spawn(windowsSystem32Path("more.com"), [], {
    cwd: system32,
    stdio: ["pipe", "ignore", "ignore"],
    shell: false,
    windowsHide: true,
    env: windowsHolderEnv(),
  });
  if (child.pid === undefined) {
    child.once("error", () => {
      // The synchronous throw below is the fail-closed signal for this path.
      // Keep the later async spawn error from becoming an unhandled event.
    });
    try {
      child.kill("SIGTERM");
    } catch {
      // Spawn failed before pid publication.
    }
    throw new Error("[worker-spawn] Windows ACL grant holder started without a pid");
  }
  trackManagedChildProcess(child, { label });
  return child;
}

function stopWindowsAclGrantHolder(child: ChildProcess): void {
  try {
    child.stdin?.end();
  } catch {
    // Already closed.
  }
  terminateChildBestEffort(child);
}

function terminateChildBestEffort(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    const forceTimer = terminateChildProcess(child, 3_000);
    const clearForceTimer = (): void => clearTimeout(forceTimer);
    child.once("exit", clearForceTimer);
    child.once("close", clearForceTimer);
  } catch {
    // Already gone.
  }
}

function definedEnv(env: NodeJS.ProcessEnv | undefined): Record<string, string> {
  const extra: Record<string, string> = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (value !== undefined) extra[key] = value;
  }
  return extra;
}

/**
 * Spawn a long-lived plugin worker, host-mediated and (gate ON) ASRT-wrapped
 * with a bind-mounted UDS control channel. See the module header for the model.
 *
 * @returns a {@link SpawnedWorker}. `socketPath` is non-null only on the wrapped
 *   mac/linux UDS path; null covers gate-OFF plain TCP and the Windows ASRT
 *   wrapped path, which keeps TCP control while filesystem/network effects run
 *   under srt-win.
 */
export async function spawnWorker(spec: SpawnWorkerSpec): Promise<SpawnedWorker> {
  const safePlugin = safeSegment(spec.pluginId, "pluginId");
  const safeWorker = safeSegment(spec.workerId, "workerId");
  const args = [...(spec.args ?? [])];

  // Secret-stripped base env (Least Privilege), shared with other child process
  // spawners so Windows runtime variables stay complete without forwarding
  // provider/API-key secrets.
  const baseEnv: NodeJS.ProcessEnv = buildSafeChildEnv(definedEnv(spec.env));

  // ── Gate OFF → plain unwrapped spawn ────────────────────────────────
  if (!isAsrtSandboxActive()) {
    assertManagedChildProcessAdmissionOpen(`worker:${safePlugin}:${safeWorker}`);
    const child = spawn(spec.command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      env: baseEnv,
    });
    trackManagedChildProcess(child, { label: `worker:${safePlugin}:${safeWorker}` });
    return makeHandle(child, null);
  }

  // A wrapped worker owns a stable per-(plugin,worker) control path. Keep that
  // key reserved while it is running OR stopping; otherwise a replacement can
  // lose its marker, shared UDS allowance, and socket when the old exit arrives.
  const releaseWorkerReservation = reserveWrappedWorker(safePlugin, safeWorker);

  if (process.platform === "win32") {
    let holder: ChildProcess;
    try {
      holder = startWindowsAclGrantHolder(
        `worker:${safePlugin}:${safeWorker}:asrt-win-acl`,
      );
    } catch (err) {
      releaseWorkerReservation();
      throw err;
    }
    const holderPid = holder.pid;
    if (holderPid === undefined) {
      stopWindowsAclGrantHolder(holder);
      releaseWorkerReservation();
      throw new Error("[worker-spawn] Windows ACL grant holder started without a pid");
    }
    let sandboxHome: ReturnType<typeof createSandboxProcessHome>;
    try {
      sandboxHome = createSandboxProcessHome();
    } catch (err) {
      stopWindowsAclGrantHolder(holder);
      releaseWorkerReservation();
      throw err instanceof Error ? err : new Error(String(err));
    }
    let grant: WindowsWorkerFilesystemGrant | undefined;
    let wrapped = false;
    let marked = false;
    let child: ChildProcess | undefined;
    let grantReleased = false;
    let asrtCleanupRequested = false;
    let holderStopped = false;
    let holderFailure: Error | undefined;
    const cleanupResources = (): void => {
      if (marked) {
        marked = false;
        unmarkPluginWorkerWrapped(safePlugin, safeWorker);
      }
      if (wrapped && !asrtCleanupRequested) {
        asrtCleanupRequested = true;
        void cleanupAsrtSandboxAfterCommand();
      }
      if (grant !== undefined && !grantReleased) {
        grantReleased = true;
        try {
          grant.release();
        } catch {
          // Cleanup must continue even if ASRT reports the grant was already gone.
        }
      }
      if (!holderStopped) {
        holderStopped = true;
        stopWindowsAclGrantHolder(holder);
      }
    };
    const finalizeResources = (): void => {
      cleanupResources();
      sandboxHome.cleanup();
      releaseWorkerReservation();
    };
    const holderDied = (first?: unknown, second?: unknown): void => {
      if (holderStopped) return;
      holderStopped = true;
      holderFailure =
        first instanceof Error
          ? first
          : new Error(
              `[worker-spawn] Windows ACL grant holder exited before worker cleanup ` +
                `(code=${String(first ?? "null")} signal=${String(second ?? "null")})`,
            );
      if (child !== undefined) {
        terminateChildBestEffort(child);
      } else {
        cleanupResources();
        sandboxHome.cleanup();
        releaseWorkerReservation();
      }
    };
    const assertHolderAlive = (): void => {
      if (holderFailure !== undefined) throw holderFailure;
    };
    holder.once("exit", holderDied);
    holder.once("error", holderDied);
    try {
      grant = await grantWindowsWorkerFilesystemAccess({
        holderPid,
        allowRead: [sandboxHome.path, ...(spec.allowReadPaths ?? [])],
        allowWrite: [sandboxHome.path, ...(spec.allowWritePaths ?? [])],
      });
      assertHolderAlive();

      // Windows grants reachability through ACLs against the holder process,
      // so the wrap carries the deny floor only.
      child = await spawnConfinedChild({
        command: spec.command,
        args,
        label: `worker:${safePlugin}:${safeWorker}:asrt-win`,
        grantMode: "deny-only",
        baseEnv,
        extraEnv: { ...sandboxHome.env },
        assertStillValid: assertHolderAlive,
        onWrapped: () => {
          wrapped = true;
          markPluginWorkerWrapped(safePlugin, safeWorker);
          marked = true;
        },
      });
      child.once("exit", finalizeResources);
      child.once("error", () => {
        // `error` can mean signal/message delivery failed while the child is
        // still alive. Definitive resource finalization stays on exit/close.
      });
      child.once("close", finalizeResources);
      assertHolderAlive();

      return makeHandle(child, null);
    } catch (err) {
      if (child !== undefined) {
        terminateChildBestEffort(child);
      } else {
        cleanupResources();
        sandboxHome.cleanup();
        releaseWorkerReservation();
      }
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  // ── Gate ON, mac/linux → ASRT-wrapped with a bind-mounted UDS ──
  // socketDir under the plugin's OWN sandbox root (storage-namespace rule),
  // host-controlled. mkdir 0o700; the worker binds the socket 0o600.
  const socketDir = pathResolve(
    lvisHome(),
    "plugins",
    safePlugin,
    PLUGIN_WORKER_RUN_DIR_NAME,
    safeWorker,
  );
  const socketPath = join(socketDir, "control.sock");
  // A path over `sun_path` fails as `EINVAL` — "malformed address" — which
  // sends the diagnosis anywhere but at a length. Checked here, where the path
  // was just assembled and the message can name every part of it.
  assertUnixSocketPathFits(socketPath, `worker control socket for ${safePlugin}/${safeWorker}`);
  // Crash-safe: unlink any stale socket from a previous worker that died
  // without cleanup BEFORE recreating the dir.
  try {
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
  } catch (err) {
    releaseWorkerReservation();
    throw err instanceof Error ? err : new Error(String(err));
  }

  let sandboxHome: ReturnType<typeof createSandboxProcessHome>;
  try {
    sandboxHome = createSandboxProcessHome();
  } catch (err) {
    removeSocketArtifacts(socketPath, socketDir);
    releaseWorkerReservation();
    throw err instanceof Error ? err : new Error(String(err));
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
  const allowWrite = [socketDir, sandboxHome.path, ...(spec.allowWritePaths ?? [])];
  const tmpDir = process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP;
  const allowRead = [
    socketDir,
    sandboxHome.path,
    ...(spec.allowReadPaths ?? []),
    ...(spec.allowWritePaths ?? []),
    ...(tmpDir ? [tmpDir] : []),
  ];

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
    // path with spaces/metacharacters cannot mis-split. ASRT runs this branch
    // under a POSIX shell (mac/linux). The per-command wrap carries ONLY the
    // filesystem jail (the `--bind`).
    const child = await spawnConfinedChild({
      command: spec.command,
      args,
      label: `worker:${safePlugin}:${safeWorker}:asrt`,
      grantMode: "allow-list",
      allowRead,
      allowWrite,
      baseEnv,
      extraEnv: { ...sandboxHome.env },
      onWrapped: () => {
        // The wrap incremented ASRT's per-command state (Linux
        // activeSandboxCount, proxy ref); from here a failure MUST decrement
        // it (see the catch).
        wrapped = true;
        // Mark the reviewer wrapped-registry: this worker genuinely runs under
        // ASRT. Keyed plugin-scoped (NOT workerId alone) so two plugins sharing
        // a workerId (e.g. "main") cannot collide into a false `asrt`
        // no-leak signal.
        markPluginWorkerWrapped(safePlugin, safeWorker);
      },
    });
    trackManagedChildProcess(child, { label: `worker:${safePlugin}:${safeWorker}:asrt` });

    // Idempotent definitive-termination cleanup (mirrors mcp-client): exit or
    // close runs it once. A stop request and process-operation error retain
    // ownership because neither proves the child is dead.
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
    const finalizeOnce = (): void => {
      cleanupOnce();
      sandboxHome.cleanup();
      releaseWorkerReservation();
    };
    child.once("exit", finalizeOnce);
    child.once("error", () => {
      // A process-operation error is not proof of death. `close` is the
      // asynchronous-spawn-failure finalizer; live children finalize on exit.
    });
    child.once("close", finalizeOnce);

    return makeHandle(child, socketPath);
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
    sandboxHome.cleanup();
    removeSocketArtifacts(socketPath, socketDir);
    releaseWorkerReservation();
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/**
 * Compose the WRAPPED worker's env: the secret-stripped per-worker base env
 * plus ONLY the ASRT proxy/CA keys ASRT actually CHANGED relative to
 * `process.env` (none on mac/linux — proxy baked into the command string).
 * Mirrors mcp-client's buildWrappedStdioEnv.
 */
/** Build the {@link SpawnedWorker} handle around a spawned child. */
function makeHandle(
  child: ChildProcess,
  socketPath: string | null,
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
      // Keep ASRT/UDS/HOME ownership until definitive child termination.
      // A TERM-ignoring worker is escalated without releasing its confinement.
      terminateChildBestEffort(child);
    },
  };
}
