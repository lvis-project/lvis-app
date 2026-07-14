import { randomUUID } from "node:crypto";
import type { ApprovalGate } from "./approval-gate.js";

/** Host-built description of one non-tool mutation that needs explicit consent. */
export interface AgentActionApprovalRequest {
  toolName: string;
  args: unknown;
  reason: string;
  trustOrigin: string;
}

/** Redacted diagnostic identity. Raw request arguments never cross this seam. */
export interface AgentActionApprovalDiagnostic {
  toolName: string;
  trustOrigin: string;
}

export interface AgentActionApprovalDiagnostics {
  onConcurrent?: (diagnostic: AgentActionApprovalDiagnostic) => void;
  onError?: (diagnostic: AgentActionApprovalDiagnostic) => void;
}

export type AgentActionApprover = (
  request: AgentActionApprovalRequest,
) => Promise<boolean>;

/**
 * Build a fail-closed, single-flight ApprovalGate adapter for host mutations.
 *
 * The caller owns the user-facing reason and supplies only host-derived labels.
 * Diagnostics are best-effort and receive tool/origin identity but never the
 * possibly sensitive argument payload or raw gate error. An `allow-always`
 * decision authorizes this invocation only:
 * the adapter deliberately ignores `rememberPattern` and keeps no allow cache.
 */
export function buildSingleFlightAgentActionApprover(
  approvalGate: Pick<ApprovalGate, "requestAndWait"> | undefined,
  diagnostics: AgentActionApprovalDiagnostics = {},
): AgentActionApprover | undefined {
  if (!approvalGate) return undefined;

  let pending = false;
  return async ({ toolName, args, reason, trustOrigin }) => {
    const diagnostic: AgentActionApprovalDiagnostic = { toolName, trustOrigin };
    if (pending) {
      try {
        diagnostics.onConcurrent?.(diagnostic);
      } catch {
        // Diagnostic failures must not change the fail-closed decision.
      }
      return false;
    }

    pending = true;
    try {
      const decision = await approvalGate.requestAndWait({
        id: randomUUID(),
        category: "agent-action",
        kind: "agent-action",
        toolName,
        toolCategory: "meta",
        args,
        reason,
        source: "builtin",
        createdAt: Date.now(),
        trustOrigin,
      });
      return decision.choice.startsWith("allow");
    } catch {
      try {
        diagnostics.onError?.(diagnostic);
      } catch {
        // Diagnostic failures must not change the fail-closed decision.
      }
      return false;
    } finally {
      pending = false;
    }
  };
}
