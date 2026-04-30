/**
 * Boot §4.2 Step 3-5 — Plugin runtime + HostApi factory.
 *
 * Extracted from boot.ts to keep orchestration thin. This module:
 *   • constructs the PluginDeploymentGuard and plugin runtime integrity gate
 *   • builds the per-plugin HostApi factory (registerKeywords / emitEvent /
 *     onEvent / addTask / getSecret / msGraph* / callLlm /
 *     logEvent / onShutdown)
 *   • creates the PluginRuntime, starts plugins, wires manifest startupTools
 *     and the dev hot-reload watcher
 *   • returns the runtime + late-binding refs (llmCallerRef / pluginCallLlmRef /
 *     conversationLoopRef) that boot.ts injects once ConversationLoop exists.
 *
 * No plugin-specific literals here — everything is manifest-driven.
 */
import { app } from "electron";
import type { BrowserWindow } from "electron";
import { mkdirSync } from "node:fs";
import { AuditLogger, type AuditEntry } from "../../audit/audit-logger.js";
import { PluginRuntime } from "../../plugins/runtime.js";
import { startPluginDevWatcher } from "../../plugins/dev-watcher.js";
import { PluginDeploymentGuard } from "../../plugins/deployment-guard.js";
import { createPluginStorage } from "../../plugins/storage.js";
import {
  setIsPackaged,
  shouldWarnPackagedFlagsIgnored,
  tamperedVarsAtBoot,
} from "../dev-flags.js";
import { requiredCapabilityForEmit } from "../../plugins/capabilities.js";
import { resolvePluginPaths } from "../../plugins/plugin-paths.js";
import {
  emitPluginConfigChange,
  subscribePluginConfigChange,
} from "../../plugins/config-change-bus.js";
import { PROACTIVE_SOURCE_PATTERN } from "../../engine/proactive-source.js";
import { TaskSourceRegistry, deriveCategoryId } from "../../plugins/task-source-registry.js";
import type {
  ConversationTriggerResult,
  ConversationTriggerSpec,
  PluginHostApi,
  PluginManifest,
} from "../../plugins/types.js";
import type { KeywordEngine } from "../../core/keyword-engine.js";
import type { ToolRegistry } from "../../tools/registry.js";
import type { SettingsService } from "../../data/settings-store.js";
import type { MemoryManager } from "../../memory/memory-manager.js";
import type { TaskService } from "../../taskService.js";
import { emitEvent, onEvent } from "../types.js";
import {
  buildPluginConfigOverrides,
  registerPluginTools,
  runManifestStartupTools,
} from "../plugins.js";

/**
 * In-memory dedupe for `hostApi.triggerConversation()`. A brain plugin can set
 * `dedupeKey` on a trigger spec to suppress repeats from the same observation
 * (e.g., the same mail re-emitting events). Keyed per pluginId so two plugins
 * cannot collide. TTL is intentionally short — long-term suppression should
 * live in the plugin, not the host.
 */
export const TRIGGER_CONVERSATION_DEDUPE_TTL_MS = 5 * 60 * 1000;

export class TriggerConversationDedupe {
  private readonly seen = new Map<string, number>();
  private key(pluginId: string, dedupeKey: string): string {
    return `${pluginId}::${dedupeKey}`;
  }
  has(pluginId: string, dedupeKey: string): boolean {
    const key = this.key(pluginId, dedupeKey);
    const seenAt = this.seen.get(key);
    if (seenAt === undefined) return false;
    if (Date.now() - seenAt > TRIGGER_CONVERSATION_DEDUPE_TTL_MS) {
      this.seen.delete(key);
      return false;
    }
    return true;
  }
  record(pluginId: string, dedupeKey: string): void {
    // True LRU: delete-then-set refreshes Map insertion order so a frequently
    // re-recorded key won't be evicted as "oldest" when capping. Map#set on
    // an existing key would otherwise leave the original insertion position.
    const key = this.key(pluginId, dedupeKey);
    if (this.seen.has(key)) this.seen.delete(key);
    this.seen.set(key, Date.now());
    if (this.seen.size > 256) {
      // Cap unbounded growth; drop the oldest recorded key. Cheap for the
      // small N expected.
      const oldestKey = this.seen.keys().next().value;
      if (oldestKey !== undefined) this.seen.delete(oldestKey);
    }
  }
}

const ALLOWED_VISIBILITIES: ReadonlySet<"silent" | "summary-only" | "user-visible"> = new Set([
  "silent",
  "summary-only",
  "user-visible",
] as const);
const ALLOWED_PRIORITIES: ReadonlySet<"low" | "normal" | "high"> = new Set([
  "low",
  "normal",
  "high",
] as const);
/** Bound dedupeKey length so a malicious / buggy plugin cannot bloat audit logs. */
const MAX_DEDUPE_KEY_LEN = 128;
/** Bound source length — same reason. dedupeKey was bounded; review caught source. */
const MAX_SOURCE_LEN = 128;
/**
 * Bound prompt length. The host trusts the plugin's templated-only contract
 * (a comment in `types.ts`) but offers no enforcement; capping prevents an
 * accidental whole-mail dump from blowing past the LLM context. 4 KB is
 * generous for templated suggestions and tight enough to reject a body.
 */
