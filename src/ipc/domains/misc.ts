/**
 * Misc domain IPC handlers — routines v2, session-todo.
 *
 * Reminder IPC (lvis:reminders:*) removed — absorbed by lvis:routines:v2:* (atomic cutover).
 */
import { ipcMain } from "electron";
import { validateSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import type { IpcDeps } from "../types.js";
import type { RoutineExecution, RoutineFiredPayload, RoutineSchedule } from "../../shared/routines-types.js";
import { ROUTINES_V2, OVERLAY_V1 } from "../../shared/ipc-channels.js";
import { createLogger } from "../../lib/logger.js";
const log = createLogger("lvis");

export function registerMiscHandlers(deps: IpcDeps): void {
  const { routinesStore, routinesScheduler, sessionTodoStore, conversationLoop, memoryManager, auditLogger, getMainWindow } = deps;

  // ─── Routines v2 ────────────────────────────────
  ipcMain.handle(ROUTINES_V2.list, (e) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, ROUTINES_V2.list, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!routinesStore) return [];
    return routinesStore.listActive();
  });

  ipcMain.handle(ROUTINES_V2.dismiss, async (e, id: string) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, ROUTINES_V2.dismiss, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!routinesStore) return { ok: false, error: "no-store" };
    const ok = await routinesStore.dismiss(id);
    return { ok };
  });

  ipcMain.handle(ROUTINES_V2.remove, async (e, id: string) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, ROUTINES_V2.remove, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!routinesStore) return { ok: false, error: "no-store" };
    const ok = await routinesStore.remove(id);
    if (ok) {
      for (const session of memoryManager.listSessionsByRoutine(id)) {
        memoryManager.deleteSession(session.id);
      }
    }
    return { ok };
  });

  ipcMain.handle(ROUTINES_V2.triggerNow, async (e, id: string) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, ROUTINES_V2.triggerNow, e);
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

  ipcMain.handle(ROUTINES_V2.pendingResults, async (e) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, ROUTINES_V2.pendingResults, e);
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

  ipcMain.handle(ROUTINES_V2.acknowledgeResult, async (e, routineId: string, firedAt: string) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, ROUTINES_V2.acknowledgeResult, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!routinesStore) return { ok: false, error: "no-store" };
    const updated = await routinesStore.update(routineId, { lastResultAcknowledgedAt: firedAt });
    if (!updated) return { ok: false, error: "routine-not-found" };
    return { ok: true };
  });

  ipcMain.handle(
    ROUTINES_V2.add,
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
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, ROUTINES_V2.add, e);
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

  ipcMain.handle(ROUTINES_V2.listSessions, async (e, routineId: string, limit?: number) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, ROUTINES_V2.listSessions, e);
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

  // ─── Overlay v1 — renderer→main notification (write influence) ──
  ipcMain.handle(OVERLAY_V1.primaryAction, (e, _pluginId: string, _eventId: string) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, OVERLAY_V1.primaryAction, e);
      return UNAUTHORIZED_FRAME;
    }
    // Renderer has already inserted pendingPrompt into chat before invoking this.
    // Main-side handler acknowledges the action (future: audit log, plugin callback).
    return undefined;
  });

  // ─── Session Todo ────────────────────────────────
  ipcMain.handle("lvis:session-todo:list", (e, sessionId?: string) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "lvis:session-todo:list", e);
      return UNAUTHORIZED_FRAME;
    }
    if (!sessionTodoStore) return [];
    const sid = sessionId ?? conversationLoop.getSessionId();
    return sessionTodoStore.list(sid);
  });
  if (sessionTodoStore) {
    sessionTodoStore.onChange((sessionId, items) => {
      try {
        getMainWindow()?.webContents.send("lvis:session-todo:changed", {
          sessionId,
          items,
        });
      } catch (err) {
        log.warn("session-todo emit failed: %s", (err as Error).message);
      }
    });
  }
}
