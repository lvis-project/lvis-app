/**
 * Outcome of the permission review chain for one tool call, as the transcript
 * shows it.
 *
 * `parent_approved` / `parent_denied` name the second tier of the sub-agent
 * approval chain: a child's ask that the automatic reviewer left at `ask` was
 * decided by the child's own parent agent instead of by the user. They are
 * deliberately distinct from `auto_approved` and from a user answer — a reader
 * partitioning the transcript by who decided a call must not have to infer it
 * from a chip that says only "approved".
 */
export type PermissionReviewStatus =
  | "reviewing"
  | "needs_approval"
  | "auto_approved"
  | "parent_approved"
  | "parent_denied"
  | "failed";

export type PermissionReviewRiskLevel = "low" | "medium" | "high";

export type ApprovalPurposeSuggestion = {
  text: string;
  source: "conversation" | "tool-input";
  confidence: "sufficient" | "insufficient";
};

/**
 * The one grammar for a share-safe coarse tool identifier derived from a
 * permission review ("builtin:list_files"). Every boundary that forwards the
 * identifier toward a remote surface validates against this single predicate
 * so the producer and the egress checks cannot drift. Identifier characters
 * only — no whitespace, no control characters, nothing that could smuggle
 * tool arguments or path material.
 */
const SHARED_APPROVAL_TOOL_IDENTIFIER = /^[A-Za-z0-9_.:/-]{1,128}$/;

export function isSharedApprovalToolIdentifier(value: unknown): value is string {
  return typeof value === "string" && SHARED_APPROVAL_TOOL_IDENTIFIER.test(value);
}

export type PermissionReviewEvent = {
  status: PermissionReviewStatus;
  toolName: string;
  toolCategory?: "read" | "write" | "shell" | "network" | "meta";
  source?: "builtin" | "plugin" | "mcp";
  groupId: string;
  toolUseId: string;
  displayOrder: number;
  verdictLevel?: PermissionReviewRiskLevel;
  reason?: string;
  approvalPurpose?: ApprovalPurposeSuggestion;
};
