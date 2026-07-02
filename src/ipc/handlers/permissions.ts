/**
 * permissions.ts (handlers) — transport-agnostic permission handler logic
 * (#1409 C10).
 *
 * Pure `handle*` functions behind the permission channels, split out from the
 * electron `ipcMain.handle` wrappers in `domains/permissions.ts`:
 *
 *   - {@link handleGetMode} — PUBLIC `permission get-mode` (read-only).
 *   - {@link handleSetPermissionMode} — the CORE of the gesture-gated
 *     `permission set-mode` mutation, AFTER the transport-level sender / intent
 *     checks. Transport-agnostic: it takes the trust decision as an explicit
 *     {@link SetPermissionModeBypass} argument rather than reading it from the
 *     electron event, so the same core can be driven from the renderer wrapper
 *     or (later) an approval-mediated external surface.
 *
 * Imports NOTHING from the electron transport.
 */
import { PERMISSIONS } from "../../shared/ipc-channels.js";
import { sendToWindow } from "../safe-send.js";
import type { IpcDeps } from "../types.js";
import type {
  PermissionModeApprovalBypass,
} from "../../permissions/permission-mode-apply.js";
import type { PermissionModeCommand } from "../../permissions/permission-slash.js";

/** PUBLIC `lvis:permission:get-mode` — current permission mode (read-only). */
export function handleGetMode(deps: IpcDeps): { mode: string } {
  const mode = deps.conversationLoop.permissionManager?.getMode() ?? "default";
  return { mode };
}

/**
 * The trust decision an out-of-band caller has already made for a permission
 * set-mode mutation. Transport-agnostic (plain string / boolean fields) so a
 * future non-renderer surface can supply its own provenance; the renderer
 * wrapper passes the fixed settings-ui / user-keyboard tuple. The core forwards
 * this verbatim to {@link applyPermissionModeCommand}'s approval bypass.
 */
export interface SetPermissionModeBypass {
  source: string;
  trustOrigin: string;
  explicitUserAction: boolean;
}

function isParseError<T>(value: T | { ok: false; error: string }): value is { ok: false; error: string } {
  return "ok" in (value as Record<string, unknown>) && (value as { ok?: unknown }).ok === false;
}

/**
 * Broadcast the new permission mode to every app window. Sourced here (not in
 * the domain) so `handleSetPermissionMode` owns the whole post-apply core and
 * the domain wrapper stays a thin transport shell.
 */
export function broadcastPermissionModeChanged(deps: IpcDeps, mode: string): void {
  const mainWindow = deps.getMainWindow?.();
  const windows = deps.getAppWindows?.() ?? [mainWindow];
  for (const win of windows) {
    sendToWindow(win, PERMISSIONS.modeChanged, { mode });
  }
}

/**
 * CORE of `lvis:permission:set-mode`, transport-agnostic. Everything AFTER the
 * transport-level sender-frame + user-keyboard-intent checks: mode validation →
 * durable slash parse → parse-error / durable-confirm checks → permission
 * manager presence → {@link applyPermissionModeCommand} with the supplied
 * approval bypass → broadcast + return. Error codes / messages are unchanged
 * from the previous inline implementation ("invalid-mode",
 * "missing-durable-confirm", "no-permission-manager").
 */
export async function handleSetPermissionMode(
  deps: IpcDeps,
  mode: unknown,
  bypass: SetPermissionModeBypass,
): Promise<{ ok: true; mode: string } | { ok: false; error: string; message: string }> {
  if (typeof mode !== "string") {
    return { ok: false, error: "invalid-mode", message: "mode must be a string" };
  }
  const { parsePermissionModeCommand } = await import("../../permissions/permission-slash.js");
  const parsed = parsePermissionModeCommand(`${mode} --durable`);
  if (isParseError<PermissionModeCommand>(parsed)) {
    return { ok: false, error: "invalid-mode", message: parsed.error };
  }
  if (parsed.durable !== true) {
    return { ok: false, error: "missing-durable-confirm", message: "durable mode command must require modal confirmation" };
  }
  const pm = deps.conversationLoop.permissionManager;
  if (!pm) return { ok: false, error: "no-permission-manager", message: "permission manager not initialized" };
  const { applyPermissionModeCommand } = await import("../../permissions/permission-mode-apply.js");
  const approvalBypass: PermissionModeApprovalBypass | undefined =
    bypass.explicitUserAction === true &&
    bypass.trustOrigin === "user-keyboard" &&
    (bypass.source === "settings-ui" || bypass.source === "builtin-slash")
      ? { source: bypass.source, trustOrigin: "user-keyboard", explicitUserAction: true }
      : undefined;
  const result = await applyPermissionModeCommand(parsed, {
    permissionManager: pm,
    approvalGate: deps.approvalGate,
    auditLogger: deps.auditLogger,
    approvalBypass,
  });
  if (!result.ok) return result;
  broadcastPermissionModeChanged(deps, result.mode);
  return { ok: true, mode: result.mode };
}
