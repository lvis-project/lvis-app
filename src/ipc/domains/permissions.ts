/**
 * Permissions domain IPC handlers.
 * Covers: lvis:permission:*, lvis:approval:*, lvis:policy:*
 */
import { ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import { loadPolicy, savePolicy } from "../../permissions/policy-store.js";
import type { ApprovalDecision } from "../../permissions/approval-gate.js";
import { PERMISSIONS } from "../../shared/ipc-channels.js";
import { hasUserKeyboardIntent } from "../../shared/chat-origin.js";
import { validateSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import { sendToWindow } from "../safe-send.js";
import type { IpcDeps } from "../types.js";
import type {
  PermissionDirCommand,
  PermissionModeCommand,
  PermissionReviewerCommand,
  PermissionRulesCommand,
} from "../../permissions/permission-slash.js";

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

function requireUserKeyboardIntent(payload: unknown): { ok: true } | { ok: false; error: string; message: string } {
  if (hasUserKeyboardIntent(payload)) return { ok: true };
  return {
    ok: false,
    error: "user-keyboard-required",
    message: "이 권한 변경은 활성 사용자 제스처에서만 실행할 수 있습니다.",
  };
}

function payloadRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isParseError<T>(value: T | { ok: false; error: string }): value is { ok: false; error: string } {
  return "ok" in (value as Record<string, unknown>) && (value as { ok?: unknown }).ok === false;
}

function broadcastPermissionModeChanged(deps: IpcDeps, mode: string): void {
  const mainWindow = deps.getMainWindow?.();
  const windows = deps.getAppWindows?.() ?? [mainWindow];
  for (const win of windows) {
    sendToWindow(win, PERMISSIONS.modeChanged, { mode });
  }
}

export function registerPermissionsHandlers(deps: IpcDeps): void {
  const { conversationLoop, approvalGate, auditLogger } = deps;
  const deferredResolveInFlight = new Set<string>();

  // read-only, sender guard optional
  ipcMain.handle(PERMISSIONS.getMode, () => {
    const mode = conversationLoop.permissionManager?.getMode() ?? "default";
    return { mode };
  });

  ipcMain.handle(PERMISSIONS.setMode, async (e, payload: unknown) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, PERMISSIONS.setMode, e); return UNAUTHORIZED_FRAME; }
    const body = payloadRecord(payload);
    const intent = requireUserKeyboardIntent(body.intent);
    if (!intent.ok) return intent;
    const mode = body.mode;
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
    const pm = conversationLoop.permissionManager;
    if (!pm) return { ok: false, error: "no-permission-manager", message: "권한 매니저가 초기화되지 않았습니다." };
    const { applyPermissionModeCommand } = await import("../../permissions/permission-mode-apply.js");
    const result = await applyPermissionModeCommand(parsed, {
      permissionManager: pm,
      approvalGate,
      auditLogger,
    });
    if (!result.ok) return result;
    broadcastPermissionModeChanged(deps, result.mode);
    return { ok: true, mode: result.mode };
  });

  // read-only, sender guard optional
  ipcMain.handle(PERMISSIONS.listRules, async () => {
    const pm = conversationLoop.permissionManager;
    if (!pm) return [];
    return pm.listPersistedRules();
  });

  ipcMain.handle(PERMISSIONS.addRule, async (e, payload: unknown) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, PERMISSIONS.addRule, e); return UNAUTHORIZED_FRAME; }
    const body = payloadRecord(payload);
    const intent = requireUserKeyboardIntent(body.intent);
    if (!intent.ok) return intent;
    const action = body.action;
    if (action !== "allow" && action !== "deny") {
      return { ok: false, error: "invalid-action", message: `유효하지 않은 action: '${action}'. 허용값: allow, deny` };
    }
    const validated = validateRulePatternInput(body.pattern);
    if (!validated.ok) return validated;
    const { parsePermissionRulesCommand } = await import("../../permissions/permission-slash.js");
    const parsed = parsePermissionRulesCommand(`add ${action} ${validated.pattern}`);
    if (isParseError<PermissionRulesCommand>(parsed)) return { ok: false, error: "parse-error", message: parsed.error };
    if (parsed.sub !== "add") return { ok: false, error: "parse-error", message: "add rule command did not parse as add" };
    const pm = conversationLoop.permissionManager;
    if (!pm) return { ok: false, error: "no-permission-manager", message: "권한 매니저가 초기화되지 않았습니다." };
    try {
      if (parsed.action === "allow") {
        await pm.addAlwaysAllowedPersist(parsed.pattern);
      } else {
        await pm.addAlwaysDeniedPersist(parsed.pattern);
      }
      deps.toolRegistry.setDenyRules(pm.getVisibilityDenyRules());
      return { ok: true, rule: { pattern: parsed.pattern, action: parsed.action } };
    } catch (err) {
      return { ok: false, error: "add-failed", message: (err as Error).message };
    }
  });

  ipcMain.handle(PERMISSIONS.removeRule, async (e, payload: unknown) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, PERMISSIONS.removeRule, e); return UNAUTHORIZED_FRAME; }
    const body = payloadRecord(payload);
    const intent = requireUserKeyboardIntent(body.intent);
    if (!intent.ok) return intent;
    const action = body.action;
    if (action !== "allow" && action !== "deny") {
      return { ok: false, error: "invalid-action", message: `유효하지 않은 action: '${action}'. 허용값: allow, deny` };
    }
    const validated = validateRulePatternInput(body.pattern);
    if (!validated.ok) return validated;
    const { parsePermissionRulesCommand } = await import("../../permissions/permission-slash.js");
    const parsed = parsePermissionRulesCommand(`remove ${action} ${validated.pattern}`);
    if (isParseError<PermissionRulesCommand>(parsed)) return { ok: false, error: "parse-error", message: parsed.error };
    if (parsed.sub !== "remove") return { ok: false, error: "parse-error", message: "remove rule command did not parse as remove" };
    const pm = conversationLoop.permissionManager;
    if (!pm) return { ok: false, error: "no-permission-manager", message: "권한 매니저가 초기화되지 않았습니다." };
    try {
      await pm.removeRule(parsed.pattern, parsed.action);
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
      const { parsePermissionDirCommand, dispatchPermissionDirCommand } =
        await import("../../permissions/permission-slash.js");
      const parsed = parsePermissionDirCommand(args?.rawArgs ?? "");
      if (isParseError<PermissionDirCommand>(parsed)) return { ok: false, error: parsed.error };
      if (parsed.verb !== "list") {
        const intent = requireUserKeyboardIntent((args as { intent?: unknown } | undefined)?.intent);
        if (!intent.ok) return intent;
      }
      const result = await dispatchPermissionDirCommand(parsed);
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
      const { parsePermissionReviewerCommand, dispatchPermissionReviewerCommandWithRewire } =
        await import("../../permissions/permission-slash.js");
      const parsed = parsePermissionReviewerCommand(args?.rawArgs ?? "");
      if (isParseError<PermissionReviewerCommand>(parsed)) return { ok: false, error: parsed.error };
      if (parsed.verb !== "show") {
        const intent = requireUserKeyboardIntent((args as { intent?: unknown } | undefined)?.intent);
        if (!intent.ok) return intent;
      }
      return dispatchPermissionReviewerCommandWithRewire(parsed, deps.rewireReviewerAgent);
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
      params: {
        id: string;
        decision: "approved" | "rejected";
        reason?: string;
        intent?: unknown;
        /**
         * Issue #690 P4 — provenance of the approval gesture. "button"
         * means the user clicked a panel button (existing path);
         * "natural-language" means the renderer's intent matcher
         * recognised an in-chat phrase AND the user explicitly
         * confirmed via the suggestion chip. Required: callers must
         * explicitly declare provenance for audit-chain entries.
         */
        approvalSource: "button" | "natural-language";
      },
    ) => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, PERMISSIONS.deferredResolve, e);
        return UNAUTHORIZED_FRAME;
      }
      const intent = requireUserKeyboardIntent(params?.intent);
      if (!intent.ok) return intent;
      if (
        !params ||
        typeof params.id !== "string" ||
        (params.decision !== "approved" && params.decision !== "rejected") ||
        (
          params.reason !== undefined &&
          (typeof params.reason !== "string" || params.reason.length > 1_000)
        ) ||
        (params.approvalSource !== "button" && params.approvalSource !== "natural-language")
      ) {
        return { ok: false, error: "invalid-params" };
      }
      const approvalSource = params.approvalSource;
      const pm = conversationLoop.permissionManager;
      const queue = pm?.getDeferredQueue();
      if (!queue) return { ok: false, error: "no-deferred-queue" };
      if (deferredResolveInFlight.has(params.id)) {
        return { ok: false, error: "already-resolving" };
      }
      deferredResolveInFlight.add(params.id);
      try {
        const current = queue.get(params.id);
        if (!current) return { ok: false, error: "not-found" };
        if (current.status !== "pending") {
          if (current.status === params.decision) return { ok: true, entry: current };
          return { ok: false, error: "already-resolved", entry: current };
        }
        if (!auditLogger.isPermissionAuditChainReady()) {
          return { ok: false, error: "permission-audit-not-ready" };
        }
        const auditReason =
          approvalSource === "natural-language"
            ? "natural-language chip click"
            : params.reason;
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
            approvalSource,
            ...(auditReason ? { reason: auditReason } : {}),
          });
        } catch (err) {
          return {
            ok: false,
            error: "permission-audit-write-failed",
            message: (err as Error).message,
          };
        }
        const resolved = await queue.resolve(params.id, params.decision, auditReason);
        if (!resolved) return { ok: false, error: "not-found" };
        if (resolved.status !== params.decision) {
          return { ok: false, error: "already-resolved", entry: resolved };
        }
        return { ok: true, entry: resolved };
      } finally {
        deferredResolveInFlight.delete(params.id);
      }
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

  ipcMain.handle(PERMISSIONS.policySet, async (e, payload: unknown) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, PERMISSIONS.policySet, e); return UNAUTHORIZED_FRAME; }
    const body = payloadRecord(payload);
    const intent = requireUserKeyboardIntent(body.intent);
    if (!intent.ok) return intent;
    const patch = payloadRecord(body.patch);
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
