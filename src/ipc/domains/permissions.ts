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

function validateRulePatternInput(pattern: unknown): { ok: true; pattern: string } | { ok: false; error: string; message: string } {
  if (typeof pattern !== "string") {
    return { ok: false, error: "invalid-pattern", message: "패턴은 문자열이어야 합니다." };
  }
  const normalized = pattern.trim();
  if (normalized.length === 0) {
    return { ok: false, error: "invalid-pattern", message: "패턴은 빈 문자열일 수 없습니다." };
  }
  if (normalized.length > 128) {
    return { ok: false, error: "invalid-pattern", message: "패턴은 128자를 초과할 수 없습니다." };
  }
  if (/\s/.test(normalized)) {
    return { ok: false, error: "invalid-pattern", message: "패턴에는 공백을 포함할 수 없습니다." };
  }
  return { ok: true, pattern: normalized };
}

export function registerPermissionsHandlers(deps: IpcDeps): void {
  const { conversationLoop, approvalGate, auditLogger } = deps;

  // read-only, sender guard optional
  ipcMain.handle(PERMISSIONS.getMode, () => {
    const mode = conversationLoop.permissionManager?.getMode() ?? "default";
    return { mode };
  });

  ipcMain.handle(PERMISSIONS.setMode, async (e, mode: string) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, PERMISSIONS.setMode, e); return UNAUTHORIZED_FRAME; }
    const { dispatchPermissionSlash } = await import("../../permissions/permission-slash.js");
    const outcome = dispatchPermissionSlash(`/permission mode ${mode} --durable`, "user-keyboard");
    if (outcome.kind === "parse-error") {
      return { ok: false, error: "invalid-mode", message: outcome.error };
    }
    if (outcome.kind !== "mode") {
      return { ok: false, error: "invalid-command", message: "permission mode command dispatch failed" };
    }
    if (outcome.needsModal !== true) {
      return { ok: false, error: "missing-durable-confirm", message: "durable mode command must require modal confirmation" };
    }
    const pm = conversationLoop.permissionManager;
    if (!pm) return { ok: false, error: "no-permission-manager", message: "권한 매니저가 초기화되지 않았습니다." };
    const { applyPermissionModeCommand } = await import("../../permissions/permission-mode-apply.js");
    const result = await applyPermissionModeCommand(outcome.cmd, {
      permissionManager: pm,
      approvalGate,
      auditLogger,
    });
    if (!result.ok) return result;
    return { ok: true, mode: result.mode };
  });

  // read-only, sender guard optional
  ipcMain.handle(PERMISSIONS.listRules, async () => {
    const pm = conversationLoop.permissionManager;
    if (!pm) return [];
    return pm.listPersistedRules();
  });

  ipcMain.handle(PERMISSIONS.addRule, async (e, pattern: string, action: "allow" | "deny") => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, PERMISSIONS.addRule, e); return UNAUTHORIZED_FRAME; }
    if (action !== "allow" && action !== "deny") {
      return { ok: false, error: "invalid-action", message: `유효하지 않은 action: '${action}'. 허용값: allow, deny` };
    }
    const validated = validateRulePatternInput(pattern);
    if (!validated.ok) return validated;
    const { dispatchPermissionSlash } = await import("../../permissions/permission-slash.js");
    const outcome = dispatchPermissionSlash(`/permission rules add ${action} ${validated.pattern}`, "user-keyboard");
    if (outcome.kind === "parse-error") return { ok: false, error: "parse-error", message: outcome.error };
    if (outcome.kind !== "rules" || outcome.cmd.sub !== "add") {
      return { ok: false, error: "invalid-command", message: "permission rules add command dispatch failed" };
    }
    const pm = conversationLoop.permissionManager;
    if (!pm) return { ok: false, error: "no-permission-manager", message: "권한 매니저가 초기화되지 않았습니다." };
    try {
      if (outcome.cmd.action === "allow") {
        await pm.addAlwaysAllowedPersist(outcome.cmd.pattern);
      } else {
        await pm.addAlwaysDeniedPersist(outcome.cmd.pattern);
      }
      deps.toolRegistry.setDenyRules(pm.getVisibilityDenyRules());
      return { ok: true, rule: { pattern: outcome.cmd.pattern, action: outcome.cmd.action } };
    } catch (err) {
      return { ok: false, error: "add-failed", message: (err as Error).message };
    }
  });

  ipcMain.handle(PERMISSIONS.removeRule, async (e, pattern: string, action: "allow" | "deny") => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, PERMISSIONS.removeRule, e); return UNAUTHORIZED_FRAME; }
    if (action !== "allow" && action !== "deny") {
      return { ok: false, error: "invalid-action", message: `유효하지 않은 action: '${action}'. 허용값: allow, deny` };
    }
    const validated = validateRulePatternInput(pattern);
    if (!validated.ok) return validated;
    const { dispatchPermissionSlash } = await import("../../permissions/permission-slash.js");
    const outcome = dispatchPermissionSlash(`/permission rules remove ${action} ${validated.pattern}`, "user-keyboard");
    if (outcome.kind === "parse-error") return { ok: false, error: "parse-error", message: outcome.error };
    if (outcome.kind !== "rules" || outcome.cmd.sub !== "remove") {
      return { ok: false, error: "invalid-command", message: "permission rules remove command dispatch failed" };
    }
    const pm = conversationLoop.permissionManager;
    if (!pm) return { ok: false, error: "no-permission-manager", message: "권한 매니저가 초기화되지 않았습니다." };
    try {
      await pm.removeRule(outcome.cmd.pattern, outcome.cmd.action);
      deps.toolRegistry.setDenyRules(pm.getVisibilityDenyRules());
      return { ok: true };
    } catch (err) {
      return { ok: false, error: "remove-failed", message: (err as Error).message };
    }
  });

  // lvis:approval:request direction is main→renderer (webContents.send) — no ipcMain.handle needed
  ipcMain.handle(PERMISSIONS.approvalRespond, (e, decision: ApprovalDecision) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, PERMISSIONS.approvalRespond, e); return UNAUTHORIZED_FRAME; }
    if (approvalGate) {
      approvalGate.resolve(decision.requestId, decision);
    }
    return { ok: true };
  });

  // read-only, sender guard optional
  ipcMain.handle(PERMISSIONS.policyGet, async () => {
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
      const { dispatchPermissionSlash, dispatchPermissionDirCommand } =
        await import("../../permissions/permission-slash.js");
      const outcome = dispatchPermissionSlash(`/permission dir ${args?.rawArgs ?? ""}`, "user-keyboard");
      if (outcome.kind === "parse-error") return { ok: false, error: outcome.error };
      if (outcome.kind !== "dir") return { ok: false, error: "invalid permission dir command" };
      const result = await dispatchPermissionDirCommand(outcome.cmd);
      if (result.ok && result.verb === "allow" && result.sessionOnly && result.sessionDirectory) {
        conversationLoop.addSessionAdditionalDirectory(result.sessionDirectory);
      }
      return result;
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
      const { dispatchPermissionSlash, dispatchPermissionReviewerCommand } =
        await import("../../permissions/permission-slash.js");
      const outcome = dispatchPermissionSlash(`/permission reviewer ${args?.rawArgs ?? ""}`, "user-keyboard");
      if (outcome.kind === "parse-error") return { ok: false, error: outcome.error };
      if (outcome.kind !== "reviewer") return { ok: false, error: "invalid permission reviewer command" };
      const result = await dispatchPermissionReviewerCommand(outcome.cmd);
      if (result.ok && outcome.cmd.verb !== "show") {
        deps.rewireReviewerAgent?.();
      }
      return result;
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
      try {
        await auditLogger.appendPermissionAuditEntry({
          decision: "deferred_resolve",
          auditId: randomUUID(),
          ts: new Date().toISOString(),
          trustOrigin: "user-keyboard",
          tool: current.toolName,
          source: current.source,
          category: current.category,
          reviewerVerdict: current.verdict,
          queueId: current.id,
          resolution: params.decision,
          ...(params.reason ? { reason: params.reason } : {}),
        });
      } catch (err) {
        return {
          ok: false,
          error: "permission-audit-write-failed",
          message: (err as Error).message,
        };
      }
      const resolved = await queue.resolve(params.id, params.decision, params.reason);
      if (!resolved) return { ok: false, error: "not-found" };
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

  ipcMain.handle(PERMISSIONS.policySet, async (e, patch: Record<string, unknown>) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, PERMISSIONS.policySet, e); return UNAUTHORIZED_FRAME; }
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
