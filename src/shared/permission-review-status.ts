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

/** Where a tool comes from. Drives the §6.4 source → trust mapping. */
export type ToolSource = "builtin" | "plugin" | "mcp";

/**
 * Permission policy 5-axis tool category (PermissionManager Layer 3 decision
 * matrix in permission-policy-design.md):
 *
 * - `read`    — automatically allowed for builtin, scope-checked for plugin
 * - `write`   — ask (user confirmation)
 * - `shell`   — ask + Bash AST validation (subset of write where command
 *               structure must be parsed)
 * - `network` — ask + endpoint surface (HTTP/IPC writes to external hosts)
 * - `meta`    — control-flow / UI primitives (`ask_user_question`,
 *               `agent_spawn`); decision delegated to `ToolDecisionOverride`
 *               so executor short-circuit paths stay explicit.
 */
export type ToolCategory = "read" | "write" | "shell" | "network" | "meta";

/** Reviewer verdict level — discrete enum. The reviewer lane never uses scalars. */
export type RiskLevel = "low" | "medium" | "high";

/**
 * Grant breadth for a deferred approval. No "once": the call it would have
 * scoped is already over — a post-hoc "once" would grant nothing and expire
 * against nothing. The honest breadths are the two that outlive the dead
 * call, and `"session"` is the narrower of them, so it is the default and
 * the fallback for any ambiguous request.
 */
export type DeferredGrantScope = "session" | "always";

/** Narrowest breadth a deferred approval can carry. */
export const NARROWEST_DEFERRED_SCOPE: DeferredGrantScope = "session";

/**
 * Which surface carried the gesture that resolved a deferred entry.
 *
 * `"button"` is the queue dialog's own button. `"question-card"` is the answer
 * to the question the host asks in the tile whose turn deferred the call: a
 * deferred approval is a question to the user, so it is drawn by the same card
 * every other question uses rather than by an approval widget of its own.
 */
export type DeferredApprovalSource = "button" | "question-card";

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
  toolCategory?: ToolCategory;
  source?: ToolSource;
  groupId: string;
  toolUseId: string;
  displayOrder: number;
  verdictLevel?: RiskLevel;
  reason?: string;
  approvalPurpose?: ApprovalPurposeSuggestion;
};
