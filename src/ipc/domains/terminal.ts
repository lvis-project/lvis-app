/**
 * Terminal domain IPC handlers (#1444) — interactive PTY terminal in the
 * workspace rail.
 *
 * Channels (ALL INTERNAL — never in PUBLIC_CHANNELS / EXTERNAL_MUTATION_CHANNELS):
 *   `lvis:terminal:spawn`  invoke  renderer→main  → { ok, tabId, replayed } | { ok:false, reason, message }
 *   `lvis:terminal:input`  invoke  keystrokes → pty stdin
 *   `lvis:terminal:resize` invoke  cols/rows
 *   `lvis:terminal:kill`   invoke  tab close / teardown
 *   `lvis:terminal:data`   event   main→renderer  pty output chunk
 *   `lvis:terminal:exit`   event   main→renderer  pty exited
 *
 * TRUST BOUNDARY: a terminal spawns arbitrary user commands, so every invoke
 * gates on {@link validateHostRendererSender} — the HOST renderer frame only.
 * A plugin-ui-shell frame (also file://) is rejected there, and an external
 * origin (local-api / cli) can never reach these channels because they are
 * absent from PUBLIC_CHANNELS (fail-closed `isPublicChannel`). The confinement
 * itself (deny-by-default egress + filesystem jail) is enforced in the main
 * process by pty-manager via the ASRT sandbox; see pty-manager.ts.
 *
 * Error contract (project CLAUDE.md): kebab-case English `reason` / `error`.
 */
import { ipcMain } from "electron";
import { CHANNELS } from "../../contract/app-contract.js";
import { validateHostRendererSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import { fanOutToAllWindows } from "../broadcast-helpers.js";
import { createLogger } from "../../lib/logger.js";
import {
  setTerminalEmitter,
  spawnTerminal,
  writeTerminal,
  resizeTerminal,
  killTerminal,
  type SpawnTerminalResult,
} from "../../main/terminal/pty-manager.js";
import type { IpcDeps } from "../types.js";

const log = createLogger("terminal-ipc");

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : NaN;
}

export function registerTerminalHandlers(deps: IpcDeps): void {
  const { auditLogger } = deps;

  // Wire the main→renderer output sink ONCE. pty-manager stays electron-free;
  // this fans each data/exit event out to every app window via safe-send.
  setTerminalEmitter((event, payload) => {
    const channel = event === "data" ? CHANNELS.terminal.data : CHANNELS.terminal.exit;
    const targets = deps.getAppWindows?.() ?? [deps.getMainWindow()];
    fanOutToAllWindows(targets, channel, payload, { logger: log });
  });

  ipcMain.handle(
    CHANNELS.terminal.spawn,
    async (
      e,
      payload: { tabId?: unknown; cwd?: unknown; cols?: unknown; rows?: unknown },
    ): Promise<SpawnTerminalResult | { ok: false; reason: "unauthorized-frame"; message: string }> => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.terminal.spawn, e);
        return { ok: false, reason: "unauthorized-frame", message: "sender frame is not authorized" };
      }
      const tabId = asString(payload?.tabId);
      if (!tabId) {
        return { ok: false, reason: "bad-request", message: "tabId must be a non-empty string" };
      }
      return spawnTerminal({
        tabId,
        ...(typeof payload?.cwd === "string" ? { cwd: payload.cwd } : {}),
        ...(typeof payload?.cols === "number" ? { cols: payload.cols } : {}),
        ...(typeof payload?.rows === "number" ? { rows: payload.rows } : {}),
      });
    },
  );

  ipcMain.handle(
    CHANNELS.terminal.input,
    async (
      e,
      payload: { tabId?: unknown; data?: unknown },
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.terminal.input, e);
        return { ok: false, error: UNAUTHORIZED_FRAME.error };
      }
      const tabId = asString(payload?.tabId);
      const data = asString(payload?.data);
      if (!tabId) return { ok: false, error: "invalid-params" };
      writeTerminal(tabId, data);
      return { ok: true };
    },
  );

  ipcMain.handle(
    CHANNELS.terminal.resize,
    async (
      e,
      payload: { tabId?: unknown; cols?: unknown; rows?: unknown },
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.terminal.resize, e);
        return { ok: false, error: UNAUTHORIZED_FRAME.error };
      }
      const tabId = asString(payload?.tabId);
      if (!tabId) return { ok: false, error: "invalid-params" };
      resizeTerminal(tabId, asNumber(payload?.cols), asNumber(payload?.rows));
      return { ok: true };
    },
  );

  ipcMain.handle(
    CHANNELS.terminal.kill,
    async (
      e,
      payload: { tabId?: unknown },
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.terminal.kill, e);
        return { ok: false, error: UNAUTHORIZED_FRAME.error };
      }
      const tabId = asString(payload?.tabId);
      if (!tabId) return { ok: false, error: "invalid-params" };
      killTerminal(tabId);
      return { ok: true };
    },
  );
}
