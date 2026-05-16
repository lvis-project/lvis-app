import type { Routine, RoutineResult } from "../core/routine-engine.js";
import { createLogger } from "../lib/logger.js";
import type { FireOptions } from "./notification-service.js";
import type { RoutineRecord } from "../shared/routines-types.js";

const log = createLogger("lvis");

type ShutdownRoutinesStore = {
  listActive: () => RoutineRecord[];
  markFired: (id: string) => Promise<RoutineRecord | null>;
  update: (
    id: string,
    patch: Partial<Pick<RoutineRecord, "lastRoutineSessionId">>,
  ) => Promise<RoutineRecord | null>;
};

type ShutdownRoutineEngine = {
  runRoutine: (input: Routine) => Promise<RoutineResult>;
};

type ShutdownNotificationService = {
  fire: (opts: FireOptions) => void;
};

export interface ShutdownRoutineServices {
  routinesStore?: ShutdownRoutinesStore;
  routineEngine?: ShutdownRoutineEngine;
  notificationService?: ShutdownNotificationService;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runShutdownRoutines(
  svc: ShutdownRoutineServices,
  timeoutMs = 5000,
): Promise<void> {
  if (!svc.routinesStore || !svc.routineEngine) return;

  try {
    const shutdownRoutines = svc.routinesStore.listActive().filter(
      (routine) => routine.trigger === "shutdown",
    );
    for (const routine of shutdownRoutines) {
      let routineSessionId: string | undefined;
      try {
        if (routine.execution === "llm-session") {
          routineSessionId = await runLlmShutdownRoutine(svc.routineEngine, routine, timeoutMs);
        } else {
          svc.notificationService?.fire({
            kind: "routine",
            title: routine.notificationTitle ?? routine.title ?? "종료 루틴 알림",
            body: routine.notificationBody ?? "",
            contextRef: { routineId: routine.id },
          });
        }
      } catch (err) {
        log.warn("before-quit: shutdown routine failed (id=%s): %s", routine.id, errorMessage(err));
      }

      try {
        const fired = await svc.routinesStore.markFired(routine.id);
        if (fired && routineSessionId) {
          const updated = await svc.routinesStore.update(routine.id, { lastRoutineSessionId: routineSessionId });
          if (!updated) {
            log.warn("before-quit: shutdown routine session id persist failed (id=%s)", routine.id);
          }
        }
      } catch (markErr) {
        log.warn(
          "before-quit: markFired failed (id=%s): %s — routine may re-fire on next launch",
          routine.id,
          errorMessage(markErr),
        );
      }
    }
  } catch (err) {
    log.warn("before-quit: shutdown routines setup failed: %s", errorMessage(err));
  }
}

async function runLlmShutdownRoutine(
  routineEngine: ShutdownRoutineEngine,
  routine: RoutineRecord,
  timeoutMs: number,
): Promise<string | undefined> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort("shutdown timeout"), timeoutMs);
  try {
    const runResult = await routineEngine.runRoutine({
      id: routine.id,
      trigger: routine.trigger,
      prePrompt: routine.prePrompt ?? "",
      title: routine.title,
      scope: routine.scope,
      signal: controller.signal,
    });
    return runResult.sessionId;
  } catch (abortErr) {
    if (controller.signal.aborted) {
      log.warn("before-quit: shutdown routine aborted (5s timeout, id=%s)", routine.id);
      return undefined;
    }
    throw abortErr;
  } finally {
    clearTimeout(timeoutId);
  }
}
