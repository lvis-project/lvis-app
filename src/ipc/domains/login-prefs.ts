/**
 * Login Prefs domain IPC handlers.
 *
 * Channels:
 *   `lvis:login-prefs:get`   — read current variant from
 *                              `~/.lvis/login-prefs/login-prefs.json`.
 *   `lvis:login-prefs:set`   — persist the user's chosen variant and
 *                              broadcast `lvis:login-prefs:changed` so the
 *                              renderer can remount the LoginModal without
 *                              an app restart.
 *
 * Error contract (project CLAUDE.md): kebab-case English `error` code +
 * English `message`. The renderer is responsible for translating to
 * Korean for the user.
 */
import { ipcMain } from "electron";
import { validateSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import { createLogger } from "../../lib/logger.js";
import {
  DEFAULT_LOGIN_PREFS,
  LOGIN_VARIANTS,
  readLoginPrefs,
  writeLoginPrefs,
  type LoginPrefs,
  type LoginVariant,
} from "../../main/login-prefs-store.js";
import type { IpcDeps } from "../types.js";

const log = createLogger("login-prefs-ipc");

export const LOGIN_PREFS_CHANGED_CHANNEL = "lvis:login-prefs:changed";

function isLoginVariant(value: unknown): value is LoginVariant {
  return typeof value === "string" && (LOGIN_VARIANTS as readonly string[]).includes(value);
}

export function registerLoginPrefsHandlers(deps: IpcDeps): void {
  const { auditLogger } = deps;

  ipcMain.handle(
    "lvis:login-prefs:get",
    async (
      e,
    ): Promise<
      | { ok: true; prefs: LoginPrefs }
      | { ok: false; error: string; message: string }
    > => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, "lvis:login-prefs:get", e);
        return {
          ok: false,
          error: UNAUTHORIZED_FRAME.error,
          message: "sender frame is not authorized",
        };
      }
      try {
        const prefs = await readLoginPrefs();
        return { ok: true, prefs };
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "read failed; falling back to default",
        );
        return { ok: true, prefs: DEFAULT_LOGIN_PREFS };
      }
    },
  );

  ipcMain.handle(
    "lvis:login-prefs:set",
    async (
      e,
      payload: { loginVariant?: unknown },
    ): Promise<
      | { ok: true; prefs: LoginPrefs }
      | { ok: false; error: string; message: string }
    > => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, "lvis:login-prefs:set", e);
        return {
          ok: false,
          error: UNAUTHORIZED_FRAME.error,
          message: "sender frame is not authorized",
        };
      }
      const candidate = payload?.loginVariant;
      if (!isLoginVariant(candidate)) {
        return {
          ok: false,
          error: "invalid-login-variant",
          message: "loginVariant must be one of: conversational, cli-agent",
        };
      }
      const next: LoginPrefs = { loginVariant: candidate };
      try {
        await writeLoginPrefs(next);
      } catch (err) {
        log.error(
          { err: err instanceof Error ? err.message : String(err) },
          "write failed",
        );
        return {
          ok: false,
          error: "write-failed",
          message: err instanceof Error ? err.message : "unknown write failure",
        };
      }
      // Broadcast to every open app window so siblings remount LoginModal.
      const targets = deps.getAppWindows?.() ?? [deps.getMainWindow()];
      for (const win of targets) {
        if (!win || win.isDestroyed?.()) continue;
        try {
          win.webContents.send(LOGIN_PREFS_CHANGED_CHANNEL, next);
        } catch {
          /* one window's send failure must not block the others */
        }
      }
      return { ok: true, prefs: next };
    },
  );
}
