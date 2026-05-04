/**
 * Misc domain IPC handlers — tasks, reminders, session-todo.
 */
import { ipcMain } from "electron";
import { validateSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import type { IpcDeps } from "../types.js";
import { createLogger } from "../../lib/logger.js";
const log = createLogger("lvis");

export function registerMiscHandlers(deps: IpcDeps): void {
  const { remindersStore, sessionTodoStore, conversationLoop, auditLogger, getMainWindow } = deps;

  // ─── Reminders ──────────────────────────────────
  ipcMain.handle("lvis:reminders:list", (e) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "lvis:reminders:list", e);
      return UNAUTHORIZED_FRAME;
    }
    if (!remindersStore) return [];
    return remindersStore.listActive();
  });
  ipcMain.handle("lvis:reminders:dismiss", async (e, id: string) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "lvis:reminders:dismiss", e);
      return UNAUTHORIZED_FRAME;
    }
    if (!remindersStore) return { ok: false, error: "no-store" };
    const ok = await remindersStore.dismiss(id);
    return { ok };
  });
  ipcMain.handle("lvis:reminders:remove", async (e, id: string) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, "lvis:reminders:remove", e);
      return UNAUTHORIZED_FRAME;
    }
    if (!remindersStore) return { ok: false, error: "no-store" };
    const ok = await remindersStore.remove(id);
    return { ok };
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