const MAX_PROMPT_LEN = 4096;
// `SOURCE_PATTERN` is the strict shape required for the `source` field
// of every proactive trigger spec. It's the SAME pattern used by the
// keyword engine, the trigger executor envelope, the IPC bridge's
// originSource detection, and the permission manager's proactive-
// origin override — see `engine/proactive-source.ts` for the single
// definition. Without this gate, malformed sources (`proactive:`,
// `proactive:_x`, `proactive:Bad/Path`) could flow into audit logs and
// system prompts where loose substrings would be confusing.

/**
 * Per-plugin rate limit for `triggerConversation()`. A plugin that omits
 * `dedupeKey` (or rotates it per call) is otherwise unbounded — fire-and-
 * forget into runTriggerTurn could spawn N concurrent LLM streams. Token
 * bucket capped at 6 calls / 60 seconds per plugin (sustained), with
 * burst of 3 — picked so the demo scenarios (one-meeting-mail, one-task-
 * deadline) do not throttle but a tight loop adversary is stopped early.
 */
export const TRIGGER_CONVERSATION_RATE_LIMIT_WINDOW_MS = 60_000;
export const TRIGGER_CONVERSATION_RATE_LIMIT_MAX_CALLS = 6;

export class TriggerConversationRateLimiter {
  private readonly windowMs: number;
  private readonly maxCalls: number;
  private readonly recent = new Map<string, number[]>();

  constructor(
    windowMs: number = TRIGGER_CONVERSATION_RATE_LIMIT_WINDOW_MS,
    maxCalls: number = TRIGGER_CONVERSATION_RATE_LIMIT_MAX_CALLS,
  ) {
    this.windowMs = windowMs;
    this.maxCalls = maxCalls;
  }

  /**
   * True when adding one more call would exceed the cap. Compacts the
   * underlying map entry as a side-effect — without this the entry would
   * grow unboundedly during sustained denial loops.
   */
  isOverCap(pluginId: string, now: number = Date.now()): boolean {
    const calls = this.recent.get(pluginId) ?? [];
    const cutoff = now - this.windowMs;
    const fresh = calls.filter((t) => t >= cutoff);
    if (fresh.length !== calls.length) this.recent.set(pluginId, fresh);
    return fresh.length >= this.maxCalls;
  }

  record(pluginId: string, now: number = Date.now()): void {
    const calls = this.recent.get(pluginId) ?? [];
    const cutoff = now - this.windowMs;
    const fresh = calls.filter((t) => t >= cutoff);
    fresh.push(now);
    this.recent.set(pluginId, fresh);
  }
}

const triggerConversationRateLimiter = new TriggerConversationRateLimiter();

/**
 * Suppress a flood of identical denial audit rows. Without this, a plugin in
 * a tight loop with always-bad input (e.g. invalid source) hits the gate
 * before the rate limiter `record` runs (denials don't consume cap), so it
 * could write thousands of audit rows / second. We log the first denial of
 * a (pluginId, reason) pair, then suppress identical follow-ups for 60s and
 * emit one consolidated "...denials suppressed" line at expiry.
 */
const TRIGGER_DENY_AUDIT_WINDOW_MS = 60_000;

export class TriggerDenyAuditThrottle {
  private readonly windowMs: number;
  private readonly state = new Map<string, { suppressedSince: number; count: number }>();

  constructor(windowMs: number = TRIGGER_DENY_AUDIT_WINDOW_MS) {
    this.windowMs = windowMs;
  }

  /**
   * Returns whether the caller should write the audit row right now.
   * - First seen → returns true, marks suppression window open.
   * - Within open window → returns false, increments suppressed count.
   * - Window expired → returns true (with a "suppressed N" hint via
   *   {@link drainSuppressed}).
   */
  shouldEmit(pluginId: string, reason: string, now: number = Date.now()): boolean {
    const key = `${pluginId}::${reason}`;
    const entry = this.state.get(key);
    if (entry === undefined) {
      this.state.set(key, { suppressedSince: now, count: 0 });
      return true;
    }
    if (now - entry.suppressedSince >= this.windowMs) {
      // Window expired — emit again, and the caller can summarize the
      // suppressed period via drainSuppressed().
      this.state.set(key, { suppressedSince: now, count: 0 });
      return true;
    }
    entry.count += 1;
    return false;
  }

  /**
   * Returns the count of suppressed events since the last emit for this key
   * and resets the counter (caller appends `... +N suppressed` to the audit
   * row). Returns 0 if the most recent decision was an emit.
   */
  drainSuppressed(pluginId: string, reason: string): number {
    const entry = this.state.get(`${pluginId}::${reason}`);
    if (!entry) return 0;
    const n = entry.count;
    entry.count = 0;
    return n;
  }
}

const triggerDenyAuditThrottle = new TriggerDenyAuditThrottle();

