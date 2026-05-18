import { spawnSync, type ChildProcess } from "node:child_process";
import { createLogger } from "../lib/logger.js";

const log = createLogger("lvis");
const PROCESS_TREE_KILL_TIMEOUT_MS = 1000;

interface ManagedChildProcess {
  child: ChildProcess;
  label: string;
  killProcessGroup: boolean;
  dispose: () => void;
}

const managedChildren = new Set<ManagedChildProcess>();

export interface TrackManagedChildProcessOptions {
  label?: string;
  killProcessGroup?: boolean;
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
    dispose: () => {},
  };

  const dispose = (): void => {
    managedChildren.delete(entry);
    child.off("exit", dispose);
    child.off("close", dispose);
    child.off("error", dispose);
  };
  entry.dispose = dispose;

  managedChildren.add(entry);
  child.once("exit", dispose);
  child.once("close", dispose);
  child.once("error", dispose);
  return dispose;
}

export function getManagedChildProcessCount(): number {
  return managedChildren.size;
}

export function forceKillManagedChildProcesses(reason: string): number {
  let killed = 0;

  for (const entry of [...managedChildren]) {
    const { child, label, killProcessGroup } = entry;
    if (child.exitCode !== null) {
      entry.dispose();
      continue;
    }

    try {
      const pid = child.pid;
      forceKillProcessTree(child, killProcessGroup);
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

function forceKillProcessTree(child: ChildProcess, killProcessGroup: boolean): void {
  const pid = child.pid;
  if (typeof pid !== "number" || pid <= 0) {
    child.kill("SIGKILL");
    return;
  }

  if (killProcessGroup && process.platform !== "win32") {
    process.kill(-pid, "SIGKILL");
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
