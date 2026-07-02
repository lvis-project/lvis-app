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
import { isExternalOrigin, type TrustOrigin } from "../../contract/trust-origin.js";

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

/**
 * Narrow the transport-agnostic {@link SetPermissionModeBypass} into the strict
 * {@link PermissionModeApprovalBypass} that lets `applyPermissionModeCommand`
 * skip the in-app approval modal. This is the ONLY place the strict bypass is
 * built, so the trust conditions live in one auditable spot. Anything that does
 * not match a recognized surface returns `undefined` → the normal ApprovalGate
 * ask runs (fail-closed).
 *
 * Two accepted surfaces:
 *   - RENDERER built-in: `source ∈ {settings-ui, builtin-slash}` AND
 *     `trustOrigin === "user-keyboard"` AND `explicitUserAction`. Byte-identical
 *     to the prior inline check — the renderer path is unchanged.
 *   - #1409 EXTERNAL approval: `source === "local-api-approval"` AND
 *     `trustOrigin` is an {@link import("../../contract/trust-origin.js").ExternalOrigin}
 *     (local-api / cli) AND `explicitUserAction`. The user ALREADY consented via
 *     the in-app ApprovalGate modal built in `src/main/local-api-server.ts`
 *     BEFORE this handler ran; honoring the bypass here is what prevents a
 *     SECOND modal for the same mutation. It is never a silent bypass — the
 *     lifecycle only constructs this shape after observing a real "allow"
 *     ApprovalGate decision.
 */
function resolveApprovalBypass(
  bypass: SetPermissionModeBypass,
): PermissionModeApprovalBypass | undefined {
  if (bypass.explicitUserAction !== true) return undefined;
  if (
    (bypass.source === "settings-ui" || bypass.source === "builtin-slash") &&
    bypass.trustOrigin === "user-keyboard"
  ) {
    return { source: bypass.source, trustOrigin: "user-keyboard", explicitUserAction: true };
  }
  if (bypass.source === "local-api-approval") {
    const origin = bypass.trustOrigin as TrustOrigin;
    if (isExternalOrigin(origin)) {
      return { source: "local-api-approval", trustOrigin: origin, explicitUserAction: true };
    }
  }
  return undefined;
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
  const approvalBypass = resolveApprovalBypass(bypass);
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
