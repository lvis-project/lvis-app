/**
 * agent-action-requester.ts — §8 Agent Hub approval caller + issuer registry
 *
 * Thin wrapper around ApprovalGate.requestAndWait() for plugin clients
 * (specifically lvis-plugin-agent-hub's decide-approval-with-host handler).
 *
 * Responsibility split:
 *   - Caller (plugin): supplies toolName, args, reason, source, sourcePluginId, scope.
 *   - This module: builds a minimal ApprovalRequest (id, createdAt, category),
 *     records issuer plugin id + scope in the ApprovalIssuerRegistry, and
 *     delegates to ApprovalGate which mints nonce + HMAC.
 *   - Plugin MUST NOT compute nonce/HMAC — those are gate-internal §D2 fields.
 *
 * Returns only the ApprovalChoice so callers don't need to unwrap
 * ApprovalDecision (nonce/hmac fields are verification artefacts, not outputs).
 *
 * §security P0 — IPC origin gating (issue #71):
 *   ApprovalIssuerRegistry records (requestId → { issuerPluginId, scope }) at
 *   request time. The respond path verifies:
 *     (a) sender plugin id == issuer plugin id
 *     (b) scope is listed in issuer's manifest pluginAccess.agentApprovalScopes
 *   Violations throw — no silent fallback.
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
  /** Approval action scope — must be listed in issuer's agentApprovalScopes. */
  scope: string;
}

/** Per-request issuer metadata recorded at requestAgentApproval() time. */
interface IssuerEntry {
  issuerPluginId: string;
  scope: string;
  recordedAt: number;
}

/**
 * ApprovalIssuerRegistry — maps pending approval request IDs to their issuer.
 *
 * Lifecycle:
 *   - `record(requestId, pluginId, scope)` — called before gate.requestAndWait().
 *   - `peek(requestId)` — returns entry without removing it (used in verifyApprovalResponder).
 *   - `delete(requestId)` — removes entry after successful verification.
 *     Call only after all checks pass; on violation leave the entry so the
 *     legitimate issuer can still respond.
 *
 * The registry is intentionally a plain Map (no LRU cap) because
 * ApprovalGate already enforces a 5-minute timeout per request, after which
 * it removes the pending entry and resolves deny-once. The issuer registry
 * entry survives until `delete()` is called by the respond path; timed-out
 * requests whose `delete()` is never called are cleaned up by
 * `purgeStalerThan()` which the gate timeout callback should trigger.
 */
export class ApprovalIssuerRegistry {
  private readonly entries = new Map<string, IssuerEntry>();

  record(requestId: string, issuerPluginId: string, scope: string): void {
    this.entries.set(requestId, { issuerPluginId, scope, recordedAt: Date.now() });
  }

  /**
   * Return the issuer entry for `requestId` WITHOUT removing it.
   * Returns undefined if the entry was never recorded.
   */
  peek(requestId: string): IssuerEntry | undefined {
    return this.entries.get(requestId);
  }

  /**
   * Remove the issuer entry for `requestId`.
   * No-op if the entry does not exist.
   */
  delete(requestId: string): void {
    this.entries.delete(requestId);
  }

  /**
   * Remove all entries recorded more than `maxAgeMs` milliseconds ago.
   * Called by the gate timeout path to prevent unbounded growth when
   * the respond path is never reached (e.g. renderer crash).
   *
   * Each entry carries a `recordedAt` timestamp so this method performs
   * true age-based eviction rather than clearing everything.
   *
   * @returns Number of entries purged.
   */
  purgeStalerThan(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    let purged = 0;
    for (const [id, entry] of this.entries) {
      if (entry.recordedAt < cutoff) {
        this.entries.delete(id);
        purged++;
      }
    }
    return purged;
  }

  get size(): number {
    return this.entries.size;
  }
}

/**
 * Request approval via the §8 ApprovalGate on behalf of a plugin.
 *
 * Records the (requestId → issuerPluginId, scope) mapping in the
 * provided registry BEFORE calling the gate, so the respond path can
 * verify origin + scope without a race.
 *
 * The gate generates nonce + HMAC internally (§D2 confused-deputy defense).
 * On timeout the gate returns deny-once; this function propagates that
 * choice without masking the error path.
 *
 * @param gate     - The live ApprovalGate instance (injected by the IPC layer).
 * @param registry - Shared ApprovalIssuerRegistry for origin tracking.
 * @param input    - Approval request metadata from the plugin.
 * @returns        - The user's ApprovalChoice.
 */
