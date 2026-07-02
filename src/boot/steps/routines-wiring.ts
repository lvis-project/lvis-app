/**
 * Boot step — RoutinesScheduler v2 branch wiring (§7, extracted from boot.ts
 * C18).
 *
 * Binds the scheduler's two execution branches: `onLlmSession` starts a
 * dedicated headless ConversationLoop turn (emitting running-started / finished
 * / failed / fired lifecycle events + persisting the routine session id), while
 * `onNotification` fires an OS notification. The scheduler is NOT started here —
 * main.ts calls `services.startRoutinesScheduler()` after IPC handlers attach.
 */
import { ROUTINES_V2 } from "../../shared/ipc-channels.js";
import { t } from "../../i18n/index.js";
import { createLogger } from "../../lib/logger.js";
import type { BootContext } from "../context.js";

const log = createLogger("lvis");

export function wireRoutinesScheduler(ctx: BootContext): void {
  const { routinesScheduler, routineEngine, routinesStore, getMainWindow, notificationService } = ctx;

  // RoutinesScheduler v2 — fires per due routine, branching on execution mode.
  // llm-session routines start a ConversationLoop with prePrompt.
  // notification-only routines fire an OS notification.
  routinesScheduler.onLlmSession(({ routine }) => {
    // Routine turns use a dedicated ConversationLoop but persist through the
    // normal session repository as sessionKind="routine".
    // Emit running-started/finished so renderer can show progress indicator.
    void (async () => {
      const firedAt = routine.lastFiredAt ?? new Date().toISOString();
      const title = routine.title ?? routine.notificationTitle ?? routine.id.slice(0, 8);

      // C1: runningStarted before the headless turn finishes — enriched payload
      // with title+firedAt so renderer can push a proper running OverlayItem
      // immediately. The completed event later carries the routineSessionId.
      try {
        getMainWindow()?.webContents.send(ROUTINES_V2.runningStarted, {
          routineId: routine.id,
          firedAt,
          title,
        });
      } catch {
        // non-fatal
      }

      let runSummary = "";
      let routineSessionId: string | undefined;
      try {
        const runResult = await routineEngine.runRoutine({
          id: routine.id,
          trigger: routine.trigger,
          prePrompt: routine.prePrompt ?? "",
          title: routine.title,
          scope: routine.scope,
          firedAt,
        });
        runSummary = runResult.summary;
        routineSessionId = runResult.sessionId;
        if (routineSessionId) {
          const updated = await routinesStore.update(routine.id, { lastRoutineSessionId: routineSessionId });
          if (!updated) {
            log.warn("routines v2 llm-session session id persist failed: routine not found (%s)", routine.id);
          }
        }
      } catch (err) {
        log.warn("routines v2 llm-session run failed: %s", (err as Error).message);
        // Emit failed so renderer knows to clear running state.
        try {
          getMainWindow()?.webContents.send(ROUTINES_V2.failed, {
            routineId: routine.id,
            error: (err as Error).message,
          });
        } catch {
          // non-fatal
        }
      } finally {
      // Always clear running state regardless of success/failure.
        try {
          getMainWindow()?.webContents.send(ROUTINES_V2.runningFinished, routine.id);
        } catch {
          // non-fatal
        }
      }
      // Use LLM response summary directly — no extractSummary needed.
      const summary = runSummary;
      // Explicit allowlist payload — no ...routine spread to prevent PII leak.
      try {
        getMainWindow()?.webContents.send(ROUTINES_V2.fired, {
          id: routine.id,
          trigger: routine.trigger,
          execution: routine.execution,
          firedAt,
          title,
          summary,
          ...(routineSessionId ? { routineSessionId } : {}),
        } satisfies import("../../shared/routines-types.js").RoutineFiredPayload);
      } catch (err) {
        log.warn("routines v2 llm-session emit failed: %s", (err as Error).message);
      }
    })();
  });
  routinesScheduler.onNotification(({ routine }) => {
    try {
      notificationService.fire({
        kind: "routine",
        title: routine.notificationTitle ?? routine.title ?? t("be_boot.routineNotificationFallbackTitle"),
        body: routine.notificationBody ?? "",
        contextRef: { routineId: routine.id },
      });
    } catch (err) {
      log.warn("routines v2 notification emit failed: %s", (err as Error).message);
    }
    // Emit fired event for notification-only branch so the UI reflects the
    // fire consistently across both execution modes.
    // Explicit allowlist — no ...routine spread to prevent prePrompt/notificationBody leak.
    try {
      const firedAt = routine.lastFiredAt ?? new Date().toISOString();
      const title = routine.title ?? routine.notificationTitle ?? routine.id.slice(0, 8);
      getMainWindow()?.webContents.send(ROUTINES_V2.fired, {
        id: routine.id,
        trigger: routine.trigger,
        execution: routine.execution,
        firedAt,
        title,
        summary: "",
      } satisfies import("../../shared/routines-types.js").RoutineFiredPayload);
    } catch (err) {
      log.warn("routines v2 notification fired emit failed: %s", (err as Error).message);
    }
  });
  // L1: NOT started here. Boot order matters — if scheduler.start() runs
  // before the renderer has its IPC listeners attached, a past-due
  // routine fires immediately into a void. main.ts now invokes
  // `services.startRoutinesScheduler()` AFTER `registerIpcHandlers()` to
  // close that gap.
}
