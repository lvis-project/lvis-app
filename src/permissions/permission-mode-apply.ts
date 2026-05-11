import { randomUUID } from "node:crypto";
import type { AuditLogger } from "../audit/audit-logger.js";
import type { ApprovalGate } from "./approval-gate.js";
import type { PermissionManager } from "./permission-manager.js";
import type { PermissionModeCommand } from "./permission-slash.js";

export type PermissionModeApplyResult =
  | {
      ok: true;
      previous: string;
      mode: PermissionModeCommand["mode"];
      durable: boolean;
    }
  | {
      ok: false;
      error: string;
      message: string;
    };

export async function applyPermissionModeCommand(
  cmd: PermissionModeCommand,
  deps: {
    permissionManager: PermissionManager;
    approvalGate?: ApprovalGate;
    auditLogger?: Pick<AuditLogger, "isPermissionAuditChainReady" | "appendPermissionAuditEntry">;
  },
): Promise<PermissionModeApplyResult> {
  const previous = deps.permissionManager.getMode();

  if (cmd.durable) {
    if (!deps.approvalGate) {
      return {
        ok: false,
        error: "approval-gate-unavailable",
        message: "영구 권한 모드 변경은 사용자 확인 모달이 필요합니다.",
      };
    }
    const decision = await deps.approvalGate.requestAndWait({
      id: randomUUID(),
      category: "tool",
      toolName: "/permission mode",
      toolCategory: "meta",
      args: { fromMode: previous, toMode: cmd.mode, durable: true },
      reason: `권한 모드를 '${cmd.mode}'로 영구 저장합니다.`,
      source: "builtin",
      createdAt: Date.now(),
      trustOrigin: "user-keyboard",
      isReadOnly: false,
      mode: "default",
    });
    if (!decision.choice.startsWith("allow")) {
      return {
        ok: false,
        error: "durable-mode-denied",
        message: "영구 권한 모드 변경이 취소되었습니다.",
      };
    }
  }

  if (deps.auditLogger) {
    if (!deps.auditLogger.isPermissionAuditChainReady()) {
      return {
        ok: false,
        error: "permission-audit-not-ready",
        message: "권한 감사 체인이 초기화되지 않았습니다.",
      };
    }
    try {
      await deps.auditLogger.appendPermissionAuditEntry({
        decision: "mode_change",
        auditId: randomUUID(),
        ts: new Date().toISOString(),
        trustOrigin: "user-keyboard",
        fromMode: previous,
        toMode: cmd.mode,
        durable: cmd.durable,
      });
    } catch (err) {
      return {
        ok: false,
        error: "permission-audit-write-failed",
        message: `권한 감사 기록에 실패했습니다: ${(err as Error).message}`,
      };
    }
  }

  if (cmd.durable) {
    await deps.permissionManager.setModePersist(cmd.mode);
  } else {
    deps.permissionManager.setMode(cmd.mode);
  }

  return {
    ok: true,
    previous,
    mode: cmd.mode,
    durable: cmd.durable,
  };
}
