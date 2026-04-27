/**
 * Shared tool governance types. Single source of truth — referenced by
 * every module in src/tools/, the registry, the executor, the permission
 * manager, the MCP layer, and plugin registration.
 *
 * This module deliberately contains only data types + the pure
 * {@link trustFromSource} mapping. No classes, no registry, no
 * side effects. Import here when you need to:
 *   - Tag a tool with its origin (builtin/plugin/mcp).
 *   - Translate source → trust (§6.4 governance).
 *   - Describe the per-invocation execution context / result shape.
 *   - Carry §6.3 Layer 1 deny rules through the registry.
 */

export type ToolSource = "builtin" | "plugin" | "mcp";
export type TrustLevel = "high" | "medium" | "low";
export type ToolCategory = "read" | "write" | "dangerous";

/**
 * §6.4 source → trust mapping. Builtin tools ship with the host so they
 * are trusted. Plugin tools come from signed marketplace artifacts —
 * medium trust. MCP tools come from third-party servers and are the
 * lowest trust tier.
 */
export function trustFromSource(source: ToolSource): TrustLevel {
  switch (source) {
    case "builtin":
      return "high";
    case "plugin":
      return "medium";
    case "mcp":
      return "low";
  }
}

/**
 * Per-invocation execution context threaded through the §4.5.6 tool
 * executor pipeline. `cwd` is the session working directory enforced by
 * the sandbox path validator; `metadata` is a free-form bag for hooks
 * and future plumbing.
 */
export interface ToolExecutionContext {
  cwd: string;
  metadata: Record<string, unknown>;
  /**
   * Per-turn abort signal threaded down from `ConversationLoop.runTurn`.
   * Long-blocking tools (e.g. `ask_user_question`) must honor this so the
   * user's "중단" button can actually unblock the turn — without it, an
   * un-answered question keeps the loop stuck for the full 5-minute gate
   * timeout even after `abortCurrentTurn()` aborts the streaming step.
   */
  abortSignal?: AbortSignal;
}

/**
 * Canonical tool return shape. Executor Step 6 expects this triple and
 * maps it to the tool_use_id-scoped LLM response + audit entry in
 * Step 8. Tools return `isError: true` for normal failures instead of
 * throwing; throws are caught by the executor and surfaced as
 * `is_error` tool results in the same way.
 */
export interface ToolResult {
  output: string;
  isError: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * §6.3 Layer 1 deny rule. When a rule matches a tool name the tool is
 * hidden from {@link ToolRegistry.getVisibleTools} entirely — the LLM
 * never sees its existence, which is the architectural security
 * boundary for blocked tools.
 */
export interface DenyRule {
  /** Glob-like pattern: "meeting.*", "*.delete" */
  pattern: string;
}