/**
 * Pure decision function for the `triggerConversation` gate. Extracted from
 * createHostApi so production code and tests share one implementation —
 * any future drift would have to be intentional.
 *
 * Returns either:
 *   { kind: "deny", result }      — fully-formed ConversationTriggerResult
 *                                   the host should return; audit row has
 *                                   already been written.
 *   { kind: "allow", result, ... } — caller should dispatch runTriggerTurn
 *                                   with the normalized fields.
 *
 * The function ALSO writes the success / deny audit rows so the caller
 * stays simple (no double-bookkeeping).
 */
export interface EvaluateTriggerSpecInput {
  spec: ConversationTriggerSpec | undefined | null;
  pluginId: string;
  capabilities: readonly string[];
  dedupe: TriggerConversationDedupe;
  rateLimiter: TriggerConversationRateLimiter;
  /** Burst-suppress identical denial audit rows. */
  denyAuditThrottle?: TriggerDenyAuditThrottle;
  loopBound: boolean;
  auditLogger: { log(entry: AuditEntry): void };
  now?: () => number;
}

export type EvaluateTriggerSpecOutcome =
  | { kind: "deny"; result: ConversationTriggerResult }
  | {
      kind: "allow";
      result: ConversationTriggerResult;
      source: string;
      visibility: "silent" | "summary-only" | "user-visible";
      priority: "low" | "normal" | "high";
    };

export function evaluateTriggerSpec(
  input: EvaluateTriggerSpecInput,
): EvaluateTriggerSpecOutcome {
  const {
    spec,
    pluginId,
    capabilities,
    dedupe,
    rateLimiter,
    loopBound,
    auditLogger,
  } = input;
  const denyAuditThrottle = input.denyAuditThrottle;
  const now = input.now ?? Date.now;

  // NEVER slice-before-validate: slicing a too-long source could turn
  // obviously-bad input into a passing prefix. Reject outright (below)
  // so the regex sees the original.
  const source = typeof spec?.source === "string" ? spec.source : "";
  const { visibility, priority, dedupeKey } = normalizeTriggerSpecFields(
    spec ?? ({} as ConversationTriggerSpec),
  );

  const auditDeny = (reasonInput: string) => {
    // Reason key is the first `reason=<value>` token, used to throttle
    // identical denials per-(pluginId, reason). Different reasons (e.g.
    // capability_denied vs invalid_source) get independent windows.
    const reasonKey = (/reason=([a-z_]+)/.exec(reasonInput)?.[1]) ?? "unknown";
    if (denyAuditThrottle && !denyAuditThrottle.shouldEmit(pluginId, reasonKey, now())) {
      return;
    }
    const suppressed = denyAuditThrottle?.drainSuppressed(pluginId, reasonKey) ?? 0;
    try {
      auditLogger.log({
        timestamp: new Date(now()).toISOString(),
        sessionId: "plugin",
        type: "error",
        input:
          `[plugin:${pluginId}] trigger_conversation_denied ${reasonInput}` +
          (suppressed > 0 ? ` (+${suppressed} suppressed)` : ""),
      });
    } catch { /* audit must not break host */ }
  };

  if (!capabilities.includes("conversation-trigger")) {
    auditDeny("reason=capability_denied");
    return {
      kind: "deny",
      result: { accepted: false, reason: "capability_denied", source: "" },
    };
  }
  // Order matters: env-fault (`loop_unavailable`) supersedes state
  // opinions (`duplicate`, `rate_limited`) so a plugin retrying during
  // boot ordering windows sees the actual cause.
  if (!loopBound) {
    auditDeny("reason=loop_unavailable");
    return {
      kind: "deny",
      result: { accepted: false, reason: "loop_unavailable", source },
    };
  }
  // A too-long source is rejected outright; the regex sees the original
  // string (no slice-before-validate). Same for prompt length.
  if (source.length > MAX_SOURCE_LEN || !PROACTIVE_SOURCE_PATTERN.test(source)) {
    auditDeny(`reason=invalid_source source=${source.slice(0, 32) || "<empty>"}`);
    return {
      kind: "deny",
      // Echo only the first 32 chars so a malicious 10MB source cannot
      // pin into the caller-visible result either.
      result: { accepted: false, reason: "invalid_source", source: source.slice(0, 32) },
    };
  }
  if (typeof spec?.prompt !== "string" || spec.prompt.trim().length === 0) {
    auditDeny(`reason=invalid_source source=${source} (empty prompt)`);
    return {
      kind: "deny",
      result: { accepted: false, reason: "invalid_source", source },
    };
  }
  if (spec.prompt.length > MAX_PROMPT_LEN) {
    auditDeny(`reason=invalid_source source=${source} (prompt>${MAX_PROMPT_LEN})`);
    return {
      kind: "deny",
      result: { accepted: false, reason: "invalid_source", source },
    };
  }
  if (rateLimiter.isOverCap(pluginId, now())) {
    auditDeny("reason=rate_limited");
    return {
      kind: "deny",
      result: { accepted: false, reason: "rate_limited", source },
    };
  }
  if (dedupeKey && dedupe.has(pluginId, dedupeKey)) {
    auditDeny(`reason=duplicate dedupeKey=${dedupeKey}`);
    return {
      kind: "deny",
      result: { accepted: false, reason: "duplicate", source },
    };
  }

  // Allow path — record both bookkeeping operations BEFORE returning so the
  // caller never gets an "accepted=true" without the dedupe + rate window
  // having advanced.
  if (dedupeKey) dedupe.record(pluginId, dedupeKey);
  rateLimiter.record(pluginId, now());

  // Compose the success audit row with sanitized contextKeys — key names
  // can carry PII so we accept only keys matching a strict identifier shape
  // and report a count for the rest. Single audit row per accepted trigger;
  // the loop-side trigger row would be redundant.
  let contextSuffix = "";
  if (spec?.context) {
    const KEY_SHAPE = /^[a-zA-Z_][a-zA-Z0-9_]{0,32}$/;
    const allKeys = Object.keys(spec.context);
    const okKeys = allKeys.filter((k) => KEY_SHAPE.test(k));
    const badCount = allKeys.length - okKeys.length;
    const parts: string[] = [];
    if (okKeys.length > 0) parts.push(`contextKeys=${okKeys.slice(0, 8).join(",")}`);
    if (badCount > 0) parts.push(`contextKeysOmitted=${badCount}`);
    if (parts.length > 0) contextSuffix = ` ${parts.join(" ")}`;
  }
  try {
    auditLogger.log({
      timestamp: new Date(now()).toISOString(),
      sessionId: "plugin",
      type: "tool_call",
      input:
        `[plugin:${pluginId}] trigger_conversation source=${source} ` +
        `visibility=${visibility} priority=${priority}` +
        (dedupeKey ? ` dedupeKey=${dedupeKey}` : "") +
        contextSuffix,
    });
  } catch { /* audit must not break host */ }

  return {
    kind: "allow",
    result: { accepted: true, source },
    source,
    visibility,
    priority,
  };
}

