/**
 * Routine IPC handlers — `lvis:routines:*`.
 *
 * CRUD over the persisted routine list plus the two read paths the renderer
 * needs after a routine has fired: the pending-result queue and the per-routine
 * session history. Every handler is host-renderer only.
 *
 * `triggerNow` deliberately goes through the scheduler rather than firing the
 * execution handler directly, so a manual trigger takes the same persistence
 * (lastFiredAt, dedup) and execution path as a scheduled one.
 */
import { ipcMain } from "electron";
import { validateHostRendererSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import type { IpcDeps } from "../types.js";
import type { RoutineExecution, RoutineFiredPayload, RoutineSchedule } from "../../shared/routines-types.js";
import { ROUTINES } from "../../shared/ipc-channels.js";

export function registerRoutineHandlers(deps: IpcDeps): void {
  const { routinesStore, routinesScheduler, memoryManager, auditLogger } = deps;

  ipcMain.handle(ROUTINES.list, (e) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, ROUTINES.list, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!routinesStore) return [];
    return routinesStore.listActive();
  });

  ipcMain.handle(ROUTINES.dismiss, async (e, id: string) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, ROUTINES.dismiss, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!routinesStore) return { ok: false, error: "no-store" };
    const ok = await routinesStore.dismiss(id);
    return { ok };
  });

  ipcMain.handle(ROUTINES.remove, async (e, id: string) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, ROUTINES.remove, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!routinesStore) return { ok: false, error: "no-store" };
    const ok = await routinesStore.remove(id);
    if (ok) {
      for (const session of memoryManager.listSessionsByRoutine(id)) {
        await memoryManager.deleteSession(session.id);
      }
    }
    return { ok };
  });

  ipcMain.handle(ROUTINES.triggerNow, async (e, id: string) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, ROUTINES.triggerNow, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!routinesStore) return { ok: false, error: "no-store" };
    if (!routinesScheduler) return { ok: false, error: "no-scheduler" };
    // Dispatch through the scheduler so persistence (lastFiredAt, dedup) and
    // execution handlers (LLM session or notification) fire identically to a
    // scheduled trigger — no separate renderer-only event path.
    const dispatched = await routinesScheduler.dispatchNow(id);
    if (!dispatched) return { ok: false, error: "routine-not-found" };
    return { ok: true };
  });

  ipcMain.handle(ROUTINES.pendingResults, async (e) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, ROUTINES.pendingResults, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!routinesStore) return [];
    const pending = routinesStore
      .list()
      .filter((routine) => routine.lastFiredAt && routine.lastResultAcknowledgedAt !== routine.lastFiredAt);
    const results: RoutineFiredPayload[] = [];
    for (const routine of pending) {
      const firedAt = routine.lastFiredAt!;
      const title = routine.title ?? routine.notificationTitle ?? routine.id.slice(0, 8);
      const result: RoutineFiredPayload = {
        id: routine.id,
        trigger: routine.trigger,
        execution: routine.execution,
        firedAt,
        title,
        summary: "",
      };
      if (routine.execution === "llm-session" && routine.lastRoutineSessionId) {
        const session = memoryManager
          .listSessionsByRoutine(routine.id)
          .find((candidate) => candidate.id === routine.lastRoutineSessionId);
        if (session) {
          result.routineSessionId = session.id;
          result.summary = session.preview;
        }
      }
      results.push(result);
    }
    return results;
  });

  ipcMain.handle(ROUTINES.acknowledgeResult, async (e, routineId: string, firedAt: string) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, ROUTINES.acknowledgeResult, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!routinesStore) return { ok: false, error: "no-store" };
    const updated = await routinesStore.update(routineId, { lastResultAcknowledgedAt: firedAt });
    if (!updated) return { ok: false, error: "routine-not-found" };
    return { ok: true };
  });

  ipcMain.handle(
    ROUTINES.add,
    async (
      e,
      input: {
        trigger: "shutdown" | "schedule";
        schedule?: RoutineSchedule;
        execution: RoutineExecution;
        prePrompt?: string;
        title?: string;
        notificationTitle?: string;
        notificationBody?: string;
      },
    ) => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, ROUTINES.add, e);
        return UNAUTHORIZED_FRAME;
      }
      if (!routinesStore) return { ok: false, error: "no-store" };
      try {
        const record = await routinesStore.add(input);
        return { ok: true, routine: record };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  );

  ipcMain.handle(ROUTINES.listSessions, async (e, routineId: string, limit?: number) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, ROUTINES.listSessions, e);
      return UNAUTHORIZED_FRAME;
    }
    return memoryManager.listSessionsByRoutine(routineId, limit ?? 10).map((session) => ({
      routineId: session.routineId ?? routineId,
      firedAt: session.routineFiredAt ?? session.modifiedAt.toISOString(),
      sessionId: session.id,
      title: session.title,
      preview: session.preview,
    }));
  });
}
