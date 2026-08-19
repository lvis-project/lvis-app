/**
 * Shared event payloads for `PERMISSIONS.*` IPC channels.
 *
 * Single source of truth for the wire shapes that cross the
 * main↔renderer boundary on the permissions domain. Keeping these
 * types in one module prevents drift between the emitter
 * (`permission-manager.ts`), the preload bridge (`preload.ts`), and
 * any future renderer typings (`ui/renderer/types.ts`).
 *
 * Issue: #802 (code-reviewer LOW finding — inline duplicates across 3+ sites).
 */

/**
 * Approval-scope literal. Hoisted from inline `"session" | "persistent"`
 * unions so renderer types (`ui/renderer/types.ts`) can share the same
 * SOT as the IPC payload. Cross-cutting follow-up of #802.
 */
export type UserApprovalScope = "session" | "persistent";

/**
 * Exact-tuple decision stored for a user-reviewed tool invocation.
 *
 * Legacy entries pre-date this field and therefore normalize to `"allow"`.
 * A stored deny is created only from Settings and is matched against the same
 * tool + canonical input + source/trust tuple as an exact allow.
 */
export type UserApprovalDecision = "allow" | "deny";

/**
 * Approval-verdict literal. Same rationale as `UserApprovalScope`.
 *
 * NOTE: this is the verdict captured at approval time. Older on-disk
 * entries (written before the field existed) may carry
 * `null` in storage; the broadcaster in `permission-manager.ts` coerces
 * nullable stored values up to this non-null surface before emit so
 * downstream consumers (the chat-toast subscriber) can rely on a
 * concrete verdict literal.
 */
export type UserApprovalVerdict = "low" | "medium" | "high";

/**
 * Resolve the host-sealed risk level used by exact permission decisions.
 *
 * Approval surfaces use this same function when they hand a live request to
 * Settings. Keeping the fallback here prevents renderer wording or a missing
 * reviewer verdict from drifting away from the host snapshot (`shell=high`,
 * `read=low`, everything else=medium).
 */
export function resolveUserApprovalVerdict(input: {
  reviewerVerdict?: { level?: unknown };
  toolCategory?: string;
}): UserApprovalVerdict {
  const reviewed = input.reviewerVerdict?.level;
  if (reviewed === "low" || reviewed === "medium" || reviewed === "high") {
    return reviewed;
  }
  if (input.toolCategory === "shell") return "high";
  if (input.toolCategory === "read") return "low";
  return "medium";
}

/**
 * Emitted on the `PERMISSIONS.userApprovalHit` channel when a
 * memory hit auto-approves a tool call. The renderer surfaces this to
 * the user as a non-blocking disclosure so the audit-trail intent of
 * NL justification (#691) is preserved for subsequent auto-approves.
 *
 * Wire-shape boundary: this is a TYPE-level contract only. Payloads
 * crossing the IPC boundary are NOT structurally validated by importing
 * this type. Main-side broadcasters and renderer-side listeners must
 * each guard their direction if a wire-shape mismatch is security-
 * relevant. (Cross-cutting review of PRs #822-#827 — security-reviewer
 * MINOR.)
 */
export interface UserApprovalHitPayload {
  toolName: string;
  scope: UserApprovalScope;
  verdictAtApproval: UserApprovalVerdict;
}

export type PermissionReviewSuggestionReason = "allow-always" | "repeat-allow";

/**
 * Emitted when the foreground default-mode approval pattern suggests the user
 * would benefit from switching to LLM-backed permission review. This is a
 * non-blocking hint; the renderer must require an explicit user gesture before
 * mutating the permission/reviewer settings.
 */
export interface PermissionReviewSuggestionPayload {
  reason: PermissionReviewSuggestionReason;
  allowCount: number;
  allowAlwaysCount: number;
  threshold: number;
  windowMs: number;
}
