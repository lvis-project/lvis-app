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
  filterRegistryByEventAndSubject,
  filterRegistryByEventAndTool,
  type HookRegistryEntry,
  type ConfigHookRegistryEntry,
} from "./hook-registry.js";
import type { HookConfigEntry } from "./hook-config.js";
import {
  runHookChain,
  runnableFromDiscovered,
  type RunnableHook,
  type RunOneHookOptions,
} from "./script-hook-runner.js";
import {
  isBlockingLifecycleEvent,
  USER_PROMPT_SUBMIT_EVENT,
  type HookTrustOrigin,
  type LifecycleHookEvent,
  type LifecycleHookStdin,
  type ScriptHookInvocationResult,
  type ScriptHookStdin,
  type ScriptHookType,
} from "./script-hook-types.js";
import { redactForLLM } from "../audit/dlp-filter.js";
import { createLogger } from "../lib/logger.js";
import type { ToolCategory, ToolSource } from "../tools/types.js";
import type { PluginHookTrustStore, PreparedPluginHookProjection } from "./plugin-hook-projection.js";
import type { PluginRuntimeGenerationAccess } from "../plugins/plugin-host-generation.js";

const log = createLogger("script-hook-manager");

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

export interface PreparedPluginHookGenerationPublication {
  readonly pluginId: string;
  readonly generationId: string;
  publish(): void;
}

/**
 * Event-specific payload fields for a lifecycle dispatch (#811 milestone-2,
 * design §5). The manager wraps these with the common `{ event, sessionId,
 * trustOrigin }` envelope and DLP-redacts free-text fields before serialization.
 * Every field is optional + event-specific so one shape covers all six
 * non-blocking events.
 */
export interface LifecycleEventPayload {
  /** PostToolUseFailure — the failing tool's name. */
  toolName?: string;
  /** PostToolUseFailure — tool error message (DLP-redacted before dispatch). */
  errorMessage?: string;
  /** PostToolUseFailure / Stop — wall-clock duration in ms. */
  durationMs?: number;
  /** PermissionDenied — why + where the deny was finalized (reason restores
   * forensic granularity beyond the coarse layer/source). */
  denyReason?: { layer: number | undefined; source: string; reason?: string };
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
  /** SubagentStart / SubagentStop — the child run id (agent_spawn spawnId). */
  agentId?: string;
  /** SubagentStart / SubagentStop — the child agent mode/persona. */
  agentType?: string;
  /** Notification — the message body shown to the user. */
  message?: string;
}

/**
 * Payload for the BLOCKING `UserPromptSubmit` dispatch (#811 milestone-2,
 * design §5). `inputText` is the matcher subject AND is DLP-redacted by the
 * manager before it reaches the hook (§6.6) — callers pass the raw prompt.
 */
export interface UserPromptSubmitPayload {
  /** The user's prompt text. Matcher subject + DLP-redacted before dispatch. */
  inputText: string;
  /** Chat input origin (e.g. user-keyboard, plugin-emitted). */
  inputOrigin?: string;
  /** Resolved route for this turn (`llm` | `skill`). */
  route?: string;
  /** Keyword classification type (`general` | `skill` | `command`). */
  classification?: string;
}

export class ScriptHookManager {
  private registry: HookRegistryEntry[] = [];
  private pluginRegistries = new Map<string, readonly HookRegistryEntry[]>();
  private generation = 0;
  private generationAccess: PluginRuntimeGenerationAccess | undefined;

