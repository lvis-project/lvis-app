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
  try {
    child.kill("SIGTERM");
  } catch {
    // A failed graceful signal does not prove the child is gone. Keep the
    // escalation timer so a later force signal still has a chance to stop it.
  }
  const forceTimer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        // The caller retains lifecycle ownership until exit/close.
      }
    }
  }, forceAfterMs);
  const nodeTimer = forceTimer as ReturnType<typeof setTimeout> & { unref?: () => void };
  nodeTimer.unref?.();
  return forceTimer;
}