export async function requestAgentApproval(
  gate: ApprovalGate,
  input: AgentApprovalInput,
  registry: ApprovalIssuerRegistry,
): Promise<ApprovalChoice> {
  const requestId = randomUUID();

  // Record issuer BEFORE gate.requestAndWait() so the respond path
  // always sees the entry regardless of how fast the user responds.
  registry.record(requestId, input.sourcePluginId, input.scope);

  const decision = await gate.requestAndWait({
    id: requestId,
    category: "tool",
    toolName: input.toolName,
    args: input.args,
    reason: input.reason,
    source: input.source,
    createdAt: Date.now(),
  });
  return decision.choice;
}

/**
 * Env-based feature flag for §8 P0 approval origin gating.
 *
 * - `false` (default): soft mode — log violation but DO NOT throw.
 *   Used during v0.2.x → v0.2.x+1 transition to surface regressions
 *   without hard-breaking existing plugin deployments.
 * - `true`: hard enforcement — throws ApprovalOriginError on any violation.
 *   Set `LVIS_FEATURE_APPROVAL_ORIGIN_GATING=true` in production when all
 *   plugins have been validated. Flip to default-true in next minor release.
 */
function isHardEnforce(): boolean {
  return process.env["LVIS_FEATURE_APPROVAL_ORIGIN_GATING"] === "true";
}

/**
 * Verify that `responderPluginId` is authorized to respond to `requestId`.
 *
 * Checks:
 *   (a) entry exists in registry (request was issued by this process)
 *   (b) responderPluginId == entry.issuerPluginId
 *   (c) entry.scope is listed in allowedScopes (issuer's agentApprovalScopes)
 *
 * Hard enforcement: throws `ApprovalOriginError` on any violation (§No-Fallback).
 * Soft mode (default): logs the violation and returns entry to avoid hard-breaking
 * existing plugin deployments during rollout. Controlled by
 * `LVIS_FEATURE_APPROVAL_ORIGIN_GATING` env var.
 *
 * Consumes the entry from the registry on success.
 *
 * @param registry          - Shared ApprovalIssuerRegistry.
 * @param requestId         - The approval request ID being responded to.
 * @param responderPluginId - Plugin id of the IPC caller.
 * @param allowedScopes     - agentApprovalScopes from responder's manifest.
 * @returns                 - The consumed IssuerEntry (for audit logging).
 */
export function verifyApprovalResponder(
  registry: ApprovalIssuerRegistry,
  requestId: string,
  responderPluginId: string,
  allowedScopes: string[],
): IssuerEntry {
  // Peek first — do NOT remove until all checks pass.
  // This prevents a race where a failed hijack attempt would delete the
  // entry, blocking the legitimate issuer from responding.
  const entry = registry.peek(requestId);

  if (!entry) {
    const error = new ApprovalOriginError(
      `[approval-gating] respond denied: no pending approval found for requestId='${requestId}' — unknown or already consumed`,
      "unknown-request",
    );
    if (!isHardEnforce()) {
      console.warn(`[approval-gating-soft] would have denied: ${error.message}`);
      // Soft mode: cannot return entry (none exists); re-throw as a non-fatal
      // unknown-request is the one case where soft mode still throws because
      // there is no entry to proceed with.
      throw error;
    }
    throw error;
  }

  if (entry.issuerPluginId !== responderPluginId) {
    // Registry untouched — legitimate issuer can still respond.
    const error = new ApprovalOriginError(
      `[approval-gating] respond denied: cross-plugin attack detected — ` +
      `responder='${responderPluginId}' is not the issuer='${entry.issuerPluginId}' ` +
      `for requestId='${requestId}'`,
      "cross-plugin-hijack",
    );
    if (!isHardEnforce()) {
      console.warn(`[approval-gating-soft] would have denied: ${error.message}`);
      return entry; // proceed with original entry in soft mode
    }
    throw error;
  }

  if (!allowedScopes.includes(entry.scope)) {
    // Registry untouched — caller may fix scope declaration and retry.
    const error = new ApprovalOriginError(
      `[approval-gating] respond denied: scope='${entry.scope}' is not in ` +
      `issuer='${responderPluginId}' agentApprovalScopes=[${allowedScopes.join(",")}] ` +
      `for requestId='${requestId}'`,
      "scope-not-allowed",
    );
    if (!isHardEnforce()) {
      console.warn(`[approval-gating-soft] would have denied: ${error.message}`);
      return entry; // proceed with original entry in soft mode
    }
    throw error;
  }

  // All checks passed — now delete the entry to prevent double-respond.
  registry.delete(requestId);
  return entry;
}

/** Thrown by verifyApprovalResponder on any origin/scope violation. */
export class ApprovalOriginError extends Error {
  readonly code: "unknown-request" | "cross-plugin-hijack" | "scope-not-allowed";
  constructor(message: string, code: ApprovalOriginError["code"]) {
    super(message);
    this.name = "ApprovalOriginError";
    this.code = code;
  }
}
