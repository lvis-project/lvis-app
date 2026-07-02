/**
 * Boot §4.2 / §8 — plugin approval-origin gating helpers.
 *
 * Extracted from `plugin-runtime.ts` (C5, behavior-preserving). Holds the
 * module-level ApprovalIssuerRegistry singleton plus the AC1.5 audit helper.
 * The singleton is defined ONCE here and imported by the host-api factory — a
 * second instance would break approval gating state.
 */
import { createLogger } from "../../../lib/logger.js";
import type { AuditEntry } from "../../../audit/audit-logger.js";
import {
  ApprovalIssuerRegistry,
  ApprovalOriginError,
} from "../../../permissions/agent-action-requester.js";

const log = createLogger("lvis");

/**
 * AC1.5 audit helper — logs an approval violation then re-throws the original
 * error. Extracted so the try-catch logic can be unit-tested without wiring the
 * full initPluginRuntime context.
 *
 * Guarantees: if `auditLogger.log` throws, that error is swallowed (non-fatal)
 * and `err` is still re-thrown to the caller.
 *
 * @internal — exported for testing only; production code calls this via the
 *             `respond()` closure inside initPluginRuntime.
 */
export function auditApprovalViolation(
  err: unknown,
  auditLogger: { log(entry: AuditEntry): void },
  pluginId: string,
  requestId: string,
): never {
  try {
    auditLogger.log({
      timestamp: new Date().toISOString(),
      sessionId: "approval-gating",
      type: "error",
      input: err instanceof ApprovalOriginError
        ? `[${err.code}] plugin='${pluginId}' requestId='${requestId}' ${err.message}`
        : `[approval-gating] plugin='${pluginId}' requestId='${requestId}' ${String(err)}`,
    });
  } catch (auditErr) {
    log.warn(
      "approval-gating audit log failed (non-fatal): %s",
      (auditErr as Error).message,
    );
  }
  throw err;
}

/**
 * §8 P0 security — shared issuer registry for agent approval origin gating.
 * Instantiated once per boot (module-level singleton). Records
 * (requestId → issuerPluginId + scope) at request time so the respond path
 * can verify cross-plugin attacks and scope violations.
 */
export const approvalIssuerRegistry = new ApprovalIssuerRegistry();
