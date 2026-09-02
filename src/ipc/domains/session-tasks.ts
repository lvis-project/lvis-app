/**
 * Session-tasks IPC handlers — `lvis:session-tasks:*`.
 *
 * Read + clear over the per-session task list, plus the main -> renderer
 * `changed` push so the renderer reflects a task update without polling.
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
import { isValidSessionId } from "../../memory/memory-manager.js";
import { createLogger } from "../../lib/logger.js";
const log = createLogger("lvis");

/**
 * The conversation a session-tasks call names, or `null` when it names none.
 * An id that is not well-formed names no session either: the list lives in
 * that session's metadata sidecar, which only a valid id can address.
 *
 * A refusal rather than a throw: `ipcMain.handle` would turn a throw into a
 * rejected promise in the renderer, and the panel's read is fire-and-forget —
 * an unhandled rejection is a worse report of "you forgot the session" than
 * the channel's own empty answer.
 */
function namedSession(sessionId: unknown): string | null {
  return isValidSessionId(sessionId) ? sessionId : null;
}

export function registerSessionTasksHandlers(deps: IpcDeps): void {
  const { sessionTasksStore, auditLogger, getMainWindow } = deps;

  ipcMain.handle(CHANNELS.sessionTasks.list, (e, sessionId: unknown) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.sessionTasks.list, e);
      return UNAUTHORIZED_FRAME;
    }
    const sid = namedSession(sessionId);
    if (sid === null) {
      log.warn("session-tasks list without a session id");
      return [];
    }
    if (!sessionTasksStore) return [];
    return sessionTasksStore.list(sid);
  });
  ipcMain.handle(CHANNELS.sessionTasks.clear, async (e, sessionId: unknown) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.sessionTasks.clear, e);
      return UNAUTHORIZED_FRAME;
    }
    const sid = namedSession(sessionId);
    if (sid === null) {
      log.warn("session-tasks clear without a session id");
      return { ok: false, error: "session-id-required" };
    }
    if (!sessionTasksStore) return { ok: false, error: "no-session-tasks-store" };
    await sessionTasksStore.clear(sid);
    return { ok: true };
  });
  if (sessionTasksStore) {
    sessionTasksStore.onChange((sessionId, items) => {
      try {
        getMainWindow()?.webContents.send(CHANNELS.sessionTasks.changed, {
          sessionId,
          items,
        });
      } catch (err) {
        log.warn("session-tasks emit failed: %s", (err as Error).message);
      }
    });
  }
}
