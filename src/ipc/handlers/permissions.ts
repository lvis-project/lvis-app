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
  LoosePermissionModeApprovalBypass,
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
 * this verbatim to `applyPermissionModeCommand`'s approval bypass.
 *
 * @internal Raw structs must NEVER be forwarded verbatim from caller-controlled
 * values (e.g. an IPC payload or external HTTP body). All narrowing from this
 * loose shape into the strict `PermissionModeApprovalBypass` happens in
 * `resolvePermissionModeApprovalBypass`
 * (`src/permissions/permission-mode-apply.ts`) — the one auditable choke point
 * where the fail-closed trust conditions live. This
 * transport alias exists so IPC signatures do not have to name a permissions
 * type; it is the SAME type, not a second declaration.
 */
export type SetPermissionModeBypass = LoosePermissionModeApprovalBypass;

function isParseError<T>(value: T | { ok: false; error: string }): value is { ok: false; error: string } {
  return "ok" in (value as Record<string, unknown>) && (value as { ok?: unknown }).ok === false;
}

/**
 * Broadcast the new permission mode to every app window. Sourced here (not in
 * the domain) so `handleSetPermissionMode` owns the whole post-apply core and
 * the domain wrapper stays a thin transport shell.
 */
function broadcastPermissionModeChanged(deps: IpcDeps, mode: string): void {
  const mainWindow = deps.getMainWindow?.();
  const windows = deps.getAppWindows?.() ?? [mainWindow];
  for (const win of windows) {
    sendToWindow(win, PERMISSIONS.modeChanged, { mode });
  }
}

/**
 * CORE of `lvis:permission:set-mode`, transport-agnostic. Everything AFTER the
 * transport-level sender-frame + user-keyboard-intent checks: mode validation →
 * slash parse → parse-error / durable-confirm checks → permission manager
 * presence → {@link applyPermissionModeCommand} with the supplied approval
 * bypass → broadcast + return. Error codes / messages are unchanged
 * ("invalid-mode", "missing-durable-confirm", "no-permission-manager").
 *
 * DURABILITY IS PER CHANNEL, not fixed. The renderer surfaces
 * (`settings-ui` / `builtin-slash`) still request `--durable`: the user is in
 * the app, looking at the setting they are changing, and expects it to stick.
 * The EXTERNAL channel (`local-api-approval`) does not — its whole consent is
 * one ApprovalGate click on one request, so the change is session-scoped and
 * expires with the session the human was looking at. `isExternalApprovalBypass`
 * over the ALREADY-narrowed bypass is what decides; a bypass shape that fails
 * narrowing is not treated as external, so it keeps falling through to the
 * ApprovalGate ask instead of being quietly downgraded into a promptless
 * session change.
 */
export async function handleSetPermissionMode(
  deps: IpcDeps,
  mode: unknown,
  bypass: SetPermissionModeBypass,
): Promise<{ ok: true; mode: string } | { ok: false; error: string; message: string }> {
  if (typeof mode !== "string") {
    return { ok: false, error: "invalid-mode", message: "mode must be a string" };
  }
  const { applyPermissionModeCommand, resolvePermissionModeApprovalBypass, isExternalApprovalBypass } =
    await import("../../permissions/permission-mode-apply.js");
  const approvalBypass = resolvePermissionModeApprovalBypass(bypass);
  const external = isExternalApprovalBypass(approvalBypass);
  const { parsePermissionModeCommand } = await import("../../permissions/permission-slash.js");
  const parsed = parsePermissionModeCommand(external ? mode : `${mode} --durable`);
  if (isParseError<PermissionModeCommand>(parsed)) {
    return { ok: false, error: "invalid-mode", message: parsed.error };
  }
  // Only the in-app channel asserts durability here. On the external channel a
  // `--durable` smuggled inside the mode string is NOT stripped — it is left in
  // place so `applyPermissionModeCommand`'s ceiling refuses it loudly.
  if (!external && parsed.durable !== true) {
    return { ok: false, error: "missing-durable-confirm", message: "durable mode command must require modal confirmation" };
  }
  const pm = deps.conversationLoop.permissionManager;
  if (!pm) return { ok: false, error: "no-permission-manager", message: "permission manager not initialized" };
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
