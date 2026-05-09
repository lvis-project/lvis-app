/**
 * Permissions domain IPC handlers.
 * Covers: lvis:permission:*, lvis:approval:*, lvis:policy:*
 */
import { ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import { loadPolicy, savePolicy } from "../../permissions/policy-store.js";
import type { ApprovalDecision } from "../../permissions/approval-gate.js";
import { PERMISSIONS } from "../../shared/ipc-channels.js";
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

  // ── Permission policy — `/permission dir` slash dispatcher (IPC) ──────────
  ipcMain.handle(
    PERMISSIONS.dirDispatch,
    async (e, args: { rawArgs: string }) => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, PERMISSIONS.dirDispatch, e);
        return UNAUTHORIZED_FRAME;
      }
      const { parsePermissionDirCommand, dispatchPermissionDirCommand } =
        await import("../../permissions/permission-slash.js");
      const parsed = parsePermissionDirCommand(args?.rawArgs ?? "");
      if ("ok" in parsed && parsed.ok === false) return parsed;
      return dispatchPermissionDirCommand(parsed as Exclude<typeof parsed, { ok: false }>);
    },
  );

  // ── Permission policy — `/permission reviewer` slash dispatcher (IPC) ─────
  ipcMain.handle(
    PERMISSIONS.reviewerDispatch,
    async (e, args: { rawArgs: string }) => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, PERMISSIONS.reviewerDispatch, e);
        return UNAUTHORIZED_FRAME;
      }
      const { parsePermissionReviewerCommand, dispatchPermissionReviewerCommand } =
        await import("../../permissions/permission-slash.js");
      const parsed = parsePermissionReviewerCommand(args?.rawArgs ?? "");
      if ("ok" in parsed && parsed.ok === false) return parsed;
      return dispatchPermissionReviewerCommand(parsed as Exclude<typeof parsed, { ok: false }>);
    },
  );

  // ── Permission policy — deferred queue surface ────────────────────────────
  // Returns DLP-redacted tool inputs + verdicts; gated to prevent a
  // compromised foreign frame from harvesting them (Copilot round 3).
  ipcMain.handle(PERMISSIONS.deferredList, async (e) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, PERMISSIONS.deferredList, e);
      return UNAUTHORIZED_FRAME;
    }
    const pm = conversationLoop.permissionManager;
    const queue = pm?.getDeferredQueue();
    if (!queue) return { ok: true, pending: [], total: 0 };
    return { ok: true, pending: queue.listPending(), total: queue.size() };
  });

  ipcMain.handle(PERMISSIONS.hookTrustList, async (e) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, PERMISSIONS.hookTrustList, e);
      return UNAUTHORIZED_FRAME;
    }
    const { listHookTrustState } = await import(
      "../../hooks/hook-trust-commands.js"
    );
    const state = listHookTrustState();
    return {
      ok: true,
      active: state.active,
      disabled: state.disabled,
      totalDisabled: state.disabled.length,
    };
  });

  // Resolve a pending entry — gated. The renderer's button click
  // dispatches with `decision` ∈ {"approved","rejected"}.
  ipcMain.handle(
    PERMISSIONS.deferredResolve,
    async (
      e,
      params: { id: string; decision: "approved" | "rejected"; reason?: string },
    ) => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, PERMISSIONS.deferredResolve, e);
        return UNAUTHORIZED_FRAME;
      }
      if (
        !params ||
        typeof params.id !== "string" ||
        (params.decision !== "approved" && params.decision !== "rejected") ||
        (
          params.reason !== undefined &&
          (typeof params.reason !== "string" || params.reason.length > 1_000)
        )
      ) {
        return { ok: false, error: "invalid-params" };
      }
      const pm = conversationLoop.permissionManager;
      const queue = pm?.getDeferredQueue();
      if (!queue) return { ok: false, error: "no-deferred-queue" };
      const current = queue.get(params.id);
      if (!current) return { ok: false, error: "not-found" };
      if (current.status !== "pending") return { ok: true, entry: current };
      if (!auditLogger.isPermissionAuditChainReady()) {
        return { ok: false, error: "permission-audit-not-ready" };
      }
      const resolved = await queue.resolve(params.id, params.decision, params.reason);
      if (!resolved) return { ok: false, error: "not-found" };
      await auditLogger.appendPermissionAuditEntry({
        decision: "deferred_resolve",
        auditId: randomUUID(),
        ts: resolved.resolvedAt ?? new Date().toISOString(),
        trustOrigin: "user-keyboard",
        tool: resolved.toolName,
        source: resolved.source,
        category: resolved.category,
        reviewerVerdict: resolved.verdict,
        queueId: resolved.id,
        resolution: params.decision,
        ...(params.reason ? { reason: params.reason } : {}),
      });
      return { ok: true, entry: resolved };
    },
  );

  // ── Permission policy — `/permission audit show|verify` IPC handlers ─────
  // Audit entries can contain DLP-redacted tool inputs and decision
  // metadata; gated so foreign frames cannot harvest them (Copilot
  // round 3).
  ipcMain.handle(
    PERMISSIONS.auditShow,
    async (e, args: { last?: number }) => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, PERMISSIONS.auditShow, e);
        return UNAUTHORIZED_FRAME;
      }
      const last = Math.max(1, Math.min(1000, Math.floor(args?.last ?? 50)));
      const { readRecentAuditEntries, summarizeAuditDir } = await import(
        "../../permissions/permission-audit-runner.js"
      );
      const dir = auditLogger.getAuditDir();
      const entries = readRecentAuditEntries(dir, last);
      const summary = summarizeAuditDir(dir);
      return { ok: true, entries, total: entries.length, summary };
    },
  );

  ipcMain.handle(PERMISSIONS.auditVerify, async (e) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, PERMISSIONS.auditVerify, e);
      return UNAUTHORIZED_FRAME;
    }
    const { verifyAllAuditFiles } = await import(
      "../../permissions/permission-audit-runner.js"
    );
    const secret = auditLogger.getPermissionAuditSecret();
    if (!secret) {
      return {
        ok: false,
        error: "audit-chain-not-initialized",
      };
    }
    const sealStore = auditLogger.getPermissionAuditSealStore() ?? undefined;
    const dir = auditLogger.getAuditDir();
    const result = verifyAllAuditFiles(dir, secret, sealStore);
    return {
      ok: true,
      intact: result.intact,
      totalFiles: result.totalFiles,
      totalEntries: result.totalEntries,
      firstBrokenFile: result.firstBrokenFile,
      perDay: result.perDay.map((d) => ({
        file: d.file,
        totalLines: d.totalLines,
        chainOk: d.result.ok,
        firstBrokenLineIndex: d.result.ok ? undefined : d.result.firstBrokenLineIndex,
        reason: d.result.ok ? undefined : d.result.reason,
        sealMatch: d.sealMatch,
      })),
    };
  });

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
