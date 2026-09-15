import { t } from "../../i18n/index.js";
import {
  isHostApprovalTimeoutDecision,
  type ApprovalDecision,
} from "../../permissions/approval-gate.js";
import type { PermissionCheckResult } from "../../permissions/permission-manager.js";

/** Preserve the gate's host-owned expiration in both tool and directory asks. */
export function approvalExpiryOutcome(
  decision: ApprovalDecision,
  toolName: string,
  permission: PermissionCheckResult,
): { content: string; permission: PermissionCheckResult } | null {
  if (!isHostApprovalTimeoutDecision(decision)) return null;
  const reason = "approval request expired";
  return {
    content: t("be_executor.approvalExpired", { name: toolName }),
    permission: {
      ...permission,
      decision: "deny",
      reason,
      // A preceding policy result describes why approval was requested; the
      // denial audit must describe why that request actually ended.
      denyReasons: [{ layer: permission.layer, source: "approval-gate", reason }],
    },
  };
}
