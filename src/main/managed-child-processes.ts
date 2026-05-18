import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createLogger } from "../lib/logger.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";

const log = createLogger("lvis");
const PROCESS_TREE_KILL_TIMEOUT_MS = TOOL_TIMEOUT_POLICY.processTreeKillMs;
const DETACHED_PROCESS_GROUP_POLL_MS = TOOL_TIMEOUT_POLICY.processGroupPollMs;
const PROCESS_GROUP_DISPOSAL_MAX_MS = TOOL_TIMEOUT_POLICY.processGroupDisposalMaxMs;

interface ManagedChildProcess {
  child: ChildProcess;
  label: string;
  killProcessGroup: boolean;
  processGroupId?: number;
  disposeTimer?: NodeJS.Timeout;
  disposalStartedAt?: number;
  dispose: () => void;
  onSettled: () => void;
}

const managedChildren = new Set<ManagedChildProcess>();

export interface TrackManagedChildProcessOptions {
  label?: string;
  killProcessGroup?: boolean;
}

/**
 * Spawn a child process and register it with the managed-children
 * tracker in one step. Prefer this helper over raw `spawn(...) +
 * trackManagedChildProcess(...)` so that newly added callsites cannot
 * silently regress force-kill coverage on Quit.
 *
 * `trackOptions.killProcessGroup` defaults to true when `options.detached`
 * is true on POSIX — detached children form their own process group that
 * tree-kill via SIGTERM/SIGKILL does not reach by default. Callers can
 * still override the inference (e.g. for child processes whose lifetime
 * is fully managed by an external supervisor).
 */
export function spawnManaged(
  command: string,
  args: ReadonlyArray<string>,
  spawnOptions: SpawnOptions,
  trackOptions: TrackManagedChildProcessOptions = {},
): ChildProcess {
  // ESLint-style guardrail: callers MUST go through this helper. Direct
  // `spawn()` imports outside of `managed-child-processes.ts` should be
  // flagged by a future lint rule (`no-restricted-imports` allowlisting
  // this module only).
  const child = spawn(command, args, spawnOptions);
  const inferredGroupKill =
    spawnOptions.detached === true && process.platform !== "win32";
  trackManagedChildProcess(child, {
    label: trackOptions.label,
    killProcessGroup: trackOptions.killProcessGroup ?? inferredGroupKill,
  });
  return child;
}

export function trackManagedChildProcess(
  child: ChildProcess,
  options: TrackManagedChildProcessOptions = {},
): () => void {
  if (typeof child.once !== "function" || typeof child.off !== "function") {
    return () => {};
  }

  const entry: ManagedChildProcess = {
    child,
    label: options.label ?? "child-process",
    killProcessGroup: options.killProcessGroup === true,
    processGroupId: options.killProcessGroup === true &&
      process.platform !== "win32" &&
      typeof child.pid === "number" &&
      child.pid > 0
      ? child.pid
      : undefined,
    dispose: () => {},
    onSettled: () => {},
  };

  const dispose = (): void => {
    managedChildren.delete(entry);
    if (entry.disposeTimer) clearTimeout(entry.disposeTimer);
    child.off("exit", entry.onSettled);
    child.off("close", entry.onSettled);
    child.off("error", entry.onSettled);
  };
  const onSettled = (): void => {
    if (entry.processGroupId !== undefined && processGroupExists(entry.processGroupId)) {
      scheduleProcessGroupDisposal(entry);
      return;
    }
    entry.dispose();
  };
  entry.dispose = dispose;
  entry.onSettled = onSettled;

  managedChildren.add(entry);
  child.once("exit", onSettled);
  child.once("close", onSettled);
  child.once("error", onSettled);
  return dispose;
}

export function getManagedChildProcessCount(): number {
  return managedChildren.size;
}

export function forceKillManagedChildProcesses(reason: string): number {
  let killed = 0;

  for (const entry of [...managedChildren]) {
    const { child, label, killProcessGroup } = entry;
    if (!isKillable(entry)) {
      entry.dispose();
      continue;
    }

    try {
      const pid = child.pid;
      forceKillProcessTree(child, killProcessGroup, entry.processGroupId);
      killed += 1;
      log.warn({ pid: pid ?? null, label, killProcessGroup, reason }, "shutdown: force killed managed child process");
    } catch (err) {
      log.warn({
        pid: child.pid ?? null,
        label,
        killProcessGroup,
        reason,
        err: err instanceof Error ? err.message : String(err),
      }, "shutdown: managed child process force kill failed");
    } finally {
      entry.dispose();
    }
  }

  return killed;
}

