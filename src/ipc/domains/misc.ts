/**
 * Misc domain IPC handlers — tasks, reminders, session-todo.
 */
import { ipcMain } from "electron";
import { validateSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import type { IpcDeps } from "../types.js";

export function registerMiscHandlers(deps: IpcDeps): void {
  const { taskService, remindersStore, sessionTodoStore, conversationLoop, auditLogger, getMainWindow } = deps;

  // ─── Tasks ──────────────────────────────────────
  ipcMain.handle("lvis:tasks:add", (e, task) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:tasks:add", e); return UNAUTHORIZED_FRAME; }
    return taskService.add(task);
  });
  ipcMain.handle("lvis:tasks:update", (e, id: string, patch) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:tasks:update", e); return UNAUTHORIZED_FRAME; }
    return taskService.update(id, patch);
  });
  // read-only, sender guard optional
  ipcMain.handle("lvis:tasks:get", (_e, id: string) => taskService.get(id));
  ipcMain.handle("lvis:tasks:delete", (e, id: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:tasks:delete", e); return UNAUTHORIZED_FRAME; }
    return taskService.delete(id);
  });
  // read-only, sender guard optional
  ipcMain.handle("lvis:tasks:query", (_e, filter) => taskService.query(filter));
  // read-only, sender guard optional
  ipcMain.handle("lvis:tasks:pending", () => taskService.getPendingByPriority());
  // read-only, sender guard optional
  ipcMain.handle("lvis:tasks:overdue", () => taskService.getOverdue());
  // read-only, sender guard optional
  ipcMain.handle("lvis:tasks:today", () => taskService.getDueToday());

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
        console.warn("[lvis] session-todo emit failed:", (err as Error).message);
      }
    });
  }
}
