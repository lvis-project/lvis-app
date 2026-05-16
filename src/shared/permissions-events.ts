/**
 * Shared event payloads for `PERMISSIONS.*` IPC channels.
 *
 * Single source of truth for the wire shapes that cross the
 * main↔renderer boundary on the permissions domain. Keeping these
 * types in one module prevents drift between the emitter
 * (`permission-manager.ts`), the preload bridge (`preload.ts`), and
 * any future renderer typings (`ui/renderer/types.ts`).
 *
 * Issue: #802 (PR-A4 R3 code-reviewer LOW finding — inline duplicates
 * across 3+ sites).
 */

/**
 * Emitted on the `PERMISSIONS.userApprovalHit` channel when an R-2
 * memory hit auto-approves a tool call. The renderer surfaces this to
 * the user as a non-blocking disclosure so the audit-trail intent of
 * R-4 NL justification (#691) is preserved for subsequent auto-approves.
 */
export interface UserApprovalHitPayload {
  toolName: string;
  scope: "session" | "persistent";
  verdictAtApproval: "low" | "medium" | "high";
}
