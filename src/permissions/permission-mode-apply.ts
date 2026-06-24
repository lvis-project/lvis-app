import { randomUUID } from "node:crypto";
import type { AuditLogger } from "../audit/audit-logger.js";
import { t } from "../i18n/index.js";
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

export interface PermissionModeApprovalBypass {
  source: "settings-ui" | "builtin-slash";
  trustOrigin: "user-keyboard";
  explicitUserAction: true;
}

export async function applyPermissionModeCommand(
  cmd: PermissionModeCommand,
  deps: {
    permissionManager: PermissionManager;
    approvalGate?: ApprovalGate;
    auditLogger?: Pick<AuditLogger, "isPermissionAuditChainReady" | "appendPermissionAuditEntry">;
    approvalBypass?: PermissionModeApprovalBypass;
  },
): Promise<PermissionModeApplyResult> {
  const previous = deps.permissionManager.getMode();

  const hasTrustedBuiltInConfirmation =
    deps.approvalBypass?.explicitUserAction === true &&
    deps.approvalBypass.trustOrigin === "user-keyboard" &&
    (deps.approvalBypass.source === "settings-ui" || deps.approvalBypass.source === "builtin-slash");

  if (cmd.durable && !hasTrustedBuiltInConfirmation) {
    if (!deps.approvalGate) {
      return {
        ok: false,
        error: "approval-gate-unavailable",
        message: t("be_permissionModeApply.approvalGateUnavailable"),
      };
    }
    const decision = await deps.approvalGate.requestAndWait({
      id: randomUUID(),
      category: "tool",
      toolName: "/permission mode",
      toolCategory: "meta",
      args: { fromMode: previous, toMode: cmd.mode, durable: true },
      reason: t("be_permissionModeApply.approvalReason", { mode: cmd.mode }),
      source: "builtin",
      createdAt: Date.now(),
      trustOrigin: "user-keyboard",
      isReadOnly: false,
      mode: "default",
    });
    if (decision.choice !== "allow-once" && decision.choice !== "allow-always") {
      return {
        ok: false,
        error: "durable-mode-denied",
        message: t("be_permissionModeApply.durableModeDenied"),
      };
    }
  }

  if (deps.auditLogger) {
    if (!deps.auditLogger.isPermissionAuditChainReady()) {
      return {
        ok: false,
        error: "permission-audit-not-ready",
        message: t("be_permissionModeApply.auditChainNotReady"),
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
        confirmationSource: hasTrustedBuiltInConfirmation ? deps.approvalBypass?.source : undefined,
      });
    } catch (err) {
      return {
        ok: false,
        error: "permission-audit-write-failed",
        message: t("be_permissionModeApply.auditWriteFailed", { message: (err as Error).message }),
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
