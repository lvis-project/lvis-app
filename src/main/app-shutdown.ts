/**
 * App shutdown cleanup pipeline.
 *
 * Runs the ordered teardown (persist window state → plugin shutdown handlers →
 * v2 shutdown routines → services shutdown → plugin runtime stopAll) under a
 * hard timeout so `app.quit()` can never hang indefinitely on a wedged
 * subsystem. Invoked from the `before-quit` orchestration that stays in
 * `src/main.ts`.
 */
import { app } from "electron";
import { createLogger, closeFileLogSink } from "../lib/logger.js";
import { logger as rootPinoLogger } from "../lib/logger.js";
import { runShutdownRoutines } from "./shutdown-routines.js";
import { stopLocalApiServer } from "./local-api-server.js";
import { unregisterAllGlobalShortcuts } from "./global-shortcuts.js";
import { forceKillManagedChildProcesses } from "./managed-child-processes.js";
import { killAllTerminals } from "./terminal/pty-manager.js";
import {
  resolveShutdownCleanupTimeoutMs,
  runCleanupWithHardTimeout,
} from "./shutdown-timeout.js";
import {
  getServices,
  getWindowManager,
  isAppShutdownCompleted,
  setAppShutdownCompleted,
  setAppShutdownStarted,
} from "./app-state.js";

const log = createLogger("lvis");

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Drain the pino transport queue before `app.exit(0)` hard-terminates.
 *
 * Without this the final "shutdown cleanup timed out" diagnostic — the
 * exact line audit needs to explain a force-kill — gets buffered and
 * dropped when the Electron process tears down. We give the flush a tiny
 * deadline so a wedged transport cannot itself defeat the timeout.
 */
async function flushLogger(): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    // Hard cap so a stuck transport can't defeat the timeout itself.
    const cap = setTimeout(finish, 500);
    cap.unref?.();
    try {
      rootPinoLogger.flush(() => {
        clearTimeout(cap);
        finish();
      });
    } catch {
      clearTimeout(cap);
      finish();
    }
  });
}

export type AppShutdownCleanupOutcome = "completed" | "skipped" | "timed-out" | "failed";
let appShutdownCleanupPromise: Promise<AppShutdownCleanupOutcome> | null = null;

export async function runAppShutdownCleanup(options: {
  reason: "before-quit" | "app-update-install";
  exitOnTimeout: boolean;
}): Promise<AppShutdownCleanupOutcome> {
  const services = getServices();
  if (!services || isAppShutdownCompleted()) return "skipped";
  if (appShutdownCleanupPromise) return appShutdownCleanupPromise;

  setAppShutdownStarted(true);
  const svc = services;
  const cleanupTimeoutMs = resolveShutdownCleanupTimeoutMs();
  appShutdownCleanupPromise = (async () => {
    const result = await runCleanupWithHardTimeout(async (signal) => {
      // E4 — release OS-level global shortcuts FIRST (fast, synchronous, cannot
      // throw past its own internal try/catch) so a wedged or throwing later
      // step can't leave accelerators bound after quit. Ordered ahead of
      // persistAll() specifically because persistAll() can throw — if it did,
      // an unregisterAll() placed after it would never run and the app would
      // quit with the global accelerator still claimed OS-wide (critic M1).
      unregisterAllGlobalShortcuts();
      // Persist window state next — it's a fast synchronous-ish operation
      // and if any later async step (shutdown routines / plugin stopAll)
      // hangs past the cleanup deadline we still don't lose the user's
      // last window layout. The remaining steps honor the AbortSignal so
      // they can break out of their inner loops when the deadline fires.
      getWindowManager()?.persistAll();
      if (signal.aborted) return;
      // Stop the opt-in local API server EARLY — it's fast (destroys idle
      // sockets + ends live SSE streams) and blanks its on-disk discovery file
      // so a stale secret + port never lingers after quit. Idempotent + a no-op
      // when the gate was off this boot.
      await stopLocalApiServer();
      if (signal.aborted) return;
      await svc.runPluginShutdownHandlers?.();
      if (signal.aborted) return;
      // v2 shutdown routines — fire all active shutdown-trigger routines with a
      // 5s timeout so a hung LLM call cannot block app.quit() indefinitely.
      await runShutdownRoutines(svc);
      if (signal.aborted) return;
      await svc.shutdown?.();
      if (signal.aborted) return;
      // Kill any live interactive PTY terminals (#1444). The pty children are
      // NOT in the managed-child tracker (node-pty's IPty is not a
      // ChildProcess), so force them down here on the graceful path.
      killAllTerminals();
      await svc.pluginRuntime.stopAll();
    }, cleanupTimeoutMs);

    if (result.status === "timed-out") {
      // Force-kill BEFORE the log line so killedChildCount reflects what
      // actually happened, not an optimistic pre-kill count.
      const killedChildCount = forceKillManagedChildProcesses(`${options.reason} cleanup timeout`);
      log.error({
        timeoutMs: cleanupTimeoutMs,
        killedChildCount,
        reason: options.reason,
      }, "shutdown cleanup timed out");
      // Flush the logger so the diagnostic above (and any preceding warn
      // about which subsystem hung) makes it to disk before the process leaves.
      await flushLogger();
      // LAST step: close the production log file sink. All shutdown-step
      // logging (including the timeout diagnostic just flushed) has now been
      // written, so it is safe to drain + close the file destination. Done
      // here rather than on a `before-quit` listener so those shutdown lines
      // are never dropped by an early sink close.
      closeFileLogSink();
      setAppShutdownCompleted(true);
      if (options.exitOnTimeout) {
        app.exit(0);
      }
      return "timed-out";
    }

    if (result.status === "failed") {
      log.error("%s: shutdown cleanup failed: %s", options.reason, errorMessage(result.error));
      await flushLogger();
      // LAST step (failed path): close the file sink after the failure
      // diagnostic has been flushed. See the timed-out branch above.
      closeFileLogSink();
      setAppShutdownCompleted(true);
      return "failed";
    }

    // LAST step (happy path): flush any remaining buffered logs, then close
    // the production log file sink after every shutdown step has logged.
    await flushLogger();
    closeFileLogSink();
    setAppShutdownCompleted(true);
    return "completed";
  })();

  return appShutdownCleanupPromise;
}
