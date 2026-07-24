/**
 * Permission policy — Layer 6 hook system: shell-script hook contract.
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
import type { PluginHookOwner } from "./hook-registry.js";
import type { TrustOriginWithUnknown } from "../shared/chat-origin.js";

/**
 * Trust-origin propagated from upstream into hook stdin. Mirrors the
 * canonical 4-tier set (§9 spec). Strings, not enum, so cross-process
 * boundary survives JSON round-trip and forward-compatibility doesn't
 * break old hooks if we add a 5th origin.
 */
export type HookTrustOrigin = TrustOriginWithUnknown;

/**
 * v1 hook types. Three discrete prefixes; the legacy `.sh` naming model
 * (`pre-*.sh` / `post-*.sh` / `perm-*.sh`) is FROZEN to exactly these three —
 * lifecycle events (below) are config-only and NEVER get a `.sh` prefix.
 */
export type ScriptHookType = "pre" | "post" | "perm";

/**
 * Lifecycle events — issue #811 milestone-2 (design §5). All are **config-only**:
 * a trusted `hooks.json` can register them, but there is no `.sh` prefix for
 * them (the legacy prefix model stays {@link ScriptHookType}).
 *
 * SIX of these are OBSERVE-ONLY (non-blocking): `PostToolUseFailure`,
 * `PermissionDenied`, `SessionStart`, `Stop`, `PreCompact`, `PostCompact`. Their
 * `deny` is RECORDED for audit but NEVER alters control flow.
 *
 * ONE is BLOCKING and FAIL-CLOSED: {@link USER_PROMPT_SUBMIT_EVENT}
 * (`"UserPromptSubmit"`, design §5). It is dispatched via the manager's blocking
 * path ({@link ScriptHookManager.runUserPromptSubmit}); a `deny` / timeout /
 * error / bad-json REFUSES the turn, exactly like `PreToolUse`. Discriminate it
 * from the observe-only events with {@link isBlockingLifecycleEvent} so a future
 * reader never routes it through the observe-only swallow-and-continue path.
 */
export type LifecycleHookEvent =
  | "PostToolUseFailure"
  | "PermissionDenied"
  | "SessionStart"
  | "SessionEnd"
  | "Notification"
  | "Stop"
  | "PreCompact"
  | "PostCompact"
  | "SubagentStart"
  | "SubagentStop"
  | "UserPromptSubmit";

/**
 * The single BLOCKING, fail-closed lifecycle event (#811 milestone-2, design §5).
 * Named constant so call sites discriminate the blocking event without
 * stringly-typing it. A `deny` from a `UserPromptSubmit` hook REFUSES the turn.
 */
export const USER_PROMPT_SUBMIT_EVENT = "UserPromptSubmit" as const;

/**
 * True for the one BLOCKING lifecycle event (`UserPromptSubmit`). The six other
 * lifecycle events are observe-only. Keeps the blocking-vs-observe split in one
 * place so a misroute (running the blocking event through the observe path, or
 * vice-versa) is a single-line bug, not a scattered one.
 */
export function isBlockingLifecycleEvent(
  event: LifecycleHookEvent,
): event is typeof USER_PROMPT_SUBMIT_EVENT {
  return event === USER_PROMPT_SUBMIT_EVENT;
}

/**
 * The full closed-set hook event surface. {@link ScriptHookType} (pre|post|perm)
 * is the BLOCKING tool-use subset that also has the legacy `.sh` prefix model;
 * {@link LifecycleHookEvent} is the non-blocking, config-only lifecycle subset.
 * Every registry / config / runner consumer keys on this union — the narrow
 * `ScriptHookType` remains the back-compat alias for the three tool events.
 */
export type HookEvent = ScriptHookType | LifecycleHookEvent;

/**
 * Wire-shape sent to a hook script's stdin. JSON-encoded one line.
 *
 * #811 milestone-2 — generalized into a union so the SAME runner can carry both
 * the tool-centric tool-use payload AND the session-centric lifecycle payloads.
 * The tool fields (`toolName` / `source` / `category` / `input`) are present on
 * the tool-use shape and absent on lifecycle shapes; every shape carries the
 * common `{ hookType, event, sessionId, trustOrigin }` envelope so a hook can
 * always discriminate on `event`. DLP-redaction (§6.6) is applied at the caller
 * to any free-text/secret-bearing field before serialization.
 */
export type ScriptHookStdin = ToolHookStdin | LifecycleHookStdin;

