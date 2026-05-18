/**
 * Tutorial domain IPC handlers — Discovery Swipe state + open trigger.
 *
 * Channels:
 *   `lvis:tutorial:get-preferences` — read persisted likes/dislikes from
 *                                     `~/.lvis/tutorial/preferences.json`.
 *   `lvis:tutorial:record`          — apply a single liked / disliked /
 *                                     skipped / undone action and broadcast
 *                                     the new state to every open window.
 *   `lvis:tutorial:open`            — renderer asks main to broadcast the
 *                                     `tutorial-open` signal to every
 *                                     window so the dialog mounts on top of
 *                                     whatever surface the user is on.
 *   `lvis:tutorial:show-context-menu` — chat empty-area right-click pops a
 *                                     system menu with "튜토리얼 보기".
 *
 * The Spotlight tour dispatch itself lives in the Tutorial-C `tour`
 * domain (`lvis:tour:start`) — the Discovery Swipe dialog calls that
 * channel directly when the deck empties so the engine entry point stays
 * single-sourced.
 *
 * Error contract (project CLAUDE.md): kebab-case English `error` code +
 * English `message`. The renderer is responsible for translating to
 * Korean for the user.
 */
import { BrowserWindow, Menu, ipcMain } from "electron";
import { validateSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import { createLogger } from "../../lib/logger.js";
import {
  DEFAULT_TUTORIAL_PREFERENCES,
  TUTORIAL_ACTIONS,
  applyTutorialAction,
  readTutorialPreferences,
  type TutorialAction,
  type TutorialPreferences,
} from "../../main/tutorial-store.js";
import type { IpcDeps } from "../types.js";

const log = createLogger("tutorial-ipc");

export const TUTORIAL_PREFERENCES_CHANGED_CHANNEL = "lvis:tutorial:preferences-changed";
export const TUTORIAL_OPEN_CHANNEL = "lvis:tutorial:open";

function isTutorialAction(value: unknown): value is TutorialAction {
  return typeof value === "string" && (TUTORIAL_ACTIONS as readonly string[]).includes(value);
}

function broadcast(
  deps: IpcDeps,
  channel: string,
  payload: unknown,
): void {
  const targets = deps.getAppWindows?.() ?? [deps.getMainWindow()];
  for (const win of targets) {
    if (!win || win.isDestroyed?.()) continue;
    try {
      win.webContents.send(channel, payload);
    } catch {
      /* one window's send failure must not block the others */
    }
  }
}

export function registerTutorialHandlers(deps: IpcDeps): void {
  const { auditLogger } = deps;

  ipcMain.handle(
    "lvis:tutorial:get-preferences",
    async (
      e,
    ): Promise<
      | { ok: true; prefs: TutorialPreferences }
      | { ok: false; error: string; message: string }
    > => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, "lvis:tutorial:get-preferences", e);
        return {
          ok: false,
          error: UNAUTHORIZED_FRAME.error,
          message: "sender frame is not authorized",
        };
      }
      try {
        const prefs = await readTutorialPreferences();
        return { ok: true, prefs };
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "read failed; falling back to default",
        );
        return { ok: true, prefs: { ...DEFAULT_TUTORIAL_PREFERENCES } };
      }
    },
  );

  ipcMain.handle(
    "lvis:tutorial:record",
    async (
      e,
      payload: { cardId?: unknown; action?: unknown },
    ): Promise<
      | { ok: true; prefs: TutorialPreferences }
      | { ok: false; error: string; message: string }
    > => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, "lvis:tutorial:record", e);
        return {
          ok: false,
          error: UNAUTHORIZED_FRAME.error,
          message: "sender frame is not authorized",
        };
      }
      const cardId = typeof payload?.cardId === "string" ? payload.cardId : "";
      if (cardId.length === 0) {
        return {
          ok: false,
          error: "invalid-card-id",
          message: "cardId must be a non-empty string",
        };
      }
      if (!isTutorialAction(payload?.action)) {
        return {
          ok: false,
          error: "invalid-action",
          message: `action must be one of: ${TUTORIAL_ACTIONS.join(", ")}`,
        };
      }
      try {
        const next = await applyTutorialAction(cardId, payload.action);
        broadcast(deps, TUTORIAL_PREFERENCES_CHANGED_CHANNEL, next);
        return { ok: true, prefs: next };
      } catch (err) {
        const message = err instanceof Error ? err.message : "unknown write failure";
        log.error({ err: message }, "tutorial.record write failed");
        // Known validation errors from the store are kebab-case English
        // codes that match the renderer's expected error contract.
        if (message === "invalid-card-id" || message === "invalid-action") {
          return { ok: false, error: message, message };
        }
        return { ok: false, error: "write-failed", message };
      }
    },
  );

  ipcMain.handle(
    "lvis:tutorial:open",
    async (
      e,
    ): Promise<
      | { ok: true }
      | { ok: false; error: string; message: string }
    > => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, "lvis:tutorial:open", e);
        return {
          ok: false,
          error: UNAUTHORIZED_FRAME.error,
          message: "sender frame is not authorized",
        };
      }
      broadcast(deps, TUTORIAL_OPEN_CHANNEL, { source: "ipc" });
      return { ok: true };
    },
  );

  ipcMain.handle(
    "lvis:tutorial:show-context-menu",
    async (
      e,
    ): Promise<
      | { ok: true }
      | { ok: false; error: string; message: string }
    > => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, "lvis:tutorial:show-context-menu", e);
        return {
          ok: false,
          error: UNAUTHORIZED_FRAME.error,
          message: "sender frame is not authorized",
        };
      }
      const win = BrowserWindow.fromWebContents(e.sender) ?? deps.getMainWindow();
      if (!win || win.isDestroyed?.()) {
        return {
          ok: false,
          error: "no-window",
          message: "originating window is no longer available",
        };
      }
      const menu = Menu.buildFromTemplate([
        {
          label: "튜토리얼 보기",
          click: () => broadcast(deps, TUTORIAL_OPEN_CHANNEL, { source: "chat-context" }),
        },
      ]);
      menu.popup({ window: win });
      return { ok: true };
    },
  );

}

/**
 * Broadcast helper used by main-process callers (menu builder, tray) to
 * trigger the Discovery Swipe dialog without going through ipcMain.handle.
 * The renderer subscribes to TUTORIAL_OPEN_CHANNEL and mounts the dialog.
 */
export function emitTutorialOpen(deps: IpcDeps, source: string): void {
  broadcast(deps, TUTORIAL_OPEN_CHANNEL, { source });
}
