/**
 * Tool pipeline — pending reviewer-authorization store (TTL + cap collaborator).
 *
 * Extracted from `executor.ts` (C7 decomposition). Owns the in-memory Map of
 * conversational-reviewer "blocked-then-explicitly-authorized" verdicts: the
 * foreground reviewer records a non-LOW verdict here, and a later user-keyboard
 * approval phrase (`explicitAuthorizationIntent`) for the SAME exact action
 * consumes it. Identity, TTL expiry, and the pending-cap eviction all live here.
 */
import { createHash } from "node:crypto";
import type { ToolSource } from "../types.js";
import type { PermissionCheckResult } from "../../permissions/permission-manager.js";
import type { RiskVerdict } from "../../permissions/reviewer/risk-classifier.js";
import { canonicalStringify } from "../../permissions/user-approval-store.js";
import { detectApprovalIntent } from "../../permissions/approval-intent.js";
import type { ToolPermissionContext } from "../executor.js";

const REVIEWER_AUTHORIZATION_TTL_MS = 10 * 60 * 1000;
const REVIEWER_AUTHORIZATION_MAX_PENDING = 64;

interface PendingReviewerAuthorization {
  expiresAt: number;
  verdict: RiskVerdict;
}

export class ReviewerAuthorizationStore {
  private readonly pending = new Map<string, PendingReviewerAuthorization>();

  private key(input: {
    sessionId: string;
    toolName: string;
    source: ToolSource;
    finalInput: Record<string, unknown>;
    context: ToolPermissionContext;
  }): string {
    const components = [
      input.sessionId,
      input.toolName,
      input.source,
      canonicalStringify(input.finalInput),
      input.context.trustOrigin,
      input.context.approvalCacheKey ?? "",
    ];
    // Join on NUL so component boundaries can never collide with content.
    return createHash("sha256").update(components.join(String.fromCharCode(0))).digest("hex");
  }

  private prune(now = Date.now()): void {
    for (const [key, pending] of this.pending) {
      if (pending.expiresAt <= now) {
        this.pending.delete(key);
      }
    }
  }

  private cap(): void {
    while (this.pending.size >= REVIEWER_AUTHORIZATION_MAX_PENDING) {
      const oldestKey = this.pending.keys().next().value;
      if (!oldestKey) return;
      this.pending.delete(oldestKey);
    }
  }

  record(input: {
    sessionId: string | undefined;
    toolName: string;
    source: ToolSource;
    finalInput: Record<string, unknown>;
    context: ToolPermissionContext;
    verdict: RiskVerdict;
  }): void {
    if (input.context.headless === true) return;
    if (!input.sessionId) return;
    const now = Date.now();
    this.prune(now);
    const key = this.key({ ...input, sessionId: input.sessionId });
    if (!this.pending.has(key)) {
      this.cap();
    }
    this.pending.set(
      key,
      {
        expiresAt: now + REVIEWER_AUTHORIZATION_TTL_MS,
        verdict: input.verdict,
      },
    );
  }

  consume(input: {
    sessionId: string | undefined;
    toolName: string;
    source: ToolSource;
    finalInput: Record<string, unknown>;
    context: ToolPermissionContext;
  }): PermissionCheckResult | null {
    if (input.context.headless === true) return null;
    if (!input.sessionId) return null;
    const intent = detectApprovalIntent(input.context.explicitAuthorizationIntent ?? "");
    if (intent.kind !== "approve") return null;
    const now = Date.now();
    this.prune(now);
    const key = this.key({ ...input, sessionId: input.sessionId });
    const pending = this.pending.get(key);
    if (!pending) return null;
    this.pending.delete(key);
    return {
      decision: "allow",
      reason:
        `explicit user authorization (${intent.matchedPhrase}) after reviewer ` +
        `${pending.verdict.level}: ${pending.verdict.reason}`,
      layer: 5,
      reviewer: { route: "foreground-auto", verdict: pending.verdict },
    };
  }
}