export function __resetManagedChildProcessesForTest(): void {
  for (const entry of [...managedChildren]) entry.dispose();
  managedChildren.clear();
}

function isKillable(entry: ManagedChildProcess): boolean {
  if (entry.processGroupId !== undefined && processGroupExists(entry.processGroupId)) return true;
  return entry.child.exitCode === null;
}

function scheduleProcessGroupDisposal(entry: ManagedChildProcess): void {
  if (entry.disposeTimer) return;
  if (entry.disposalStartedAt === undefined) entry.disposalStartedAt = Date.now();

  const poll = (): void => {
    entry.disposeTimer = undefined;
    if (entry.processGroupId === undefined || !processGroupExists(entry.processGroupId)) {
      entry.dispose();
      return;
    }
    const elapsed = Date.now() - (entry.disposalStartedAt ?? Date.now());
    if (elapsed >= PROCESS_GROUP_DISPOSAL_MAX_MS) {
      // Unkillable process group (typically a setuid descendant or one
      // that crossed a uid boundary). Force-dispose the entry so the
      // managed-children Set does not retain it for the lifetime of the
      // host process — the original child has already exited.
      log.warn({
        label: entry.label,
        processGroupId: entry.processGroupId,
        elapsedMs: elapsed,
      }, "managed-child: process group disposal exceeded max wall-clock, force-disposing entry");
      entry.dispose();
      return;
    }
    entry.disposeTimer = setTimeout(poll, DETACHED_PROCESS_GROUP_POLL_MS);
    entry.disposeTimer.unref?.();
  };

  entry.disposeTimer = setTimeout(poll, DETACHED_PROCESS_GROUP_POLL_MS);
  entry.disposeTimer.unref?.();
}

/**
 * Probe whether a detached process group is still around.
 *
 * `process.kill(-pgid, 0)` returns iff signal 0 was delivered successfully.
 * Errors map as:
 *   - ESRCH → group is gone (true negative)
 *   - EPERM → group exists but is owned by a foreign uid (still around,
 *     conservatively keep polling)
 *   - anything else (EINVAL on some BSDs, generic Error from NaN pid) →
 *     treat as "still around" so we err on the side of completing the
 *     disposal poll rather than prematurely freeing the entry while the
 *     group is actually alive.
 */
function processGroupExists(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code !== "ESRCH";
  }
}

function forceKillProcessTree(
  child: ChildProcess,
  killProcessGroup: boolean,
  processGroupId?: number,
): void {
  const pid = child.pid;

  if (killProcessGroup && process.platform !== "win32" && processGroupId !== undefined) {
    process.kill(-processGroupId, "SIGKILL");
    return;
  }

  if (typeof pid !== "number" || pid <= 0) {
    child.kill("SIGKILL");
    return;
  }

  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
      timeout: PROCESS_TREE_KILL_TIMEOUT_MS,
    });
    if (result.status === 0) return;
  } else {
    for (const descendantPid of collectDescendantPids(pid).reverse()) {
      try {
        process.kill(descendantPid, "SIGKILL");
      } catch {
        // Already exited or inaccessible.
      }
    }
  }

  child.kill("SIGKILL");
}

function collectDescendantPids(rootPid: number): number[] {
  const descendants: number[] = [];
  const seen = new Set<number>([rootPid]);
  const stack = [rootPid];

  while (stack.length > 0) {
    const pid = stack.pop() as number;
    for (const childPid of listDirectChildPids(pid)) {
      if (seen.has(childPid)) continue;
      seen.add(childPid);
      descendants.push(childPid);
      stack.push(childPid);
    }
  }

  return descendants;
}

function listDirectChildPids(pid: number): number[] {
  const result = spawnSync("pgrep", ["-P", String(pid)], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: PROCESS_TREE_KILL_TIMEOUT_MS,
  });
  if (result.status !== 0 || !result.stdout) return [];
  return result.stdout
    .split(/\s+/)
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);
}
