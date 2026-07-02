import { randomUUID } from "node:crypto";
import type { AuditLogger } from "../audit/audit-logger.js";
import { t } from "../i18n/index.js";
import type { ExternalOrigin } from "../contract/trust-origin.js";
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

/**
 * The explicit-user-action confirmation an out-of-band caller has ALREADY
 * obtained for a durable permission set-mode mutation, so
 * {@link applyPermissionModeCommand} does NOT show a second in-app approval
 * modal. Two discriminated variants for the two confirmation surfaces:
 *
 *   - `built-in` (`"settings-ui"` / `"builtin-slash"`) — a first-party renderer
 *     user action. `trustOrigin` is `"user-keyboard"` (the physical key/click).
 *
 *   - `local-api-approval` (#1409) — an EXTERNAL origin (local-api / cli)
 *     initiated the change and the user consented via the in-app ApprovalGate
 *     modal at the transport-lifecycle layer (see
 *     `src/main/local-api-server.ts`) BEFORE the handler ran. The ApprovalGate
 *     "Allow" click IS the explicit user action; the {@link ExternalOrigin}
 *     records WHO initiated it. Widening the guard for this variant is what
 *     prevents a DOUBLE modal — the consent already happened.
 *
 * Fail-closed: any other source/trustOrigin combination does NOT satisfy the
 * built-in-confirmation guard and falls through to the normal ApprovalGate ask.
 */
export type PermissionModeApprovalBypass =
  | {
      source: "settings-ui" | "builtin-slash";
      trustOrigin: "user-keyboard";
      explicitUserAction: true;
    }
  | {
      source: "local-api-approval";
      /** The external origin that initiated the (already user-approved) change. */
      trustOrigin: ExternalOrigin;
      explicitUserAction: true;
    };

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

  // A durable mode change skips the in-app ApprovalGate ask ONLY when the
  // caller supplies an explicit-user-action confirmation obtained on a trusted
  // surface. Two accepted surfaces (see PermissionModeApprovalBypass):
  //   - first-party renderer built-in (settings-ui / builtin-slash) with a
  //     "user-keyboard" gesture, OR
  //   - "local-api-approval" (#1409): an external origin whose durable change
  //     the user ALREADY consented to via the ApprovalGate modal at the
  //     transport-lifecycle layer. Honoring it here is deliberate — it prevents
  //     a SECOND modal for a mutation the human just approved. It is NOT a
  //     silent bypass: no "local-api-approval" bypass is ever constructed unless
  //     `local-api-server.ts` observed a real ApprovalGate "allow" decision.
  const bypass = deps.approvalBypass;
  const hasTrustedBuiltInConfirmation =
    bypass?.explicitUserAction === true &&
    ((bypass.source === "settings-ui" || bypass.source === "builtin-slash"
      ? bypass.trustOrigin === "user-keyboard"
      : false) ||
      bypass.source === "local-api-approval");

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
        confirmationSource: hasTrustedBuiltInConfirmation ? bypass?.source : undefined,
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
