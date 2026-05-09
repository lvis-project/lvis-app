/**
 * Permissions domain IPC handlers.
 * Covers: lvis:permission:*, lvis:approval:*, lvis:policy:*
 */
import { ipcMain } from "electron";
import { loadPolicy, savePolicy } from "../../permissions/policy-store.js";
import type { ApprovalDecision } from "../../permissions/approval-gate.js";
import { validateSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import type { IpcDeps } from "../types.js";

export function registerPermissionsHandlers(deps: IpcDeps): void {
  const { conversationLoop, approvalGate, auditLogger } = deps;

  // read-only, sender guard optional
  ipcMain.handle("lvis:permission:get-mode", () => {
    const mode = conversationLoop.permissionManager?.getMode() ?? "default";
    return { mode };
  });

  ipcMain.handle("lvis:permission:set-mode", async (e, mode: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:permission:set-mode", e); return UNAUTHORIZED_FRAME; }
    const VALID_MODES = ["default", "strict", "auto"] as const;
    if (!VALID_MODES.includes(mode as typeof VALID_MODES[number])) {
      return { ok: false, error: "invalid-mode", message: `유효하지 않은 실행 모드: '${mode}'. 허용값: ${VALID_MODES.join(", ")}` };
    }
    const pm = conversationLoop.permissionManager;
    if (pm) {
      await pm.setModePersist(mode as import("../../permissions/permission-manager.js").ExecutionMode);
    }
    return { ok: true, mode };
  });

  // read-only, sender guard optional
  ipcMain.handle("lvis:permission:list-rules", async () => {
    const pm = conversationLoop.permissionManager;
    if (!pm) return [];
    return pm.listPersistedRules();
  });

  ipcMain.handle("lvis:permission:add-rule", async (e, pattern: string, action: "allow" | "deny") => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:permission:add-rule", e); return UNAUTHORIZED_FRAME; }
    const normalized = pattern.trim();
    if (typeof pattern !== "string" || normalized.length === 0) {
      return { ok: false, error: "invalid-pattern", message: "패턴은 빈 문자열일 수 없습니다." };
    }
    if (normalized.length > 128) {
      return { ok: false, error: "invalid-pattern", message: "패턴은 128자를 초과할 수 없습니다." };
    }
    if (action !== "allow" && action !== "deny") {
      return { ok: false, error: "invalid-action", message: `유효하지 않은 action: '${action}'. 허용값: allow, deny` };
    }
    const pm = conversationLoop.permissionManager;
    if (!pm) return { ok: false, error: "no-permission-manager", message: "권한 매니저가 초기화되지 않았습니다." };
    try {
      if (action === "allow") {
        await pm.addAlwaysAllowedPersist(normalized);
      } else {
        await pm.addAlwaysDeniedPersist(normalized);
      }
      deps.toolRegistry.setDenyRules(pm.getVisibilityDenyRules());
      return { ok: true, rule: { pattern: normalized, action } };
    } catch (err) {
      return { ok: false, error: "add-failed", message: (err as Error).message };
    }
  });

  ipcMain.handle("lvis:permission:remove-rule", async (e, pattern: string, action: "allow" | "deny") => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:permission:remove-rule", e); return UNAUTHORIZED_FRAME; }
    const pm = conversationLoop.permissionManager;
    if (!pm) return { ok: false, error: "no-permission-manager", message: "권한 매니저가 초기화되지 않았습니다." };
    try {
      await pm.removeRule(pattern, action);
      deps.toolRegistry.setDenyRules(pm.getVisibilityDenyRules());
      return { ok: true };
    } catch (err) {
      return { ok: false, error: "remove-failed", message: (err as Error).message };
    }
  });

  // lvis:approval:request direction is main→renderer (webContents.send) — no ipcMain.handle needed
  ipcMain.handle("lvis:approval:respond", (e, decision: ApprovalDecision) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:approval:respond", e); return UNAUTHORIZED_FRAME; }
    if (approvalGate) {
      approvalGate.resolve(decision.requestId, decision);
    }
    return { ok: true };
  });

  // read-only, sender guard optional
  ipcMain.handle("lvis:policy:get", async () => {
    return loadPolicy();
  });

  // ── Q12 P3 — `/permission reviewer` slash dispatcher (IPC) ─────
  ipcMain.handle(
    "lvis:permissions:reviewer-dispatch",
    async (e, args: { rawArgs: string }) => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, "lvis:permissions:reviewer-dispatch", e);
        return UNAUTHORIZED_FRAME;
      }
      const { parsePermissionReviewerCommand, dispatchPermissionReviewerCommand } =
        await import("../../permissions/permission-slash.js");
      const parsed = parsePermissionReviewerCommand(args?.rawArgs ?? "");
      if ("ok" in parsed && parsed.ok === false) return parsed;
      return dispatchPermissionReviewerCommand(parsed as Exclude<typeof parsed, { ok: false }>);
    },
  );

  // ── Q12 P3 — deferred queue surface ────────────────────────────
  // Read-only listing (UI loads on mount). Sender guard optional.
  ipcMain.handle("lvis:permissions:deferred-list", async () => {
    const pm = conversationLoop.permissionManager;
    const queue = pm?.getDeferredQueue();
    if (!queue) return { ok: true, pending: [], total: 0 };
    return { ok: true, pending: queue.listPending(), total: queue.size() };
  });

  // Resolve a pending entry — gated. The renderer's button click
  // dispatches with `decision` ∈ {"approved","rejected"}.
  ipcMain.handle(
    "lvis:permissions:deferred-resolve",
    async (
      e,
      params: { id: string; decision: "approved" | "rejected"; reason?: string },
    ) => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, "lvis:permissions:deferred-resolve", e);
        return UNAUTHORIZED_FRAME;
      }
      if (
        !params ||
        typeof params.id !== "string" ||
        (params.decision !== "approved" && params.decision !== "rejected")
      ) {
        return { ok: false, error: "invalid-params" };
      }
      const pm = conversationLoop.permissionManager;
      const queue = pm?.getDeferredQueue();
      if (!queue) return { ok: false, error: "no-deferred-queue" };
      const resolved = await queue.resolve(params.id, params.decision, params.reason);
      if (!resolved) return { ok: false, error: "not-found" };
      return { ok: true, entry: resolved };
    },
  );

  ipcMain.handle("lvis:policy:set", async (e, patch: Record<string, unknown>) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "lvis:policy:set", e); return UNAUTHORIZED_FRAME; }
    if ("managed" in patch) {
      return { ok: false, error: "invalid-patch", message: "'managed' 필드는 사용자가 변경할 수 없습니다." };
    }
    if ("requireExplicitApproval" in patch && typeof patch.requireExplicitApproval !== "boolean") {
      return { ok: false, error: "invalid-patch", message: "'requireExplicitApproval'은 boolean이어야 합니다." };
    }
    try {
      const updated = await savePolicy(patch as Parameters<typeof savePolicy>[0]);
      if (approvalGate) {
        approvalGate.setPolicy(updated);
      }
      return { ok: true, policy: updated };
    } catch (err) {
      return { ok: false, error: "managed", message: (err as Error).message };
    }
  });
}
