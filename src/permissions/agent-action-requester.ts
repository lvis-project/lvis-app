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
  /** Wall-clock ms at which this entry was recorded — used by `purgeStalerThan`. */
  recordedAt: number;
}

/**
 * ApprovalIssuerRegistry — maps pending approval request IDs to their issuer.
 *
 * Lifecycle:
 *   - `record(requestId, pluginId, scope)` — called before gate.requestAndWait().
 *   - `consume(requestId)` — called in the respond path; returns entry and removes it.
 *     Returns null if no entry (already consumed or never issued).
 *
 * The registry is intentionally a plain Map (no LRU cap) because
 * ApprovalGate already enforces a 5-minute timeout per request, after which
 * it removes the pending entry and resolves deny-once. The issuer registry
 * entry survives until `consume()` is called by the respond path; timed-out
 * requests whose `consume()` is never called are cleaned up by
 * `purgeStalerThan()` which the gate timeout callback should trigger.
 */
export class ApprovalIssuerRegistry {
  private readonly entries = new Map<string, IssuerEntry>();

  record(requestId: string, issuerPluginId: string, scope: string): void {
    this.entries.set(requestId, {
      issuerPluginId,
      scope,
      recordedAt: Date.now(),
    });
  }

  /**
   * Retrieve and remove the issuer entry for `requestId`.
   * Returns null if the entry was never recorded or already consumed.
   */
  consume(requestId: string): IssuerEntry | null {
    const entry = this.entries.get(requestId);
    if (!entry) return null;
    this.entries.delete(requestId);
    return entry;
  }

  /**
   * Explicit deletion (no-op if absent). Used by `requestAgentApproval`'s
   * try-finally to prune the entry when the gate throws — without this the
   * entry would leak until `purgeStalerThan` runs.
   */
  delete(requestId: string): void {
    this.entries.delete(requestId);
  }

  /**
   * Non-destructive lookup — returns the entry if present, undefined otherwise.
   * Does NOT remove the entry (unlike `consume`). Intended for testing and
   * diagnostic code paths only; production code should use `consume`.
   */
  peek(requestId: string): IssuerEntry | undefined {
    return this.entries.get(requestId);
  }

  /**
   * Remove all entries older than `maxAgeMs` milliseconds from `now`.
   * Called by the gate timeout path to prevent unbounded growth when
   * the respond path is never reached (e.g. renderer crash).
   *
   * Returns the count of purged entries.
   */
  purgeStalerThan(maxAgeMs: number, now: number = Date.now()): number {
    const cutoff = now - maxAgeMs;
    let purged = 0;
    for (const [requestId, entry] of this.entries) {
      if (entry.recordedAt < cutoff) {
        this.entries.delete(requestId);
        purged += 1;
      }
    }
    return purged;
  }

  get size(): number {
    return this.entries.size;
  }
}

/**
 * **Internal helper.** Plugin code MUST call `hostApi.agentApproval.request()`
 * — `requestAgentApproval` is the host-side wiring that the HostApi factory
 * binds to. Direct callers must hold the live `ApprovalGate` and shared
 * `ApprovalIssuerRegistry` references and are expected to be host-internal
 * code paths only.
 *
 * Request approval via the §8 ApprovalGate on behalf of a plugin.
 *
 * Records the (requestId → issuerPluginId, scope) mapping in the
 * provided registry BEFORE calling the gate, so the respond path can
 * verify origin + scope without a race.
 *
 * The gate generates nonce + HMAC internally (§D2 confused-deputy defense).
 * On timeout the gate returns deny-once; this function propagates that
 * choice without masking the error path. If `gate.requestAndWait` throws,
 * the registry entry recorded above is removed in the `finally` block so
 * a thrown gate cannot leak issuer entries (AC1.4).
 *
 * @param gate     - The live ApprovalGate instance (injected by the IPC layer).
 * @param registry - Shared ApprovalIssuerRegistry for origin tracking.
 * @param input    - Approval request metadata from the plugin.
 * @returns        - The user's ApprovalChoice.
 */
export async function requestAgentApproval(
  gate: ApprovalGate,
  input: AgentApprovalInput,
  registry?: ApprovalIssuerRegistry,
): Promise<ApprovalChoice> {
  const requestId = randomUUID();

  // Record issuer BEFORE gate.requestAndWait() so the respond path
  // always sees the entry regardless of how fast the user responds.
  registry?.record(requestId, input.sourcePluginId, input.scope);

  let settled = false;
  try {
    const decision = await gate.requestAndWait({
      id: requestId,
      category: "tool",
      toolName: input.toolName,
      args: input.args,
      reason: input.reason,
      source: input.source,
      createdAt: Date.now(),
    });
    settled = true;
    return decision.choice;
  } finally {
    // On gate throw (settled=false) we must purge the entry we just
    // recorded, otherwise a subsequent malicious respond() with the same
    // id (replay or guessed UUID) could see a leaked issuer mapping.
    // On normal resolve we leave the entry — the respond path consumes it.
    if (!settled) registry?.delete(requestId);
  }
}

/**
 * Verify that `responderPluginId` is authorized to respond to `requestId`.
 *
 * Checks:
 *   (a) entry exists in registry (request was issued by this process)
 *   (b) responderPluginId == entry.issuerPluginId
 *   (c) entry.scope is listed in allowedScopes (issuer's agentApprovalScopes)
 *
 * Throws `ApprovalOriginError` on any violation — no silent fallback (§No-Fallback).
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
  const entry = registry.consume(requestId);

  if (!entry) {
    throw new ApprovalOriginError(
      `[approval-gating] respond denied: no pending approval found for requestId='${requestId}' — unknown or already consumed`,
      "unknown-request",
    );
  }

  if (entry.issuerPluginId !== responderPluginId) {
    // Re-insert so the legitimate issuer can still respond (best-effort)
    registry.record(requestId, entry.issuerPluginId, entry.scope);
    throw new ApprovalOriginError(
      `[approval-gating] respond denied: cross-plugin attack detected — ` +
      `responder='${responderPluginId}' is not the issuer='${entry.issuerPluginId}' ` +
      `for requestId='${requestId}'`,
      "cross-plugin-hijack",
    );
  }

  if (!allowedScopes.includes(entry.scope)) {
    throw new ApprovalOriginError(
      `[approval-gating] respond denied: scope='${entry.scope}' is not in ` +
      `issuer='${responderPluginId}' agentApprovalScopes=[${allowedScopes.join(",")}] ` +
      `for requestId='${requestId}'`,
      "scope-not-allowed",
    );
  }

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
