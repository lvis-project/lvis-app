/**
 * Permission policy — Layer 6 hook runtime manager.
 *
 * Spec ref: docs/architecture/permission-policy-design.md §3 Layer 6 +
 * docs/architecture/hook-runtime-expansion-design.md §4 (#811).
 *
 * Holds the trusted hook registry at runtime and exposes
 * {@link runPreToolUse} / {@link runPostToolUse} / {@link runPermissionRequest}
 * — the three integration points the executor / approval-gate call into.
 *
 * The registry is the UNIFIED list (`hook-registry.ts`): trusted legacy `.sh`
 * hooks AND trusted declarative `hooks.json` `command` entries collapse into one
 * normalized shape, so dispatch is origin-agnostic. CRITICAL: only entries that
 * passed the TOFU trust gate ever land here — `setTrustedRegistry` is called by
 * the boot pipeline / `/permission hooks accept` AFTER quarantine resolves. An
 * untrusted or changed `hooks.json` contributes NOTHING to this registry.
 *
 * Composition rule (v1, deny precedence):
 *   - {@link runPreToolUse} returns `decision: "deny"` when *any* hook denied.
 *   - {@link runPreToolUse} returns `decision: "allow"` only when no hook denies.
 *     Caller MUST NOT promote this allow over an upstream deny.
 *   - `modify` is **NOT** supported in v1.
 */
import { type DiscoveredHook } from "./hook-discovery.js";
import {
  buildHookRegistry,
  filterRegistryByEventAndTool,
  type HookRegistryEntry,
} from "./hook-registry.js";
import type { HookConfigEntry } from "./hook-config.js";
import {
  runHookChain,
  runnableFromDiscovered,
  type RunnableHook,
  type RunOneHookOptions,
} from "./script-hook-runner.js";
import {
  type HookTrustOrigin,
  type ScriptHookInvocationResult,
  type ScriptHookStdin,
  type ScriptHookType,
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
  /** Per-request MCP/plugin origin identity (#811 hooks-on-mcp-calls). */
  mcpServerId?: string;
  pluginId?: string;
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
  private registry: HookRegistryEntry[] = [];

  /**
   * Replace the trusted hook list with legacy `.sh` hooks only. Retained for
   * back-compat with callers that don't (yet) carry config entries. Equivalent
   * to `setTrustedRegistry(hooks, [])`.
   */
  setTrustedHooks(hooks: DiscoveredHook[]): void {
    this.setTrustedRegistry(hooks, []);
  }

  /**
   * Replace the trusted registry with the unified set: trusted `.sh` hooks
   * (origin `sh`) + trusted declarative config entries (origin `config`).
   * Called by the boot pipeline once the TOFU workflow resolves and by
   * `/permission hooks accept` when trust state changes. The executor /
   * approval-gate read from this snapshot for every tool call.
   *
   * SECURITY: callers MUST pass ONLY trusted entries. The manager never
   * re-validates trust — it assumes the quarantine gate already ran.
   */
  setTrustedRegistry(shHooks: DiscoveredHook[], configEntries: HookConfigEntry[]): void {
    this.registry = buildHookRegistry(shHooks, configEntries);
  }

  /** Registry entries for the given type. Used by tests + diagnostics. */
  hooksOfType(type: ScriptHookType): HookRegistryEntry[] {
    return this.registry.filter((e) => e.event === type);
  }

  /** Total trusted entry count. */
  size(): number {
    return this.registry.length;
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
    // #811 — filter by event + matcher (the same glob as `.sh` frontmatter).
    // A config/`.sh` entry with no matcher runs for every tool.
    const entries = filterRegistryByEventAndTool(this.registry, type, payload.toolName);
    if (entries.length === 0) {
      return { decision: "allow", reason: "no matching hooks of this type", results: [] };
    }
    const stdinPayload: ScriptHookStdin = {
      hookType: type,
      toolName: payload.toolName,
      source: payload.source,
      category: payload.category,
      input: dlpRedactInput(payload.input),
      sessionId: payload.sessionId,
      trustOrigin: payload.trustOrigin,
      ...(payload.mcpServerId !== undefined ? { mcpServerId: payload.mcpServerId } : {}),
      ...(payload.pluginId !== undefined ? { pluginId: payload.pluginId } : {}),
      ...(payload.toolOutput !== undefined ? { toolOutput: payload.toolOutput } : {}),
      ...(payload.isError !== undefined ? { isError: payload.isError } : {}),
    };
    // Each entry runs with its own timeout: config entries carry a per-entry
    // (already-clamped) `timeoutMs`; `.sh` entries fall back to the default /
    // caller-supplied option.
    return runHookChain(entries.map(toRunnable), stdinPayload, options);
  }
}

/**
 * Normalize one registry entry into the runner's {@link RunnableHook} shape,
 * carrying its per-entry timeout when present (config entries) so each hook runs
 * on its own clamped budget.
 */
function toRunnable(entry: HookRegistryEntry): RunnableHook {
  if (entry.source === "sh") {
    // `.sh` entries carry NO per-entry timeout — they fall back to the
    // caller-supplied option (e.g. the Windows shell-integration override) or
    // the default, exactly as before this change.
    return runnableFromDiscovered(entry.discovered);
  }
  return {
    id: entry.id,
    hookType: entry.event,
    command: entry.command,
    ...(entry.matcher !== undefined ? { matcher: entry.matcher } : {}),
    // For a config command, the forensic path is argv[0] (or the script arg).
    hookPath: entry.command[0],
    timeoutMs: entry.timeoutMs,
    // A declarative `hooks.json` command — the runner falls back to hashing the
    // verbatim argv for `commandIdentity` (no on-disk local-script sha exists).
    source: "config",
  };
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
