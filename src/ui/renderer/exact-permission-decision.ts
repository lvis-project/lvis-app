import type { UserApprovalVerdict } from "../../shared/permissions-events.js";
import type { ToolSource } from "../../shared/permission-review-status.js";

/**
 * Unsaved Settings draft derived from one live, host-sealed approval request.
 * The main process re-binds `requestId` to its own raw args/source/trust tuple
 * before persisting, so these renderer fields are display-only context.
 */
export interface ExactDenyDraft {
  requestId: string;
  toolName: string;
  args: unknown;
  source: ToolSource;
  trustOrigin?: string;
  approvalCacheKey?: string;
  verdictAtApproval: UserApprovalVerdict;
}
