/**
 * Misc domain IPC handlers — routines v2, session-todo.
 *
 * Reminder IPC (lvis:reminders:*) removed — absorbed by lvis:routines:v2:* (atomic cutover).
 */
import { ipcMain } from "electron";
import { validateSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import type { IpcDeps } from "../types.js";
import { createLogger } from "../../lib/logger.js";
const log = createLogger("lvis");

export function registerMiscHandlers(deps: IpcDeps): void {
  const { routinesStore, sessionTodoStore, conversationLoop, auditLogger, getMainWindow } = deps;

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
    const active = routinesStore.listActive();
    const routine = active.find((r) => r.id === id);
    if (!routine) return { ok: false, error: "routine-not-found" };
    // Notify renderer so it can reflect the manual trigger visually.
    try {
      getMainWindow()?.webContents.send("lvis:routines:v2:fired", routine);
    } catch (err) {
      log.warn("routines:v2:trigger-now emit failed: %s", (err as Error).message);
    }
    return { ok: true };
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