/** Tool-use stdin (PreToolUse / PostToolUse / PermissionRequest). */
export interface ToolHookStdin {
  hookType: ScriptHookType;
  /** Closed-set event — equals `hookType` for the tool-use surface. */
  event?: HookEvent;
  toolName: string;
  source: ToolSource;
  category: ToolCategory;
  input: Record<string, unknown>;
  sessionId: string;
  trustOrigin: HookTrustOrigin;
  /**
   * Per-request MCP-aligned identity (milestone `hooks-on-mcp-calls`, #811).
   * Present when the tool originates from an MCP server / plugin, so a hook can
   * key its policy on the SPECIFIC origin (e.g. "deny writes from server X") and
   * match `mcp__*` / a plugin id — not just the coarse `source`. `category`
   * already carries the authoritative `_meta["lvisai/category"]` (the reverse
   * projection lands it on `tool.category`).
   */
  mcpServerId?: string;
  pluginId?: string;
  /** PostToolUse only — output of the underlying tool call. */
  toolOutput?: string;
  /** PostToolUse only — true when tool errored. */
  isError?: boolean;
}

/**
 * Lifecycle stdin (#811 milestone-2, design §5). Session-centric: it carries the
 * `sessionId` envelope plus event-specific fields. `hookType` is set to the
 * lifecycle event itself (there is no pre/post/perm projection for lifecycle
 * events — they never run a `.sh` prefix), and `event` repeats it for the
 * closed-set surface. All payload fields are optional and event-specific so one
 * shape covers all six non-blocking events.
 */
export interface LifecycleHookStdin {
  hookType: LifecycleHookEvent;
  /** Closed-set event — equals `hookType` for the lifecycle surface. */
  event: LifecycleHookEvent;
  sessionId: string;
  trustOrigin: HookTrustOrigin;
  /** PostToolUseFailure — the failing tool's name. */
  toolName?: string;
  /** PostToolUseFailure — tool error message (DLP-redacted at the caller). */
  errorMessage?: string;
  /** PostToolUseFailure / Stop — wall-clock duration in ms. */
  durationMs?: number;
  /** PermissionDenied — why + where the deny was finalized. */
  denyReason?: { layer: number | undefined; source: string };
  /** SessionStart — non-secret session metadata (routine scope / persona). */
  sessionMeta?: Record<string, unknown>;
  /** Stop — terminal stop reason for the turn. */
  stopReason?: string;
  /** Stop — number of tool calls in the turn. */
  toolCount?: number;
  /** PreCompact — `"auto-compact"` (threshold) | `"manual"`. */
  reason?: string;
  /** PreCompact — pre-compaction token estimate. */
  tokenEstimate?: number;
  /** PostCompact — message counts before/after compaction. */
  messagesBefore?: number;
  messagesAfter?: number;
  /** PostCompact — token estimates before/after compaction. */
  tokensBefore?: number;
  tokensAfter?: number;
  /**
   * UserPromptSubmit (BLOCKING, fail-closed) — the user's prompt text, ALREADY
   * DLP-redacted at the caller (§6.6) before serialization. A hook reads this to
   * decide whether to `deny` (refuse the turn) or `allow`.
   */
  inputText?: string;
  /** UserPromptSubmit — the chat input origin (e.g. user-keyboard, plugin-emitted). */
  inputOrigin?: string;
  /** UserPromptSubmit — the resolved route for this turn (`llm` | `skill`). */
  route?: string;
  /** UserPromptSubmit — the Host input classification (`general` | `command`). */
  classification?: string;
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
  /**
   * The event this invocation ran for. For tool-use hooks this is the narrow
   * pre|post|perm projection; for lifecycle hooks (#811 m2) it is the lifecycle
   * event itself. Widened from `ScriptHookType` to {@link HookEvent} so the
   * lifecycle surface carries its own event through to audit.
   */
  hookType: HookEvent;
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
  /**
   * Origin discriminant — a legacy `.sh` hook vs a declarative `hooks.json`
   * `command` entry. Surfaced by the runner from the {@link RunnableHook} so the
   * audit layer can distinguish config-hook vs `.sh`-hook denials forensically
   * (#811 cluster-review follow-up). The runner ALWAYS populates this.
   */
  source: "sh" | "config";
  /**
   * Trust identity of the executed code: the resolved local-script sha256 for a
   * `.sh` hook, or a sha256 of the verbatim command argv for a generic
   * `command` entry. Lets forensics tie an audit row to the exact code that ran.
   * Always populated by the runner.
   */
  commandIdentity: string;
  /** Exact owner/version/generation/fingerprint for plugin-bundled Hooks. */
  pluginOwner?: PluginHookOwner;
}

/** Default per-hook timeout — spec §3 Layer 6 v1. */
export const DEFAULT_HOOK_TIMEOUT_MS = 5_000;

/** Maximum captured stdout size — defence against runaway output. */
export const MAX_HOOK_STDOUT_BYTES = 16 * 1024;
