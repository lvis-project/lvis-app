/**
 * Session-todo IPC handlers — `lvis:session-todo:*`.
 *
 * Read + clear over the per-session todo list, plus the main -> renderer
 * `changed` push so the renderer reflects a todo update without polling.
 *
 * `sessionId` is REQUIRED. The window can hold several conversations at once,
 * so "the current session" is not a fact main can answer — resolving an absent
 * id against the primary loop would read or CLEAR a tile's checklist the caller
 * never named. Same rule, and same rejection, as the chat domain's `groupOf`.
 */
import { ipcMain } from "electron";
import { validateHostRendererSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import { CHANNELS } from "../../contract/app-contract.js";
import type { IpcDeps } from "../types.js";
import { createLogger } from "../../lib/logger.js";
const log = createLogger("lvis");

/** The conversation a session-todo call names, from its argument. */
function sessionOf(sessionId: unknown): string {
  if (typeof sessionId !== "string" || !sessionId.trim()) {
    throw new Error("session-id-required");
  }
  return sessionId;
}

export function registerSessionTodoHandlers(deps: IpcDeps): void {
  const { sessionTodoStore, auditLogger, getMainWindow } = deps;

  ipcMain.handle(CHANNELS.sessionTodo.list, (e, sessionId: unknown) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.sessionTodo.list, e);
      return UNAUTHORIZED_FRAME;
    }
    const sid = sessionOf(sessionId);
    if (!sessionTodoStore) return [];
    return sessionTodoStore.list(sid);
  });
  ipcMain.handle(CHANNELS.sessionTodo.clear, (e, sessionId: unknown) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.sessionTodo.clear, e);
      return UNAUTHORIZED_FRAME;
    }
    const sid = sessionOf(sessionId);
    if (!sessionTodoStore) return { ok: false, error: "no-session-todo-store" };
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
