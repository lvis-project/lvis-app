/**
 * Permission policy Phase 4 — Layer 6 hook system: shell-script hook contract.
 *
 * Spec ref: docs/architecture/permission-policy-design.md §3 Layer 6.
 *
 * v1 individual shell-script hooks live under `~/.config/lvis/hooks/`
 * (deliberately outside `~/.lvis/` so a compromised LVIS process cannot
 * trivially mutate them — security review M3+M4). Hook types use a file
 * naming prefix:
 *
 *   - `pre-*.sh`  → PreToolUse  (intercept before execution)
 *   - `post-*.sh` → PostToolUse (observe after execution)
 *   - `perm-*.sh` → PermissionRequest (gate the approval-gate ask round)
 *
 * Contract via stdin/stdout JSON:
 *
 *   stdin:  {
 *     toolName, source, category, input, sessionId, trustOrigin, hookType
 *   }
 *
 *   stdout: {
 *     action: "allow" | "deny",       // v1 — modify deferred to hook-signing follow-up
 *     reason: string                   // human-readable; surfaces in audit
 *   }
 *
 * Failure semantics:
 *   - exit code !=0 → deny  (fail-safe; security M3 critic finding)
 *   - timeout >5s    → deny  (configurable via setting)
 *   - stdout JSON parse failure → deny
 *
 * Composition rule (v1, security review):
 *   - Layer 6 hook *cannot* upgrade a Layer 0/1/2/3 deny into allow.
 *   - Layer 6 hook *can* downgrade an upstream allow into deny.
 *   - That is: deny precedence wins. The hook's "allow" output is
 *     informational/audit-only when the upstream layers said deny.
 *   - `modify` action explicitly NOT supported in v1 (hook-signing follow-up once signing
 *     lands; until then `modify` is an attack vector).
 */
import type { ToolCategory, ToolSource } from "../tools/types.js";

/**
 * Trust-origin propagated from upstream into hook stdin. Mirrors the
 * canonical 4-tier set (§9 spec). Strings, not enum, so cross-process
 * boundary survives JSON round-trip and forward-compatibility doesn't
 * break old hooks if we add a 5th origin.
 */
export type HookTrustOrigin =
  | "user-keyboard"
  | "plugin-emitted"
  | "llm-tool-arg"
  | "file-content"
  | "unknown";

/**
 * v1 hook types. Three discrete prefixes; spec §3 §6 talks of more
 * (FailureNotification, ResponseFilter…) but those land in later phases.
 */
export type ScriptHookType = "pre" | "post" | "perm";

/** Wire-shape sent to a hook script's stdin. JSON-encoded one line. */
export interface ScriptHookStdin {
  hookType: ScriptHookType;
  toolName: string;
  source: ToolSource;
  category: ToolCategory;
  input: Record<string, unknown>;
  sessionId: string;
  trustOrigin: HookTrustOrigin;
  /** PostToolUse only — output of the underlying tool call. */
  toolOutput?: string;
  /** PostToolUse only — true when tool errored. */
  isError?: boolean;
}

/**
 * Wire-shape parsed from a hook script's stdout. v1 enum is "allow" |
 * "deny" only (hook-signing follow-up introduces "modify" once signing is in place).
 */
export interface ScriptHookStdout {
  action: "allow" | "deny";
  reason: string;
}

/**
 * Result of one hook script invocation. The aggregator (HookChain)
 * collapses an array of these into a final allow/deny decision.
 */
export interface ScriptHookInvocationResult {
  /** Hook file path (for audit + UI). */
  hookPath: string;
  hookType: ScriptHookType;
  /** Effective decision after applying fail-safe rules. */
  decision: "allow" | "deny";
  /** Human-readable rationale. Always populated. */
  reason: string;
  /** Raw stdout (for forensics / debugging). Truncated by caller. */
  rawStdout: string;
  /** Process exit code, when known. */
  exitCode?: number;
  /** True when the script timed out. */
  timedOut: boolean;
  /** Wall-clock execution time in ms. */
  durationMs: number;
}

/** Default per-hook timeout — spec §3 Layer 6 v1. */
export const DEFAULT_HOOK_TIMEOUT_MS = 5_000;

/** Maximum captured stdout size — defence against runaway output. */
export const MAX_HOOK_STDOUT_BYTES = 16 * 1024;
