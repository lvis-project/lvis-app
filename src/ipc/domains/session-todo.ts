/**
 * Session-todo IPC handlers — `lvis:session-todo:*`.
 *
 * Read + clear over the per-session todo list, plus the main -> renderer
 * `changed` push so the renderer reflects a todo update without polling.
 * `sessionId` defaults to the conversation loop's current session.
 */
import { ipcMain } from "electron";
import { validateHostRendererSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import { CHANNELS } from "../../contract/app-contract.js";
import type { IpcDeps } from "../types.js";
import { createLogger } from "../../lib/logger.js";
const log = createLogger("lvis");

export function registerSessionTodoHandlers(deps: IpcDeps): void {
  const { sessionTodoStore, conversationLoop, auditLogger, getMainWindow } = deps;

  ipcMain.handle(CHANNELS.sessionTodo.list, (e, sessionId?: string) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.sessionTodo.list, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!sessionTodoStore) return [];
    const sid = sessionId ?? conversationLoop.getSessionId();
    return sessionTodoStore.list(sid);
  });
  ipcMain.handle(CHANNELS.sessionTodo.clear, (e, sessionId?: string) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.sessionTodo.clear, e);
      return UNAUTHORIZED_FRAME;
    }
    if (!sessionTodoStore) return { ok: false, error: "no-session-todo-store" };
    const sid = sessionId ?? conversationLoop.getSessionId();
    sessionTodoStore.clear(sid);
    return { ok: true };
  });
  if (sessionTodoStore) {
    sessionTodoStore.onChange((sessionId, items) => {
      try {
        getMainWindow()?.webContents.send(CHANNELS.sessionTodo.changed, {
          sessionId,
          items,
        });
      } catch (err) {
        log.warn("session-todo emit failed: %s", (err as Error).message);
      }
    });
  }
}
