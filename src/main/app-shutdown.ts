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
import { stopTailnetObserverServer } from "./tailnet-surface-server.js";
import { stopTelegramBridgeServer } from "./telegram-bridge-server.js";
import { stopRemoteA2AReceiverServer } from "./a2a-remote-receiver-server.js";
import { stopSubscriptionRuntimes } from "./subscription-runtime-service.js";
import { unregisterAllGlobalShortcuts } from "./global-shortcuts.js";
import {
  forceKillAndDrainManagedChildProcesses,
  forceKillManagedChildProcesses,
  sealManagedChildProcessAdmission,
} from "./managed-child-processes.js";
import { forceKillAllTerminalsForShutdown } from "./terminal/pty-manager.js";
import {
  resolveShutdownCleanupTimeoutMs,
  runCleanupWithHardTimeout,
} from "./shutdown-timeout.js";
import {
  getServices,
  isAppShutdownCompleted,
  setAppShutdownCompleted,
  setAppShutdownStarted,
} from "./app-state.js";
import { peekFloatingDock } from "../boot/steps/plugin-runtime/host-api-factory.js";
import { errorMessage } from "../shared/error-message.js";

const log = createLogger("lvis");

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
  sealManagedChildProcessAdmission(options.reason);
  const svc = services;
  const cleanupTimeoutMs = resolveShutdownCleanupTimeoutMs(
    svc.settingsService.get("system")?.shutdownCleanupTimeoutMs,
  );
  appShutdownCleanupPromise = (async () => {
    const result = await runCleanupWithHardTimeout(async (signal) => {
      // A subscription runtime owns long-lived child processes. Keep it alive
      // through plugin/routine teardown in the normal path, but do not leave
      // it behind when an earlier shutdown stage throws or observes the hard
      // timeout signal. The fallback stop failure is deliberately contained so
      // it cannot mask the stage failure that caused this cleanup to fail.
      let subscriptionRuntimesStopped = false;
      try {
      // E4 — release OS-level global shortcuts FIRST (fast, synchronous, cannot
      // throw past its own internal try/catch) so a wedged or throwing later
      // step can't leave accelerators bound after quit.
      unregisterAllGlobalShortcuts();
      // Same reasoning, same position: the floating dock is an always-on-top
      // window that outlives the app window by design. If a later stage wedges
      // or the hard timeout fires, a dock left up is a window floating over
      // everything with no process behind it. Synchronous, idempotent, and a
      // no-op when nothing ever attached — `peekFloatingDock` does not build
      // one just to tear it down.
      peekFloatingDock()?.shutdown();
      if (signal.aborted) return;
      // Stop the opt-in local API server EARLY — it's fast (destroys idle
      // sockets + ends live SSE streams) and blanks its on-disk discovery file
      // so a stale secret + port never lingers after quit. Idempotent + a no-op
      // when the gate was off this boot.
      await stopLocalApiServer();
      if (signal.aborted) return;
      // Tailnet observer is a separate listener over the shared projection.
      // Close its SSE streams before the host conversation runtime is disposed.
      await stopTailnetObserverServer();
      if (signal.aborted) return;

      // Telegram is a distinct external-platform ingress/egress adapter. Its
      // runtime guard is revoked before the shared conversation services go
      // down, so a late webhook or queued delivery cannot outlive shutdown.
      await stopTelegramBridgeServer();
      if (signal.aborted) return;

      // Independent P4-5 listener: close it before the owning remote runtime
      // is disposed by services.shutdown(). This is a no-op when its gate was
      // OFF and is idempotent on repeated cleanup attempts.
      await stopRemoteA2AReceiverServer();
      if (signal.aborted) return;
      await svc.runPluginShutdownHandlers?.();
      if (signal.aborted) return;
      // v2 shutdown routines — fire all active shutdown-trigger routines with a
      // 5s timeout so a hung LLM call cannot block app.quit() indefinitely.
      await runShutdownRoutines(svc);
      if (signal.aborted) return;
      // Plugin shutdown handlers and shutdown-trigger routines may make normal
      // host LLM calls. Keep the subscription runtime live for both, then stop
      // it immediately at the service-shutdown boundary so no later teardown
      // can create a new text session.
      await stopSubscriptionRuntimes();
      subscriptionRuntimesStopped = true;
      if (signal.aborted) return;
      await svc.shutdown?.();
      if (signal.aborted) return;
      // Kill any live interactive PTY terminals (#1444). The pty children are
      // NOT in the managed-child tracker (node-pty's IPty is not a
      // ChildProcess), so force them down here on the graceful path.
      await forceKillAllTerminalsForShutdown();
      await svc.pluginRuntime.stopAll();
      if (signal.aborted) return;
      // Runtime stop hooks can return after scheduling TERM→KILL. Keep the app
      // alive for a bounded definitive-exit drain so ASRT/HOME finalizers run
      // before Electron completes an otherwise clean shutdown.
      await forceKillAndDrainManagedChildProcesses(`${options.reason} graceful shutdown`);
      } finally {
        if (!subscriptionRuntimesStopped) {
          try {
            await stopSubscriptionRuntimes();
          } catch {
            // Preserve the original shutdown-stage failure. The failed branch
            // below performs a managed-child force-kill as the final fallback.
            log.warn("shutdown: subscription runtime fallback stop failed");
          }
        }
      }
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
      // A failed lifecycle stage may have prevented a runtime-owned child from
      // acknowledging its graceful stop. The normal stop ran in the cleanup
      // finally block; this is only the last-resort descendant-safe backstop.
      const killedChildCount = forceKillManagedChildProcesses(`${options.reason} cleanup failed`);
      log.error(
        { killedChildCount },
        "%s: shutdown cleanup failed: %s",
        options.reason,
        errorMessage(result.error),
      );
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
