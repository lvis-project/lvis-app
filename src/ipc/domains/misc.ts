/**
 * Misc domain IPC handlers — routines v2, session-todo.
 *
 * Reminder IPC (lvis:reminders:*) removed — absorbed by lvis:routines:v2:* (atomic cutover).
 */
import { ipcMain } from "electron";
import { readFile } from "node:fs/promises";
import { validateSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import type { IpcDeps } from "../types.js";
import type { RoutineExecution, RoutineSchedule } from "../../main/routines-store.js";
import { ROUTINES_V2 } from "../../shared/ipc-channels.js";
import { createLogger } from "../../lib/logger.js";
const log = createLogger("lvis");

export function registerMiscHandlers(deps: IpcDeps): void {
  const { routinesStore, routinesScheduler, routineSessionStore, sessionTodoStore, conversationLoop, auditLogger, getMainWindow } = deps;

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
    // Q9: purge session files when routine is removed.
    if (ok && routineSessionStore) {
      await routineSessionStore.purgeRoutine(id);
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

  // ─── Routines v2 session history (Q9) ────────────
  ipcMain.handle(ROUTINES_V2.listSessions, async (e, routineId: string, limit?: number) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, ROUTINES_V2.listSessions, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!routineSessionStore) return [];
    return routineSessionStore.listRecent(routineId, limit ?? 10);
  });

  ipcMain.handle(ROUTINES_V2.readSession, async (e, jsonlPath: string) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, ROUTINES_V2.readSession, e);
      // Return empty string (not UNAUTHORIZED_FRAME object) — preload type is Promise<string>
      log.warn("read-session: unauthorized frame rejected");
      return "";
    }
    if (!routineSessionStore) return "";
    // Path traversal guard — only allow paths inside ~/.lvis/routine-sessions/.
    if (!routineSessionStore.isPathSafe(jsonlPath)) {
      log.warn("read-session: path traversal attempt blocked: %s", jsonlPath);
      return "";
    }
    try {
      return await readFile(jsonlPath, "utf-8");
    } catch (err) {
      log.warn("read-session: read failed: %s", (err as Error).message);
      return "";
    }
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
