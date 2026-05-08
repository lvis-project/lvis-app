/**
 * Misc domain IPC handlers — routines v2, session-todo.
 *
 * Reminder IPC (lvis:reminders:*) removed — absorbed by lvis:routines:v2:* (atomic cutover).
 */
import { ipcMain } from "electron";
import { validateSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import type { IpcDeps } from "../types.js";
import type { RoutineExecution, RoutineSchedule } from "../../main/routines-store.js";
import { createLogger } from "../../lib/logger.js";
const log = createLogger("lvis");

export function registerMiscHandlers(deps: IpcDeps): void {
  const { routinesStore, routinesScheduler, sessionTodoStore, conversationLoop, auditLogger, getMainWindow } = deps;

  // ─── Routines v2 ────────────────────────────────
  ipcMain.handle("lvis:routines:v2:list", (e) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "lvis:routines:v2:list", e);
      return UNAUTHORIZED_FRAME;
    }
    if (!routinesStore) return [];
    return routinesStore.listActive();
  });

  ipcMain.handle("lvis:routines:v2:dismiss", async (e, id: string) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "lvis:routines:v2:dismiss", e);
      return UNAUTHORIZED_FRAME;
    }
    if (!routinesStore) return { ok: false, error: "no-store" };
    const ok = await routinesStore.dismiss(id);
    return { ok };
  });

  ipcMain.handle("lvis:routines:v2:remove", async (e, id: string) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "lvis:routines:v2:remove", e);
      return UNAUTHORIZED_FRAME;
    }
    if (!routinesStore) return { ok: false, error: "no-store" };
    const ok = await routinesStore.remove(id);
    return { ok };
  });

  ipcMain.handle("lvis:routines:v2:trigger-now", async (e, id: string) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "lvis:routines:v2:trigger-now", e);
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

  ipcMain.handle(
    "lvis:routines:v2:add",
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
        auditUnauthorized(auditLogger, "lvis:routines:v2:add", e);
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
