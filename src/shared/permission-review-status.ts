export type PermissionReviewStatus =
  | "reviewing"
  | "needs_approval"
  | "auto_approved"
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