/**
 * Normalize plugin-supplied trigger fields to known/safe values BEFORE they
 * flow into audit logs or downstream pipelines. Unknown enum values fall
 * back to defaults. Non-string dedupeKey is dropped.
 */
export function normalizeTriggerSpecFields(spec: ConversationTriggerSpec): {
  visibility: "silent" | "summary-only" | "user-visible";
  priority: "low" | "normal" | "high";
  dedupeKey: string | undefined;
} {
  const visibility = ALLOWED_VISIBILITIES.has(
    spec.visibility as "silent" | "summary-only" | "user-visible",
  )
    ? (spec.visibility as "silent" | "summary-only" | "user-visible")
    : "summary-only";
  const priority = ALLOWED_PRIORITIES.has(
    spec.priority as "low" | "normal" | "high",
  )
    ? (spec.priority as "low" | "normal" | "high")
    : "normal";
  let dedupeKey: string | undefined;
  if (typeof spec.dedupeKey === "string") {
    const trimmed = spec.dedupeKey.trim();
    if (trimmed.length > 0) {
      dedupeKey = trimmed.length > MAX_DEDUPE_KEY_LEN
        ? trimmed.slice(0, MAX_DEDUPE_KEY_LEN)
        : trimmed;
    }
  }
  return { visibility, priority, dedupeKey };
}

const triggerConversationDedupe = new TriggerConversationDedupe();

/** Late-binding container the ConversationLoop fills in after it exists. */
export interface LateBindingRefs {
  llmCallerRef: {
    fn:
      | ((prompt: string, opts?: { maxTokens?: number; systemPrompt?: string }) => Promise<string>)
      | null;
  };
  pluginCallLlmRef: {
    fn:
      | ((
          pluginId: string,
          prompt: string,
          opts?: { maxTokens?: number; systemPrompt?: string },
        ) => Promise<string>)
      | null;
  };
  conversationLoopRef: {
    fn: import("../../engine/conversation-loop.js").ConversationLoop | null;
  };
  /**
   * Trigger executor — built once boot wires up the
   * `createTriggerConversationLoop` factory + main window. Every
   * `hostApi.triggerConversation()` call dispatches through this so the
   * trigger turn runs on a *fresh* loop, not the user's chat loop.
   */
  triggerExecutorRef: {
    fn: import("../../engine/trigger-executor.js").TriggerExecutor | null;
  };
}

export interface InitPluginRuntimeInput {
  projectRoot: string;
  settingsService: SettingsService;
  memoryManager: MemoryManager;
  keywordEngine: KeywordEngine;
  toolRegistry: ToolRegistry;
  taskService: TaskService;
  pythonPath: string | undefined;
  bootAuditLogger: AuditLogger;
  mainWindow: BrowserWindow;
  openAuthWindowService: (
    parent: BrowserWindow,
    opts: Parameters<PluginHostApi["openAuthWindow"]>[0],
  ) => ReturnType<PluginHostApi["openAuthWindow"]>;
}

