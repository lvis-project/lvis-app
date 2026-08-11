import type { UserApprovalVerdict } from "../../shared/permissions-events.js";

/**
 * Unsaved Settings draft derived from one live, host-sealed approval request.
 * The main process re-binds `requestId` to its own raw args/source/trust tuple
 * before persisting, so these renderer fields are display-only context.
 */
export interface ExactDenyDraft {
  requestId: string;
  toolName: string;
  args: unknown;
  source: "builtin" | "plugin" | "mcp";
  trustOrigin?: string;
  approvalCacheKey?: string;
  verdictAtApproval: UserApprovalVerdict;
}
