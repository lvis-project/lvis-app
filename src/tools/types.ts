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
import type { ToolCategory, ToolSource } from "../shared/permission-review-status.js";

// Owned by `shared/permission-review-status.ts` so renderer/lib code can name
// them without depending on the tools domain; re-exported here for tools callers.
export type { ToolCategory, ToolSource };
import type { HostShellExecutionPlan } from "../permissions/host-shell-execution-plan.js";
import type { HostShellExecutionPermit } from "../permissions/host-shell-execution-permit.js";
export type TrustLevel = "high" | "medium" | "low";

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
 *   an approval dock but not Bash AST)
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
 * output are `file-content`. A turn seeded (or, mid-turn, joined) by an MCP App's
 * `ui/message` is `app-emitted` — never `user-keyboard`, whatever the app claims.
 */
export type ToolTrustOrigin = ChatInputOrigin;

/**
 * §6.4 source → trust mapping. Builtin tools ship with the host so they
 * are trusted. Plugin tools come from signed marketplace artifacts —
 * medium trust. MCP tools come from third-party servers and are the
 * lowest trust tier.
 */
/**
 * Grammar of a tool name the host registers and exposes to a model: a letter
 * or underscore, then letters, digits and underscores. It is the rule
 * `schemas/plugin-manifest.schema.json` pins for `tools[].name` (the schema
 * is the mirror plugin authors see; this constant is the one the host
 * enforces), and it sits inside what every supported vendor accepts — none
 * of them take a dot, which is why `sample.tool` is refused at ingest rather
 * than rewritten. Plugin names enter through the manifest and are registered
 * verbatim; MCP names are prefixed by governance (`mcp_<prefix>_`) and never
 * rewritten either. Wire grammars owned by a remote runtime (Codex dynamic
 * tools, the subscription tool bridge) are declared next to that runtime's
 * contract, not here.
 */
export const TOOL_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function isValidToolName(name: unknown): name is string {
  return typeof name === "string" && TOOL_NAME_PATTERN.test(name);
}

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
  /**
   * Owner plugin sandbox root (`~/.lvis/plugins/<pluginId>/`) when the
   * invoking tool is plugin-owned, else undefined for builtins. Threaded
   * from the executor so the OS sandbox write-jail (see
   * {@link ../permissions/sandbox-write-jail.js deriveSandboxWritePaths})
   * can confine writes to the plugin's namespace rather than the bare cwd.
   */
  ownerPluginSandboxRoot?: string;
  /**
   * Host-generated once before permission processing for builtin bash/PowerShell.
   * Tool code must use this plan rather than recomputing a late fallback.
   */
  hostShellExecutionPlan?: HostShellExecutionPlan;
  /**
   * Opaque one-shot approval proof for a requested-sandbox plain-shell fallback.
   * It is minted only after allow-once and is consumed by bash/PowerShell.
   */
  hostShellExecutionPermit?: HostShellExecutionPermit;
  /**
   * Per-invocation bookkeeping the executor threads to tools.
   *
   * `sessionId` is declared OPTIONAL on purpose: an invocation can be raised
   * with no conversation behind it, and tools that cannot function unattributed
   * (`ask_user_question`, `skill_load`, `session_tasks`) refuse when it is
   * missing. The executor therefore omits the key rather than substituting a
   * placeholder, which would make every one of those refusals unreachable.
   */
  metadata: { sessionId?: string } & Record<string, unknown>;

  abortSignal?: AbortSignal;
}

/**
 * An image a tool returns for the model to SEE (e.g. `view_image`). Carried on
 * a sibling field of {@link ToolExecutionResult} so `output` stays a plain-text
 * placeholder for every string-only consumer (token estimation, persistence,
 * renderer replay); only the Claude message mapper reads this and emits an image
 * block. `data` is raw base64 (no `data:` URL prefix); non-Claude vendors, which
 * cannot carry an image inside a tool result, fall back to the text placeholder.
 */
export interface ToolResultImage {
  data: string;
  mimeType: string;
  width?: number;
  height?: number;
  bytes?: number;
}

/**
 * Canonical tool return shape. Executor Step 6 expects this triple and
 * maps it to the tool_use_id-scoped LLM response + audit entry in
 * Step 8. Tools return `isError: true` for normal failures instead of
 * throwing; throws are caught by the executor and surfaced as
 * `is_error` tool results in the same way.
 */
export interface ToolExecutionResult {
  output: string;
  isError: boolean;
  metadata?: Record<string, unknown>;
  /** Optional image for the model to see; see {@link ToolResultImage}. */
  image?: ToolResultImage;
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