export interface InitPluginRuntimeOutput {
  pluginRuntime: PluginRuntime;
  deploymentGuard: PluginDeploymentGuard;
  taskSourceRegistry: TaskSourceRegistry;
  lateBinding: LateBindingRefs;
  pluginShutdownHandlers: Array<{ pluginId: string; handler: () => void | Promise<void> }>;
  /** Phase 0 SoT — shared with MarketplaceService + post-boot update detector. */
  pluginPaths: ReturnType<typeof resolvePluginPaths>;
}

/**
 * §4.2 Step 3-5 — construct PluginRuntime, register the per-plugin HostApi
 * factory, start all plugins, run manifest startupTools, register plugin
 * tools into ToolRegistry, and wire the dev hot-reload watcher.
 */
export async function initPluginRuntime(
  input: InitPluginRuntimeInput,
): Promise<InitPluginRuntimeOutput> {
  const {
    projectRoot,
    settingsService,
    memoryManager,
    keywordEngine,
    toolRegistry,
    taskService,
    pythonPath,
    bootAuditLogger,
    mainWindow,
    openAuthWindowService,
  } = input;

  // Plugin shutdown handler registry — fires on before-quit (see Sprint 1-A A3).
  const pluginShutdownHandlers: Array<{ pluginId: string; handler: () => void | Promise<void> }> = [];
  let pluginShutdownRan = false;
  app.prependOnceListener("before-quit", (event) => {
    if (pluginShutdownHandlers.length === 0 || pluginShutdownRan) return;
    pluginShutdownRan = true;
    const SHUTDOWN_TIMEOUT_MS = 5000;
    event.preventDefault();
    void (async () => {
      await Promise.allSettled(
        pluginShutdownHandlers.map(async ({ pluginId, handler }) => {
          let timer: NodeJS.Timeout | undefined;
          try {
            await Promise.race([
              Promise.resolve().then(() => handler()),
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error("shutdown handler timeout")), SHUTDOWN_TIMEOUT_MS);
              }),
            ]);
          } catch (err) {
            console.warn(`[plugin:${pluginId}] shutdown handler error:`, (err as Error).message);
          } finally {
            if (timer) clearTimeout(timer);
          }
        }),
      );
      app.quit();
    })();
  });

  // TaskSource 자기 등록 레지스트리
  const taskSourceRegistry = new TaskSourceRegistry();

  // 범용 configOverrides + pythonExecutable 선언형 주입
  const configOverrides = buildPluginConfigOverrides(settingsService);
  if (pythonPath) {
    configOverrides["*"] = {
      ...(configOverrides["*"] ?? {}),
      pythonExecutable: pythonPath,
    };
  }

  // §7.2 Plugin Deployment Guard.
  // Plugin layout anchors at `~/.lvis/plugins/<id>/` — single root for both
  // user-installed and admin-injected plugins (distinguished by metadata,
  // not by physical directory). The resolver always uses
  // `homedir()/.lvis/plugins`; tests pass an explicit `pluginsRoot` for
  // sandbox isolation (Round-3 removed the env-tier override).
  const pluginPaths = resolvePluginPaths();
  // mkdir the root once so the trust-root realpath check in PluginRuntime
  // (and any first-install write under pluginsRoot/<id>/) doesn't trip on a
  // missing directory the very first time the app boots.
  mkdirSync(pluginPaths.pluginsRoot, { recursive: true });
  const deploymentGuard = new PluginDeploymentGuard({
    registryPath: pluginPaths.registryPath,
    pluginsRoot: pluginPaths.pluginsRoot,
  });

  // Late-binding refs for ConversationLoop-dependent callers.
  const lateBinding: LateBindingRefs = {
    llmCallerRef: { fn: null },
    pluginCallLlmRef: { fn: null },
    conversationLoopRef: { fn: null },
    triggerExecutorRef: { fn: null },
  };

  // Phase 1 §Step 4 — wire `app.isPackaged` into the dev-flag gate before any
  // helper or downstream module reads it. Packaged builds with LVIS_DEV* set
  // get a single audit warning, never a per-flag enumeration.
  setIsPackaged(app.isPackaged);
  if (shouldWarnPackagedFlagsIgnored()) {
    // Snapshot was captured at `dev-flags.ts` import time, BEFORE
    // `main.ts:67-73` scrubbed the vars from `process.env`. Listing the
    // specific names lets operators distinguish a stale launcher
    // (`LVIS_PLUGINS_DIR`) from an active dev tamper (`LVIS_DEV=1`).
    const names = tamperedVarsAtBoot();
    console.error(`[lvis] LVIS_DEV* ignored in packaged build: ${names.join(", ")}`);
  }

  // PR 3c: ms-graph 자체 인증으로 이전 후 host 측 MS HostApi 메서드 / capability gate 제거.
  // ms-graph-consumer capability 는 plugin 자기 식별 라벨로 plugin.json 에 남지만
  // host 의 capability 검증 게이트는 더 이상 존재하지 않는다 (plugin 이 자체 MSAL 소유).
  let pluginRuntime!: PluginRuntime;

  // Phase 1 §Step 1 + §Step 2 — thread the user-installed dir as a second
  // trust root and the unsigned-user-plugin opt-in flag.
  pluginRuntime = new PluginRuntime({
    hostRoot: projectRoot,
    pluginsRoot: pluginPaths.pluginsRoot,
    registryPath: pluginPaths.registryPath,
    configOverrides,
    deploymentGuard,
    installReceiptCacheRoot: pluginPaths.cacheRoot,
    auditLog: (level, message, data) => {
      try {
        bootAuditLogger.log({
          timestamp: new Date().toISOString(),
          sessionId: "plugin-runtime",
          type: level === "error" ? "error" : "tool_call",
          input: `[${level.toUpperCase()}] ${message}`,
          output: data === undefined ? undefined : JSON.stringify(data).slice(0, 500),
        });
      } catch {}
    },
    onDisable: (pluginId) => {
      keywordEngine.unregisterByPlugin(pluginId);
      toolRegistry.unregisterByPlugin(pluginId);
      lateBinding.conversationLoopRef.fn?.onPluginDisabled(pluginId);
    },
    createHostApi: (pluginId: string, manifest: PluginManifest, pluginDataDir: string): PluginHostApi => ({
      storage: createPluginStorage(pluginId, pluginDataDir, (msg, meta) => {
        try {
          bootAuditLogger.log({
            timestamp: new Date().toISOString(),
            sessionId: "plugin",
            type: "warn",
            input: `[plugin:${pluginId}] storage_${msg.replace(/\s+/g, "_")} ${typeof meta === "object" ? JSON.stringify(meta) : ""}`.trim(),
          });
        } catch { /* audit must not break host */ }
      }),
      // §9.2 Track B — typed plugin config access, scoped to this pluginId.
      // `get` reads the live merged config (manifest defaults + saved
      //   overrides) directly from settingsService so a write from another
      //   surface (renderer, IPC, sibling plugin) is visible without reload.
      // `set` persists via the same `setPluginConfig` IPC bridge used by the
      //   settings UI and triggers a plugin reload so the plugin's `config`
      //   snapshot in `PluginRuntimeContext.config` is rebuilt with the new
      //   value. `format: "secret"` keys are rejected here — secrets MUST go
      //   through `hostApi.setSecret` so they land encrypted, never in
      //   cleartext `pluginConfigs`.
      // `onChange` listeners are registered against the plugin's own id only;
      //   the underlying bus rejects cross-plugin observation.
      config: {
        get: <T = unknown>(key: string): T | undefined => {
          const merged = {
            ...(manifest.config ?? {}),
            ...(settingsService.getPluginConfig(pluginId) ?? {}),
          };
          return merged[key] as T | undefined;
        },
        set: async <T = unknown>(key: string, value: T): Promise<void> => {
          const schemaProp = manifest.configSchema?.properties?.[key];
          if (schemaProp?.type === "string" && schemaProp.format === "secret") {
            throw new Error(
              `[plugin:${pluginId}] config.set('${key}'): secret fields must be saved via hostApi.setSecret(), not config.set().`,
            );
          }
          const current = settingsService.getPluginConfig(pluginId) ?? {};
          // structuredClone so we never accidentally hand the plugin our
          // internal record reference.
          const nextRecord = structuredClone({
            ...current,
            [key]: value as unknown,
          });
          await settingsService.setPluginConfig(pluginId, nextRecord);
          // Mirror the IPC handler — refresh the runtime's per-plugin
          // override so the next reload picks up the new value, then emit
          // the change so existing listeners observe it without waiting
          // for the reload.
          pluginRuntime.setConfigOverride(pluginId, nextRecord);
          emitPluginConfigChange(pluginId, key, value);
          // Reload the affected plugin so its handlers see the new config
          // on next invocation. We restart the whole runtime to match the
          // existing IPC `set` behaviour (lvis:plugins:config:set →
          // restartAll).
          try {
            await pluginRuntime.restartAll();
          } catch (err) {
            // Restart already audits per-plugin failures; surface the
            // outer error so the calling plugin can branch on it.
            throw new Error(
              `[plugin:${pluginId}] config.set('${key}'): runtime reload failed: ${(err as Error).message}`,
            );
          }
        },
        onChange: <T = unknown>(
          key: string,
          callback: (value: T | undefined) => void,
        ): (() => void) => {
          const unsubscribe = subscribePluginConfigChange(
            pluginId,
            key,
            (_changedKey, value) => {
              callback(value as T | undefined);
            },
          );
          // Auto-cleanup on plugin disable to mirror onEvent semantics.
          pluginRuntime.registerDisposer(pluginId, unsubscribe);
          return unsubscribe;
        },
      },
      registerKeywords: (keywords) => {
        keywordEngine.registerKeywords(
          keywords.map((k) => ({ ...k, pluginId })),
        );
        console.log(`[lvis] plugin:${pluginId} registered ${keywords.length} keywords`);
      },
      emitEvent: (type, data) => {
        const requiredCap = requiredCapabilityForEmit(type);
        if (requiredCap) {
          const manifest = pluginRuntime?.getPluginManifest(pluginId);
          if (!manifest?.capabilities?.includes(requiredCap)) {
            try {
              bootAuditLogger.log({
                timestamp: new Date().toISOString(),
                sessionId: "plugin",
                type: "error",
                input: `[plugin:${pluginId}] plugin_emit_capability_denied eventType=${type} required=${requiredCap} actual=${(manifest?.capabilities ?? []).join("|")}`,
              });
            } catch { /* audit must not break host */ }
            console.warn(
              `[lvis] plugin:${pluginId} emitEvent('${type}') dropped — missing capability '${requiredCap}'`,
            );
            return;
          }
        }
        pluginRuntime.assertPluginEventEmitAccess(pluginId, type);
        emitEvent(type, { ...((data as Record<string, unknown>) ?? {}), pluginId });
      },
      onEvent: (type, handler) => {
        pluginRuntime.assertPluginEventAccess(pluginId, type);
        const unsubscribe = onEvent(type, handler);
        pluginRuntime.registerDisposer(pluginId, unsubscribe);
        return unsubscribe;
      },
      addTask: (task) => {
        const categoryId = deriveCategoryId(pluginId, task.source);
        taskSourceRegistry.register({ id: categoryId, origin: "plugin", pluginId });
        taskService.add({
          title: task.title,
          description: task.description,
          source: categoryId,
          sourceRef: task.sourceRef,
          priority: task.priority ?? "medium",
          status: "pending",
        });
        console.log(`[lvis] plugin:${pluginId} created task: "${task.title.slice(0, 50)}"`);
      },
      getSecret: (key) => {
        return settingsService.getSecret(key);
      },
      callTool: async <T = unknown>(toolName: string, payload?: unknown): Promise<T> => {
        pluginRuntime.assertPluginToolAccess(pluginId, toolName);
        return pluginRuntime.call(toolName, payload) as Promise<T>;
      },
      callLlm: async (prompt, opts) => {
        if (lateBinding.pluginCallLlmRef.fn) {
          return lateBinding.pluginCallLlmRef.fn(pluginId, prompt, opts);
        }
        if (!lateBinding.llmCallerRef.fn) throw new Error("LLM provider not ready");
        return lateBinding.llmCallerRef.fn(prompt, opts);
      },
      logEvent: (level, message, data) => {
        try {
          bootAuditLogger.log({
            timestamp: new Date().toISOString(),
            sessionId: "plugin",
            type: level === "error" ? "error" : "tool_call",
            input: `[plugin:${pluginId}] [${level.toUpperCase()}] ${message}`,
            output: data === undefined ? undefined : JSON.stringify(data).slice(0, 500),
          });
        } catch (err) {
          console.warn(`[plugin:${pluginId}] logEvent failed:`, (err as Error).message);
        }
      },
      onShutdown: (handler) => {
        pluginShutdownHandlers.push({ pluginId, handler });
      },
      // ─── 외부 포털 interactive 인증 (쿠키 수집) ───────────────────
      // `external-auth-consumer` capability 로 게이팅 — 쿠키는 민감 자산이므로
      // 선언적 opt-in 없이는 호출 거부. 거부/허용 모두 AuditLogger 에 남긴다.
      //
      // 로그에는 origin + path 만 기록 — SAML/OAuth URL 에 담기는 민감 query
      // (SAMLRequest, code, state, session id 등) 은 유출 방지 위해 제외.
      openAuthWindow: async (opts) => {
        const safeUrlForLog = (() => {
          try {
            const parsed = new URL(opts.url);
            return `${parsed.origin}${parsed.pathname}`;
          } catch {
            return "[invalid-url]";
          }
        })();
        const cookieHostCount = Array.isArray(opts.cookieHosts) ? opts.cookieHosts.length : 0;

        if (!manifest.capabilities?.includes("external-auth-consumer")) {
          try {
            bootAuditLogger.log({
              timestamp: new Date().toISOString(),
              sessionId: "plugin",
              type: "error",
              input: `[plugin:${pluginId}] open_auth_window_capability_denied url=${safeUrlForLog} missingCapability=external-auth-consumer`,
            });
          } catch { /* audit must not break host */ }
          throw new Error(
            `[plugin:${pluginId}] capability not declared: external-auth-consumer`,
          );
        }

        console.log(
          `[lvis] plugin:${pluginId} openAuthWindow url=${safeUrlForLog} cookieHostCount=${cookieHostCount}`,
        );
        try {
          bootAuditLogger.log({
            timestamp: new Date().toISOString(),
            sessionId: "plugin",
            type: "tool_call",
            input:
              `[plugin:${pluginId}] openAuthWindow ` +
              `url=${safeUrlForLog} cookieHostCount=${cookieHostCount}`,
          });
        } catch { /* audit must not break host */ }

        // 기본값은 plugin 별 비영속 partition. Electron 의 default session 을
        // 쓰면 (a) 여러 BrowserWindow 간 쿠키가 공유되어 타 플러그인이
        // 수집한 세션을 그대로 볼 수 있고 (b) 디스크에 영속화된다. 둘 다
        // openAuthWindow 의 "호스트는 세션을 보관하지 않는다" 원칙 위반.
        //
        // 플러그인이 명시적으로 지정한 persistPartition 은 반드시 자기
        // 네임스페이스(`persist:plugin-auth:<pluginId>` 또는 그 하위 `:<sub>`)
        // 여야 한다. 그렇지 않으면 plugin A 가 `plugin-auth:pluginB` 를 지정해
        // plugin B 의 쿠키를 읽어가는 cross-plugin exfiltration 경로가 열린다.
        const encodedId = encodeURIComponent(pluginId);
        const defaultPartition = `plugin-auth:${encodedId}`;
        const allowedPersistBase = `persist:${defaultPartition}`;
        const requested = opts.persistPartition;
        if (
          requested !== undefined &&
          requested !== allowedPersistBase &&
          !requested.startsWith(`${allowedPersistBase}:`)
        ) {
          try {
            bootAuditLogger.log({
              timestamp: new Date().toISOString(),
              sessionId: "plugin",
              type: "error",
              input:
                `[plugin:${pluginId}] open_auth_window_invalid_partition ` +
                `persistPartition=${requested} allowed=${allowedPersistBase}[:<sub>]`,
            });
          } catch { /* audit must not break host */ }
          throw new Error(
            `[plugin:${pluginId}] openAuthWindow: persistPartition must be '${allowedPersistBase}' or '${allowedPersistBase}:<sub>'`,
          );
        }
        const effectiveOpts = requested
          ? opts
          : { ...opts, persistPartition: defaultPartition };
        return openAuthWindowService(mainWindow, effectiveOpts);
      },

      // ─── Proactive Brain — hostApi.triggerConversation() ───────────────
      // Gate body lives in evaluateTriggerSpec() so prod and tests share
      // one implementation; tests import + call this directly. Dispatch
      // goes through TriggerExecutor which spawns a fresh ConversationLoop
      // per trigger so the user's chat history is never polluted by the
      // templated proactive turn.
      triggerConversation: async (spec: ConversationTriggerSpec) => {
        const decision = evaluateTriggerSpec({
          spec,
          pluginId,
          capabilities: manifest.capabilities ?? [],
          dedupe: triggerConversationDedupe,
          rateLimiter: triggerConversationRateLimiter,
          denyAuditThrottle: triggerDenyAuditThrottle,
          // `loop_unavailable` now maps to the trigger executor being unwired
          // (boot ordering) rather than the user's chat loop missing.
          loopBound: !!lateBinding.triggerExecutorRef.fn,
          auditLogger: bootAuditLogger,
        });
        if (decision.kind === "deny") return decision.result;

        // Dispatch fire-and-forget. Wrap in Promise.resolve to convert any
        // synchronous throw inside the executor into a rejection — the
        // outer caller of triggerConversation must NEVER see an exception
        // from this code path.
        const executor = lateBinding.triggerExecutorRef.fn!;
        void Promise.resolve()
          .then(() =>
            executor.run({
              prompt: spec.prompt,
              pluginId,
              source: decision.source,
              visibility: decision.visibility,
              priority: decision.priority,
              ...(spec.context ? { context: spec.context } : {}),
            }),
          )
          // The executor already audits the failure with classified reason
          // + raw message (operator-only). Swallow the rejection here — a
          // second audit row per failure would just inflate the log and
          // could leak the raw error to a sessionId tag the executor
          // intentionally split into "trigger-executor".
          .catch(() => undefined);

        return decision.result;
      },
      // Backward-compat shim — 구 calendar/email 플러그인이 호출.
      // ms-graph 통합 이후 호스트 MS 인증 코드가 제거됐으므로 no-op.
      onMsGraphAuthChange: (_handler: () => void) => { /* deprecated */ },
    }),
  });

  await pluginRuntime.startAll();
  console.log("[lvis] boot: plugins loaded:", pluginRuntime.listToolNames());

  // 선언형 startupTools 자동 실행
  runManifestStartupTools(pluginRuntime);

  // 플러그인 메서드를 ToolRegistry에 등록
  registerPluginTools(pluginRuntime, toolRegistry);

  // I2 — Dev-mode live-reload watcher. No-op unless LVIS_DEV_RELOAD=1.
  const pluginDevWatcher = startPluginDevWatcher({
    pluginRuntime,
    onReloaded: (pluginId) => {
      const manifest = pluginRuntime.getPluginManifest(pluginId);
      if (!manifest) return;
      registerPluginTools(pluginRuntime, toolRegistry);
      console.log(`[lvis] plugin:${pluginId} hot-reloaded (${manifest.tools.length} tools)`);
    },
  });
  app.prependOnceListener("before-quit", () => { pluginDevWatcher.stop(); });

  return {
    pluginRuntime,
    deploymentGuard,
    taskSourceRegistry,
    lateBinding,
    pluginShutdownHandlers,
    pluginPaths,
  };
}

// Re-export so boot.ts's return statement can still reach BrowserWindow type.
export type { BrowserWindow };

