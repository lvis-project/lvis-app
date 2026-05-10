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
import type { ChatInputOrigin } from "../shared/chat-origin.js";

export type ToolSource = "builtin" | "plugin" | "mcp";
export type TrustLevel = "high" | "medium" | "low";

/**
 * Permission policy 5-axis tool category. Replaces the legacy `read | write | dangerous`
 * binary-ish split with category-aware policy lanes (PermissionManager
 * Layer 3 decision matrix in permission-policy-design.md):
 *
 * - `read`    — auto-allow for builtin, scope-checked for plugin
 * - `write`   — ask (user confirmation)
 * - `shell`   — ask + Bash AST validation (subset of write where command
 *               structure must be parsed)
 * - `network` — ask + endpoint surface (HTTP/IPC writes to external hosts)
 * - `meta`    — control-flow / UI primitives (`ask_user_question`,
 *               `agent_spawn`). Decision delegated to {@link ToolDecisionOverride}
 *               so executor short-circuit paths stay explicit.
 */
export type ToolCategory = "read" | "write" | "shell" | "network" | "meta";

/**
 * Permission policy explicit decision override for `meta` category tools. When a tool's
 * category is genuinely orthogonal to the standard policy lanes (a user
 * prompt is not a "write"; a sub-agent dispatch is its own primitive), the
 * tool declares `decisionOverride` and the executor takes that path
 * directly rather than running the Layer 3 matrix.
 *
 * - `always-allow-with-audit` — execute without permission check, but
 *   audit-log every invocation (used by `ask_user_question` so the user
 *   prompt itself never needs another permission prompt)
 * - `ask` — same as `write` (sub-agent dispatch creates state, so warrants
 *   an approval modal but not Bash AST)
 */
export type ToolDecisionOverride = "always-allow-with-audit" | "ask";

/**
 * Permission policy §9 trust origin — which content boundary produced the invocation. Carried
 * with `ToolPermissionContext` and propagated into:
 *   - audit entries (provenance evidence)
 *   - approval-request payloads (so the renderer can warn on non-keyboard origins)
 *   - Layer 5 reviewer cache key (a high-trust verdict cached for
 *     `user-keyboard` MUST NOT be served to an `llm-tool-arg` invocation of the same shape)
 *   - Layer 5 reviewer prompt (LLM sees origin to detect prompt-injection)
 *
 * Distinct from both `ToolSource` (where the tool came from) and the outer
 * chat input origin. The conversation loop must derive this at the concrete
 * model/tool boundary: a typed user prompt that causes a model-generated bash
 * input is `llm-tool-arg`, while later tool calls influenced by read_file
 * output are `file-content`.
 */
export type ToolTrustOrigin = ChatInputOrigin;

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
  /**
   * User-authorized filesystem roots beyond `cwd` for this invocation. The
   * executor derives this once from `permissions.additionalDirectories` and
   * every native file/shell tool reuses the same extra scope for its internal
   * sandbox check. The full allow-list is `cwd ∪ extraAllowedDirectories`.
   */
  extraAllowedDirectories: readonly string[];
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
