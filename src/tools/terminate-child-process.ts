import type { ChildProcess } from "node:child_process";

type TerminableChild = Pick<ChildProcess, "exitCode" | "signalCode" | "kill">;

/**
 * Ask a child to stop, then force it down if SIGTERM has not produced an exit.
 *
 * `ChildProcess.killed` only means that Node successfully sent a signal. It
 * becomes true immediately after SIGTERM even while the process is still
 * alive, so it must not be used as the force-kill guard.
 */
export function terminateChildProcess(
  child: TerminableChild,
  forceAfterMs = 2_000,
): ReturnType<typeof setTimeout> {
  child.kill("SIGTERM");
  return setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }, forceAfterMs);
}
