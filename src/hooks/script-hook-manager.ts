/**
 * Q12 Phase 4 — Layer 6 hook runtime manager.
 *
 * Spec ref: docs/architecture/q12-permission-policy-design.md §3 Layer 6.
 *
 * Holds the trusted hook list at runtime and exposes
 * {@link runPreToolUse} / {@link runPostToolUse} / {@link runPermissionRequest}
 * — the three integration points the executor / approval-gate call into.
 *
 * Composition rule (v1, deny precedence):
 *   - {@link runPreToolUse} returns `decision: "deny"` when *any* hook
 *     denied. Caller treats this as a downgrade-only signal: even if
 *     upstream layers allowed, hook deny wins.
 *   - {@link runPreToolUse} returns `decision: "allow"` when no hooks
 *     deny. Caller MUST NOT promote this allow over an upstream deny.
 *   - `modify` is **NOT** supported in v1 (Q13 once signing lands).
 */
import type { DiscoveredHook } from "./hook-discovery.js";
import { runHookChain, type RunOneHookOptions } from "./script-hook-runner.js";
import type {
  HookTrustOrigin,
  ScriptHookInvocationResult,
  ScriptHookStdin,
  ScriptHookType,
} from "./script-hook-types.js";
import { redactForLLM } from "../audit/dlp-filter.js";
import type { ToolCategory, ToolSource } from "../tools/types.js";

/**
 * Inputs the manager needs to dispatch a hook. The caller (executor /
 * approval-gate) is responsible for supplying the trustOrigin and
 * sessionId — those flow from upstream context, not from the manager.
 */
export interface HookDispatchPayload {
  toolName: string;
  source: ToolSource;
  category: ToolCategory;
  input: Record<string, unknown>;
  sessionId: string;
  trustOrigin: HookTrustOrigin;
  /** PostToolUse only. */
  toolOutput?: string;
  /** PostToolUse only. */
  isError?: boolean;
}

export interface HookDispatchResult {
  decision: "allow" | "deny";
  reason: string;
  /** Per-hook results — for audit + observability. */
  results: ScriptHookInvocationResult[];
}

export class ScriptHookManager {
  private trusted: DiscoveredHook[] = [];

   /**
    * Replace the trusted hook list. Called by the boot pipeline once
   * the TOFU workflow resolves; the executor / gate read from this
    * snapshot for every tool call.
    */
  setTrustedHooks(hooks: DiscoveredHook[]): void {
    this.trusted = [...hooks];
  }

  /** Trusted hooks for the given type. Used by tests + diagnostics. */
  hooksOfType(type: ScriptHookType): DiscoveredHook[] {
    return this.trusted.filter((h) => h.hookType === type);
  }

  /** Total trusted hook count. */
  size(): number {
    return this.trusted.length;
  }

  /**
   * Dispatch all PreToolUse hooks. DLP-redacts top-level string fields
   * and string array items in `input` before passing into hook stdin.
   * Nested objects are passed as-is, so pathFields/category metadata must
   * keep secret material out of nested tool arguments.
   */
  async runPreToolUse(
    payload: HookDispatchPayload,
    options?: RunOneHookOptions,
  ): Promise<HookDispatchResult> {
    return this.runForType("pre", payload, options);
  }

  /** Dispatch all PostToolUse hooks. v1 outputs are *informational*
   * (deny does NOT roll back the already-executed tool); the result
   * surfaces in audit so reviewers see the after-the-fact concern. */
  async runPostToolUse(
    payload: HookDispatchPayload,
    options?: RunOneHookOptions,
  ): Promise<HookDispatchResult> {
    return this.runForType("post", payload, options);
  }

  /** Dispatch all PermissionRequest hooks. Hooks may deny what the
   * approval-gate would have asked the user about — useful for SIEM
   * "this user must NEVER approve writes outside repo X" policies. */
  async runPermissionRequest(
    payload: HookDispatchPayload,
    options?: RunOneHookOptions,
  ): Promise<HookDispatchResult> {
    return this.runForType("perm", payload, options);
  }

  private async runForType(
    type: ScriptHookType,
    payload: HookDispatchPayload,
    options?: RunOneHookOptions,
  ): Promise<HookDispatchResult> {
    const hooks = this.hooksOfType(type);
    if (hooks.length === 0) {
      return { decision: "allow", reason: "no hooks of this type", results: [] };
    }
    const stdinPayload: ScriptHookStdin = {
      hookType: type,
      toolName: payload.toolName,
      source: payload.source,
      category: payload.category,
      input: dlpRedactInput(payload.input),
      sessionId: payload.sessionId,
      trustOrigin: payload.trustOrigin,
      ...(payload.toolOutput !== undefined ? { toolOutput: payload.toolOutput } : {}),
      ...(payload.isError !== undefined ? { isError: payload.isError } : {}),
    };
    return runHookChain(hooks, stdinPayload, options);
  }
}

/**
 * Apply DLP redaction to every string-valued field of the `input`
 * object before it reaches the hook stdin. Numbers / booleans / nested
 * objects are passed through (the redactor only mutates strings).
 *
 * Exported for unit tests.
 */
export function dlpRedactInput(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === "string") {
      out[k] = redactForLLM(v).redacted;
    } else if (Array.isArray(v)) {
      out[k] = v.map((item) =>
        typeof item === "string" ? redactForLLM(item).redacted : item,
      );
    } else {
      out[k] = v;
    }
  }
  return out;
}
