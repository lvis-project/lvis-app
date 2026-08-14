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
