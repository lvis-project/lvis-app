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
) => Promise<AgentActionApprovalReceipt | null>;

export interface AgentActionApprovalReceipt {
  /** Host-generated ApprovalGate request/decision correlation identifier. */
  decisionId: string;
  decidedAt: string;
}

/**
 * Build a fail-closed, single-flight ApprovalGate adapter for host mutations.
 *
 * The caller owns the user-facing reason and supplies only host-derived labels.
 * Diagnostics are best-effort and receive tool/origin identity but never the
 * possibly sensitive argument payload or raw gate error. Agent actions are
 * host-constrained one-shot decisions: there is no exact-memory consumer on
 * this mutation seam, so the UI must not imply that `allow-always` persists.
 */
export function buildSingleFlightAgentActionApprover(
  approvalGate: Pick<ApprovalGate, "requestAndWait"> | undefined,
  diagnostics: AgentActionApprovalDiagnostics = {},
  options: Readonly<{ allowOnceOnly?: boolean }> = {},
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
      return null;
    }

    pending = true;
    try {
      // Keep the legacy option in the builder signature for call-site
      // compatibility, but every agent action is now explicitly one-shot.
      // A disabled, visible Always allow control explains this constraint.
      void options;
      const decision = await approvalGate.requestAndWait({
        id: randomUUID(),
        category: "agent-action",
        kind: "agent-action",
        allowedChoices: ["allow-once", "deny-once"] as const,
        durableApprovalRecordAllowed: false as const,
        toolName,
        toolCategory: "meta",
        args,
        reason,
        source: "builtin",
        createdAt: Date.now(),
        trustOrigin,
      });
      // The request constraint is defense in depth, not the only boundary:
      // injected/test gates and future adapters cannot turn the one-shot grant
      // into a durable receipt by returning another allow kind.
      const allowed = decision.choice === "allow-once";
      return allowed
        ? Object.freeze({ decisionId: decision.requestId, decidedAt: new Date().toISOString() })
        : null;
    } catch {
      try {
        diagnostics.onError?.(diagnostic);
      } catch {
        // Diagnostic failures must not change the fail-closed decision.
      }
      return null;
    } finally {
      pending = false;
    }
  };
}
