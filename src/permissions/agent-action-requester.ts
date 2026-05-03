/**
 * agent-action-requester.ts — §8 Agent Hub approval caller
 *
 * Thin wrapper around ApprovalGate.requestAndWait() for plugin clients
 * (specifically lvis-plugin-agent-hub's decide-approval-with-host handler).
 *
 * Responsibility split:
 *   - Caller (plugin): supplies toolName, args, reason, source, sourcePluginId.
 *   - This module: builds a minimal ApprovalRequest (id, createdAt, category)
 *     and delegates to ApprovalGate which mints nonce + HMAC.
 *   - Plugin MUST NOT compute nonce/HMAC — those are gate-internal §D2 fields.
 *
 * Returns only the ApprovalChoice so callers don't need to unwrap
 * ApprovalDecision (nonce/hmac fields are verification artefacts, not outputs).
 */

import { randomUUID } from "node:crypto";
import type { ApprovalGate } from "./approval-gate.js";
import type { ApprovalChoice } from "./approval-gate.js";

export interface AgentApprovalInput {
  toolName: string;
  args: unknown;
  reason: string;
  source: "plugin";
  sourcePluginId: string;
}

/**
 * Request approval via the §8 ApprovalGate on behalf of a plugin.
 *
 * The gate generates nonce + HMAC internally (§D2 confused-deputy defense).
 * On timeout the gate returns deny-once; this function propagates that
 * choice without masking the error path.
 *
 * @param gate    - The live ApprovalGate instance (injected by the IPC layer).
 * @param input   - Approval request metadata from the plugin.
 * @returns       - The user's ApprovalChoice.
 */
export async function requestAgentApproval(
  gate: ApprovalGate,
  input: AgentApprovalInput,
): Promise<ApprovalChoice> {
  const decision = await gate.requestAndWait({
    id: randomUUID(),
    category: "tool",
    toolName: input.toolName,
    args: input.args,
    reason: input.reason,
    source: input.source,
    createdAt: Date.now(),
  });
  return decision.choice;
}