  setPluginGenerationAccess(access: PluginRuntimeGenerationAccess): void {
    this.generationAccess = access;
  }

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
    this.generation += 1;
  }

  publishPluginGeneration(
    projections: readonly PreparedPluginHookProjection[],
    trust: PluginHookTrustStore,
  ): void {
    this.preparePluginGeneration(projections, trust).publish();
  }

  preparePluginGeneration(
    projections: readonly PreparedPluginHookProjection[],
    trust: PluginHookTrustStore,
    owner?: { pluginId: string; generationId: string },
  ): PreparedPluginHookGenerationPublication {
    for (const projection of projections) {
      if (!projection.owner.activationId) {
        throw new Error(`plugin Hook activation identity is missing for '${projection.owner.localId}'`);
      }
    }
    const inferred = projections[0]?.owner;
    const pluginId = owner?.pluginId ?? inferred?.pluginId;
    const generationId = owner?.generationId ?? inferred?.generationId;
    if (!pluginId || !generationId) {
      throw new Error("plugin Hook generation identity is required");
    }
    const next = new Map(this.pluginRegistries);
    const generations = new Set(
      projections.map((projection) =>
        `${projection.owner.pluginId}\0${projection.owner.activationId}`),
    );
    generations.add(`${pluginId}\0${generationId}`);
    for (const identity of generations) {
      const [targetPluginId, targetGenerationId] = identity.split("\0");
      for (const [key, entries] of next) {
        if (entries.some((entry) =>
          entry.owner?.pluginId === targetPluginId &&
          entry.owner.activationId === targetGenerationId)) {
          next.delete(key);
        }
      }
    }
    for (const projection of projections) {
      if (!trust.isApproved(projection)) continue;
      const entries: ConfigHookRegistryEntry[] = projection.entries.map((entry) => ({
        id: `plugin:${projection.owner.pluginId}:${projection.owner.localId}:${entry.id}`,
        event: entry.event,
        ...(entry.matcher !== undefined ? { matcher: entry.matcher } : {}),
        command: [...entry.command],
        source: "config",
        timeoutMs: entry.timeoutMs,
        owner: projection.owner,
      }));
      next.set(pluginProjectionKey(projection), Object.freeze(entries));
    }
    let published = false;
    return Object.freeze({
      pluginId,
      generationId,
      publish: () => {
        if (published) return;
        this.pluginRegistries = next;
        this.generation += 1;
        published = true;
      },
    });
  }

  removePluginGeneration(pluginId: string, generationId: string): void {
    for (const [key, entries] of this.pluginRegistries) {
      if (entries.some((entry) => entry.owner?.pluginId === pluginId &&
        entry.owner.activationId === generationId)) {
        this.pluginRegistries.delete(key);
      }
    }
    this.generation += 1;
  }

  removePlugin(pluginId: string): void {
    for (const [key, entries] of this.pluginRegistries) {
      if (entries.some((entry) => entry.owner?.pluginId === pluginId)) this.pluginRegistries.delete(key);
    }
  }

  private snapshotRegistry(): HookRegistryEntry[] {
    return [...this.registry, ...[...this.pluginRegistries.values()].flat()];
  }

  /** Registry entries for the given type. Used by tests + diagnostics. */
  hooksOfType(type: ScriptHookType): HookRegistryEntry[] {
    return this.snapshotRegistry().filter((e) => e.event === type);
  }

  /** Total trusted entry count. */
  size(): number {
    return this.snapshotRegistry().length;
  }

  getGeneration(): string {
    return String(this.generation);
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

  /**
   * Dispatch all hooks registered for a NON-BLOCKING lifecycle event (#811
   * milestone-2, design §5). OBSERVE-ONLY: the returned decision is recorded for
   * audit but MUST NEVER affect control flow — a lifecycle hook's `deny` mirrors
   * `PostToolUse` (informational), and a hook erroring / timing out must not
   * break the turn. The matcher subject for lifecycle events is `sessionId`
   * (or `'*'` = all), matched via the same glob as `.sh` / tool-use matchers.
   *
   * Fail-soft: this method NEVER throws. A dispatch error collapses to an empty
   * observe result so the caller can ignore it and continue.
   */
  async runLifecycleEvent(
    event: LifecycleHookEvent,
    sessionId: string,
    trustOrigin: HookTrustOrigin,
    payload: LifecycleEventPayload = {},
    options?: RunOneHookOptions,
  ): Promise<HookDispatchResult> {
    // Misroute guard: the BLOCKING event must NEVER run through this observe-only
    // path (it would swallow a deny and let a refused prompt through). Route it
    // to {@link runUserPromptSubmit} instead. Fail closed — return a deny so a
    // wiring bug refuses rather than silently allows.
    if (isBlockingLifecycleEvent(event)) {
      log.error(
        "runLifecycleEvent called for the BLOCKING %s event — use runUserPromptSubmit; failing closed (deny)",
        event,
      );
      return {
        decision: "deny",
        reason: `${event} is blocking — must dispatch via runUserPromptSubmit`,
        results: [],
      };
    }
    try {
      // Subject for lifecycle matchers is the sessionId (design §6). Reuse the
      // same glob filter so a `'*'` / sessionId matcher behaves identically to
      // tool-use matchers. (`'*'` / absent matcher ⇒ match every session.)
      const entries = filterRegistryByEventAndSubject(this.snapshotRegistry(), event, sessionId);
      if (entries.length === 0) {
        return { decision: "allow", reason: "no matching lifecycle hooks", results: [] };
      }
      const stdinPayload: LifecycleHookStdin = {
        hookType: event,
        event,
        sessionId,
        trustOrigin,
        ...(payload.toolName !== undefined ? { toolName: payload.toolName } : {}),
        // DLP-redact the only free-text field (§6.6): a tool error message can
        // echo user/secret data. No tool inputs flow through lifecycle events.
        ...(payload.errorMessage !== undefined
          ? { errorMessage: redactForLLM(payload.errorMessage).redacted }
          : {}),
        ...(payload.durationMs !== undefined ? { durationMs: payload.durationMs } : {}),
        ...(payload.denyReason !== undefined ? { denyReason: payload.denyReason } : {}),
        ...(payload.sessionMeta !== undefined ? { sessionMeta: payload.sessionMeta } : {}),
        ...(payload.stopReason !== undefined ? { stopReason: payload.stopReason } : {}),
        ...(payload.toolCount !== undefined ? { toolCount: payload.toolCount } : {}),
        ...(payload.reason !== undefined ? { reason: payload.reason } : {}),
        ...(payload.tokenEstimate !== undefined ? { tokenEstimate: payload.tokenEstimate } : {}),
        ...(payload.messagesBefore !== undefined ? { messagesBefore: payload.messagesBefore } : {}),
        ...(payload.messagesAfter !== undefined ? { messagesAfter: payload.messagesAfter } : {}),
        ...(payload.tokensBefore !== undefined ? { tokensBefore: payload.tokensBefore } : {}),
        ...(payload.tokensAfter !== undefined ? { tokensAfter: payload.tokensAfter } : {}),
      };
      // runHookChain stops at the first deny — but for a non-blocking event the
      // decision is OBSERVE-ONLY, so the caller ignores it. (Chain-stop just
      // avoids running later hooks once one already signaled deny — the audit
      // captures every result up to that point, same as PostToolUse.)
      return await this.runWithGenerationLeases(entries, (activeEntries) =>
        runHookChain(activeEntries.map(toRunnable), stdinPayload, options));
    } catch (err) {
      // Fail-soft: a lifecycle dispatch must NEVER break the turn. Log + return
      // an empty observe result so the caller continues unaffected.
      log.warn(
        "lifecycle hook dispatch for %s failed (non-blocking, ignored): %s",
        event,
        err instanceof Error ? err.message : String(err),
      );
      return { decision: "allow", reason: "lifecycle dispatch error (ignored)", results: [] };
    }
  }

  /**
   * Dispatch the ONE BLOCKING lifecycle event — `UserPromptSubmit` (#811
   * milestone-2, design §5). Runs the matching trusted hooks via the
   * deny-precedence chain and returns a decision the CALLER MUST RESPECT: on
   * `deny` the caller refuses the turn before entering queryLoop.
   *
   * FAIL-CLOSED (security-sensitive, mirrors `PreToolUse`):
   *   - a hook `deny` → deny (turn refused)
   *   - timeout / nonzero-exit / bad-json / spawn-error → deny (runHookChain /
   *     runOneHookScript already collapse all of these to a deny result)
   *   - an UNEXPECTED throw inside this dispatch → deny (NOT allow). Unlike the
   *     observe-only {@link runLifecycleEvent} which swallows-and-continues, this
   *     blocking event must fail closed.
   *
   * BACK-COMPAT: when NO trusted hook matches, returns `allow` with an empty
   * `results` so the caller proceeds byte-identically to today. The matcher
   * subject is the prompt text (or `'*'`), matched via the same glob as `.sh` /
   * tool-use matchers.
   *
   * DLP: `inputText` is DLP-redacted here (§6.6, via {@link redactForLLM}) before
   * it reaches the hook stdin / env — exactly as the observe path redacts
   * `errorMessage` and the tool path redacts `input`.
   */
  async runUserPromptSubmit(
    sessionId: string,
    trustOrigin: HookTrustOrigin,
    payload: UserPromptSubmitPayload,
    options?: RunOneHookOptions,
  ): Promise<HookDispatchResult> {
    try {
      // Matcher subject = the prompt text (design §5). Reuse the same glob as
      // tool-use / lifecycle matchers (`'*'` / absent matcher ⇒ match every prompt).
      const entries = filterRegistryByEventAndSubject(
        this.snapshotRegistry(),
        USER_PROMPT_SUBMIT_EVENT,
        payload.inputText,
      );
      if (entries.length === 0) {
        // No trusted matching hook ⇒ ALLOW (back-compat: turn proceeds as today).
        return { decision: "allow", reason: "no matching UserPromptSubmit hooks", results: [] };
      }
      const stdinPayload: LifecycleHookStdin = {
        hookType: USER_PROMPT_SUBMIT_EVENT,
        event: USER_PROMPT_SUBMIT_EVENT,
        sessionId,
        trustOrigin,
        // DLP-redact the free-text prompt (§6.6) BEFORE it reaches the hook.
        inputText: redactForLLM(payload.inputText).redacted,
        ...(payload.inputOrigin !== undefined ? { inputOrigin: payload.inputOrigin } : {}),
        ...(payload.route !== undefined ? { route: payload.route } : {}),
        ...(payload.classification !== undefined ? { classification: payload.classification } : {}),
      };
      // Deny precedence: runHookChain stops at the first deny and returns it.
      // All fail-closed cases (timeout/nonzero-exit/bad-json/spawn-error) are
      // already collapsed to a deny RESULT by runOneHookScript, so the chain's
      // returned decision is authoritative — the caller refuses on deny.
      return await this.runWithGenerationLeases(entries, (activeEntries) =>
        runHookChain(activeEntries.map(toRunnable), stdinPayload, options));
    } catch (err) {
      // FAIL-CLOSED: a blocking event must DENY (refuse the turn) on an
      // unexpected dispatch error — NOT allow. (Contrast runLifecycleEvent,
      // which is observe-only and swallows-then-allows.)
      log.warn(
        "UserPromptSubmit hook dispatch failed (fail-closed → deny): %s",
        err instanceof Error ? err.message : String(err),
      );
      return {
        decision: "deny",
        reason: `UserPromptSubmit dispatch error (fail-closed → deny): ${
          err instanceof Error ? err.message : String(err)
        }`,
        results: [],
      };
    }
  }

  private async runForType(
    type: ScriptHookType,
    payload: HookDispatchPayload,
    options?: RunOneHookOptions,
  ): Promise<HookDispatchResult> {
    // #811 — filter by event + matcher (the same glob as `.sh` frontmatter).
    // A config/`.sh` entry with no matcher runs for every tool.
    const entries = filterRegistryByEventAndTool(this.snapshotRegistry(), type, payload.toolName);
    if (entries.length === 0) {
      return { decision: "allow", reason: "no matching hooks of this type", results: [] };
    }
    const stdinPayload: ScriptHookStdin = {
      hookType: type,
      // Closed-set surface: for tool-use hooks `event` equals `hookType`.
      event: type,
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
    return this.runWithGenerationLeases(entries, (activeEntries) =>
      runHookChain(activeEntries.map(toRunnable), stdinPayload, options));
  }

  private async runWithGenerationLeases<T>(
    entries: readonly HookRegistryEntry[],
    operation: (activeEntries: HookRegistryEntry[]) => Promise<T>,
  ): Promise<T> {
    const access = this.generationAccess;
    if (!access) {
      const pluginEntry = entries.find((entry) => entry.owner);
      if (pluginEntry?.owner) {
        throw new Error(
          `plugin hook '${pluginEntry.id}' cannot run without generation leasing for ` +
          `'${pluginEntry.owner.pluginId}' generation '${pluginEntry.owner.generationId}'`,
        );
      }
      return operation([...entries]);
    }
    const leases = new Map<
      string,
      Awaited<ReturnType<PluginRuntimeGenerationAccess["acquireExact"]>>
    >();
    const acquiredOwnerKeys = new Set<string>();
    try {
      for (const entry of entries) {
        const owner = entry.owner;
        if (!owner) continue;
        const activationId = owner.activationId;
        const key = `${owner.pluginId}\0${activationId}`;
        if (acquiredOwnerKeys.has(key)) continue;
        leases.set(key, await access.acquireExact(owner.pluginId, activationId));
        acquiredOwnerKeys.add(key);
      }
      return await operation([...entries]);
    } finally {
      for (const lease of leases.values()) lease.release();
    }
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
    ...(entry.owner ? { pluginOwner: entry.owner } : {}),
  };
}

function pluginProjectionKey(projection: PreparedPluginHookProjection): string {
  const owner = projection.owner;
  return [owner.pluginId, owner.pluginVersion, owner.generationId, owner.localId, owner.fingerprint].join("|");
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
