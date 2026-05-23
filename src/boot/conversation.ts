/**
 * Boot §4.2 Step 7 — ConversationLoop + dependencies (hooks, approval gate,
 * permission manager, PostTurnHookChain, callLlm sanitiser).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserWindow } from "electron";
import { lvisHome } from "../shared/lvis-home.js";
import type { SettingsService } from "../data/settings-store.js";
import type { MemoryManager } from "../memory/memory-manager.js";
import type { KeywordEngine } from "../core/keyword-engine.js";
import type { RouteEngine } from "../core/route-engine.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { RoutineEngine } from "../core/routine-engine.js";
import type { IdleSchedulerService } from "../main/idle-scheduler.js";
import type { BashAstValidator } from "../main/bash-ast-validator.js";
import type { PluginRuntime } from "../plugins/runtime.js";
import { SystemPromptBuilder } from "../prompts/system-prompt-builder.js";
import { PermissionManager } from "../permissions/permission-manager.js";
import { ApprovalGate } from "../permissions/approval-gate.js";
import { loadPolicy } from "../permissions/policy-store.js";
import { registerStandardCategories } from "../permissions/category-registry.js";
import { ConversationLoop } from "../engine/conversation-loop.js";
import { PostTurnHookChain } from "../hooks/post-turn-hook-chain.js";
import { HookRunner } from "../hooks/hook-runner.js";
import { AuditLogger } from "../audit/audit-logger.js";
import type { NotificationService } from "../main/notification-service.js";
import type { SessionTodoStore } from "../main/session-todo-store.js";
import { createLogger } from "../lib/logger.js";
const log = createLogger("lvis");

/**
 * Tutorial-X4 — read the user-onboarding-context markdown file synth-
 * esized by the renderer wizard. Returns "" when the file is absent or
 * empty so the SystemPromptBuilder source drops out — there is no cost
 * on steady-state turns. The file lives under
 * `~/.lvis/onboarding/onboarding-context.md` (CLAUDE.md storage-namespace
 * rule — domain-specific resource stays inside the `onboarding/`
 * directory). The reader is fully tolerant: read failures swallow to ""
 * so a corrupt file never blocks the chat loop.
 */
function readOnboardingContext(): string {
  try {
    const path = join(lvisHome(), "onboarding", "onboarding-context.md");
    if (!existsSync(path)) return "";
    const raw = readFileSync(path, "utf-8");
    return raw.trim();
  } catch {
    return "";
  }
}

export function createSystemPromptBuilder(opts: {
  memoryManager: MemoryManager;
  toolRegistry: ToolRegistry;
  pluginRuntime: PluginRuntime;
  /**
   * C2(c): per-session SkillOverlay reader. The builder calls this each
   * turn with the active session id and folds the returned section into
   * the system prompt. Optional so unit tests can stub the builder
   * without touching the overlay.
   */
  getActiveSkillsSection?: (sessionId: string) => string;
}): SystemPromptBuilder {
  const { memoryManager, toolRegistry, pluginRuntime, getActiveSkillsSection } = opts;
  return new SystemPromptBuilder({
    memoryManager,
    toolRegistry,
    getPluginSchemas: () => {
      const tools = pluginRuntime.listToolNames();
      if (tools.length === 0) return "";
      return [
        "<active-plugins>",
        `활성 플러그인 도구: ${tools.join(", ")}`,
        "</active-plugins>",
      ].join("\n");
    },
    // Option C — 비활성 plugin 카탈로그 공급.
    getPluginCards: () => pluginRuntime.listPluginCards(toolRegistry),
    getActiveSkillsSection,
    // Tutorial-X4 — User Onboarding Context source. Renderer writes the
    // synthesized markdown after MemorySeedDialog dismissal; reader is
    // file-backed so the conversation loop has no dependency on the
    // renderer state. Empty return drops the section entirely.
    getOnboardingContext: readOnboardingContext,
  });
}

export async function createPermissionManager(): Promise<PermissionManager> {
  // Permission policy — register the 5-axis ToolCategory descriptors before any
  // PermissionManager.checkDetailed() can run. Idempotent: re-calls
  // simply overwrite the registry entries with the same values.
  registerStandardCategories();
  // §6.3: PermissionManager (Layer 2-3)
  const permissionManager = new PermissionManager();
  // 기본 allow 규칙: 조회성 도구 자동 허용
  permissionManager.setRules([
    { pattern: "skill_list", action: "allow" },
    { pattern: "agent_list", action: "allow" },
    { pattern: "web_search", action: "allow" },
    { pattern: "web_fetch", action: "allow" },
  ]);
  // B1: 영구 규칙 파일 로드 (~/.lvis/permissions.json → 인메모리 병합)
  await permissionManager.loadRulesFromFile();
  return permissionManager;
}

export function createPostTurnHookChain(opts: {
  memoryManager: MemoryManager;
  idleScheduler?: IdleSchedulerService;
  settingsService: SettingsService;
  /**
   * Shared AuditLogger. When provided, PostTurnHookChain
   * reuses the same instance as HostApi.logEvent so plugin + host audit
   * trails stay unified. When omitted, a new logger is created.
   */
  auditLogger?: AuditLogger;
}): { postTurnHookChain: PostTurnHookChain; auditLogger: AuditLogger } {
  // §4.5 + Agent 6: PostTurnHookChain 조립
  const auditLogger = opts.auditLogger ?? new AuditLogger();
  const postTurnHookChain = new PostTurnHookChain({
    memoryManager: opts.memoryManager,
    auditLogger,
    idleScheduler: opts.idleScheduler,
    settingsService: opts.settingsService,
  });
  return { postTurnHookChain, auditLogger };
}

export async function createApprovalGate(
  mainWindow: BrowserWindow,
  auditLogger: AuditLogger,
  notificationService?: NotificationService,
): Promise<ApprovalGate> {
  // B1: Policy 로드 후 ApprovalGate 생성 — mainWindow.webContents 준비 후
  // §F7: bootAuditLogger 주입 → requested/decided/timeout/send-failed 4 phase 감사
  // Issue #260: notificationService 주입 → 승인 트리거 시 OS/in-app notification
  const bootPolicy = await loadPolicy();
  return new ApprovalGate(
    mainWindow.webContents,
    bootPolicy,
    5 * 60 * 1000,
    auditLogger,
    notificationService,
  );
}

export function createHookRunner(): HookRunner {
  // Permission policy single hook path: production script hooks are discovered by
  // wireHookSystem() from discrete pre/post/perm-*.sh files under
  // ~/.config/lvis/hooks/. Legacy hooks.json command/http loading is not
  // wired at boot because it bypasses the strict quarantine/accept flow.
  return new HookRunner();
}

export interface ConversationDeps {
  settingsService: SettingsService;
  systemPromptBuilder: SystemPromptBuilder;
  keywordEngine: KeywordEngine;
  routeEngine: RouteEngine;
  toolRegistry: ToolRegistry;
  memoryManager: MemoryManager;
  permissionManager: PermissionManager;
  routineEngine: RoutineEngine;
  idleScheduler?: IdleSchedulerService;
  postTurnHookChain: PostTurnHookChain;
  bashAstValidator: BashAstValidator;
  approvalGate: ApprovalGate;
  hookRunner: HookRunner;
  scriptHookManager?: import("../hooks/script-hook-manager.js").ScriptHookManager;
  pluginRuntime: PluginRuntime;
  additionalDirectories?: readonly string[];
  getAdditionalDirectories?: () => readonly string[];
  /**
   * Fan-out hook for permission config mutations. Boot wires this from
   * `ipc/domains/permissions.ts:broadcastPermissionConfigChanged` so the
   * conversation loop's `addSessionAdditionalDirectory` (dialog-driven
   * session grants) reaches multi-window PermissionsTab subscribers,
   * not only slash-dispatch grants.
   */
  broadcastPermissionConfigChanged?: () => void;
  /** C2(c): per-session SkillOverlay handle, cleared on newConversation(). */
  skillOverlay?: { clear(sessionId: string): void };
  /** Session-scoped assistant TO-DO lifecycle. */
  sessionTodoStore?: SessionTodoStore;
  /** Issue #260: optional notification service for turn-end auto-fire. */
  notificationService?: NotificationService;
  auditLogger?: AuditLogger;
  /** Rebuild the Layer 5 reviewer after persisted reviewer settings change. */
  rewireReviewerAgent?: () => void;
  /** Main-process fetch implementation for SDK-backed LLM calls. */
  llmFetch?: typeof fetch;
}

/**
 * §7: Routine-isolated ConversationLoop factory.
 *
 * Routine execution must NOT share the interactive chat's ConversationLoop
 * instance — doing so would race with concurrent IPC chat turns and pollute
 * the user's session history with routine output.
 *
 * Each call returns a *fresh* ConversationLoop that shares stateless deps
 * (toolRegistry, settings, etc.) but owns its own ConversationHistory so
 * routine turns never appear in the user's chat transcript. Routine loops
 * still receive the approval gate + pre-tool hooks so background writes cannot
 * bypass the normal tool policy.
 */
export type RoutineConversationLoopDeps = Pick<
  ConversationDeps,
  | "settingsService"
  | "systemPromptBuilder"
  | "keywordEngine"
  | "routeEngine"
  | "toolRegistry"
  | "memoryManager"
  | "permissionManager"
  | "approvalGate"
  | "hookRunner"
  | "scriptHookManager"
  | "bashAstValidator"
  | "pluginRuntime"
  | "llmFetch"
  | "auditLogger"
>;

export function createRoutineConversationLoop(
  deps: RoutineConversationLoopDeps,
  opts: { scope?: import("../shared/routines-types.js").RoutineScope } = {},
): ConversationLoop {
  // Layer 1 (UX hot-fix v3): each routine fire gets its *own* SystemPromptBuilder
  // instance with routineMode=true so the LLM is instructed to append a
  // <summary>…</summary> tag. A dedicated instance (not the shared main-chat
  // builder) is used to prevent routineMode from leaking into main-chat turns
  // even when concurrent routine fires and user chat turns overlap.
  const routineSystemPromptBuilder = createSystemPromptBuilder({
    memoryManager: deps.memoryManager,
    toolRegistry: deps.toolRegistry,
    pluginRuntime: deps.pluginRuntime,
    // Skill overlay is interactive-only — routine sessions are headless.
  });
  routineSystemPromptBuilder.setRoutineMode(true);
  // Permission policy Layer 4 — translate the discriminated scope into the loop's
  // ConversationLoopDeps shape. The scope must already be normalized
  // (no `inherit`) by the dispatcher before this factory runs.
  const scope = opts.scope;
  let allowedPluginIds: Set<string>;
  if (!scope || scope.pluginIds.mode === "inherit") {
    // Defensive default — should never hit production because the
    // dispatcher normalizes inherit to a snapshot. Coerce to deny-all
    // so we fail closed instead of opening up the full active set.
    allowedPluginIds = new Set();
  } else if (scope.pluginIds.mode === "deny-all") {
    allowedPluginIds = new Set();
  } else {
    allowedPluginIds = new Set(scope.pluginIds.ids);
  }
  const forcedActivePluginIds = new Set(scope?.forcedPluginIds ?? []);
  return new ConversationLoop({
    settingsService: deps.settingsService,
    systemPromptBuilder: routineSystemPromptBuilder,
    keywordEngine: deps.keywordEngine,
    routeEngine: deps.routeEngine,
    toolRegistry: deps.toolRegistry,
    memoryManager: deps.memoryManager,
    permissionManager: deps.permissionManager,
    approvalGate: deps.approvalGate,
    hookRunner: deps.hookRunner,
    scriptHookManager: deps.scriptHookManager,
    bashAstValidator: deps.bashAstValidator,
    pluginRuntime: deps.pluginRuntime,
    auditLogger: deps.auditLogger,
    llmFetch: deps.llmFetch,
    allowedPluginIds,
    forcedActivePluginIds,
    additionalDirectories: scope?.directories ?? [],
    headless: true,
    // postTurnHookChain / idleScheduler intentionally omitted — routine loops
    // are isolated from interactive chat side effects. The fallback persistence
    // path still saves the routine session through the normal session model.
  });
}

export function createConversationLoop(deps: ConversationDeps): ConversationLoop {
  // §4.5: ConversationLoop
  return new ConversationLoop({
    settingsService: deps.settingsService,
    systemPromptBuilder: deps.systemPromptBuilder,
    keywordEngine: deps.keywordEngine,
    routeEngine: deps.routeEngine,
    toolRegistry: deps.toolRegistry,
    memoryManager: deps.memoryManager,
    permissionManager: deps.permissionManager,
    broadcastPermissionConfigChanged: deps.broadcastPermissionConfigChanged,
    routineEngine: deps.routineEngine,
    idleScheduler: deps.idleScheduler,
    postTurnHookChain: deps.postTurnHookChain,
    bashAstValidator: deps.bashAstValidator,
    approvalGate: deps.approvalGate,
    hookRunner: deps.hookRunner,
    scriptHookManager: deps.scriptHookManager,
    additionalDirectories: deps.additionalDirectories,
    getAdditionalDirectories: deps.getAdditionalDirectories,
    // Option C — request_plugin 메타 툴 pluginId 검증용.
    pluginRuntime: deps.pluginRuntime,
    skillOverlay: deps.skillOverlay,
    sessionTodoStore: deps.sessionTodoStore,
    notificationService: deps.notificationService,
    auditLogger: deps.auditLogger,
    rewireReviewerAgent: deps.rewireReviewerAgent,
    llmFetch: deps.llmFetch,
  });
}

/** Hard upper bound for callLlm maxTokens — prevents runaway cost from large plugin requests. */
const CALL_LLM_MAX_TOKENS_CEILING = 4096;

/**
 * Clamp a caller-supplied maxTokens value: accepts only positive finite integers,
 * caps at CALL_LLM_MAX_TOKENS_CEILING. Returns undefined when the input is invalid
 * so generateText falls back to its own default (400).
 */
function clampMaxTokens(raw: number | undefined): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.min(Math.floor(raw), CALL_LLM_MAX_TOKENS_CEILING);
  }
  return undefined;
}

/**
 * callLlm의 maxTokens는 플러그인이 실수로 큰 값을 넘겨 지연·비용 폭발이 나지
 * 않도록 호스트에서 sanitize: 유효한 양의 정수만 수용하고 상한(CALL_LLM_MAX_TOKENS_CEILING)
 * 으로 clamp. 유효하지 않으면 undefined로 넘겨 generateText의 기본값(400)을 사용.
 *
 * §B-7 — per-pluginId token bucket (default 20 calls / 10 min) +
 * audit event on every call. The bucket is a sliding-window counter keyed by
 * pluginId. Exceeding plugins receive a thrown Error; the audit logger still
 * records the attempt so operators can spot runaway plugins.
 */
export interface CallLlmRateLimitOptions {
  /** Per-plugin max calls inside the window. Default 20. */
  maxCalls?: number;
  /** Window size in ms. Default 10 minutes. */
  windowMs?: number;
}

export function createCallLlmForPlugin(
  conversationLoop: ConversationLoop,
  auditLogger: AuditLogger,
  options: CallLlmRateLimitOptions = {},
): (pluginId: string, prompt: string, opts?: { maxTokens?: number; systemPrompt?: string }) => Promise<string> {
  const maxCalls = options.maxCalls ?? 20;
  const windowMs = options.windowMs ?? 10 * 60 * 1000;
  const buckets = new Map<string, number[]>();

  return async (pluginId, prompt, opts) => {
    // Sliding window: drop timestamps outside the window, then count.
    const now = Date.now();
    const arr = buckets.get(pluginId) ?? [];
    const fresh = arr.filter((t) => now - t < windowMs);
    if (fresh.length >= maxCalls) {
      try {
        auditLogger.log({
          timestamp: new Date().toISOString(),
          sessionId: "plugin",
          type: "error",
          input: `[plugin:${pluginId}] callLlm rate-limit exceeded (${fresh.length}/${maxCalls} in ${windowMs}ms)`,
        });
      } catch {}
      throw new Error(
        `[plugin:${pluginId}] callLlm rate-limit exceeded — ${maxCalls} calls per ${windowMs}ms`,
      );
    }
    fresh.push(now);
    buckets.set(pluginId, fresh);

    const maxTokens = clampMaxTokens(opts?.maxTokens);

    try {
      auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: "plugin",
        type: "tool_call",
        input: `[plugin:${pluginId}] callLlm promptLen=${prompt.length} maxTokens=${maxTokens ?? "default"}`,
      });
    } catch {}

    return conversationLoop.generateText(prompt, maxTokens, opts?.systemPrompt);
  };
}

/**
 * Back-compat entry point for non-plugin callers (e.g. RoutineEngine) that
 * don't carry a pluginId. These are not rate-limited.
 */
export function createCallLlm(
  conversationLoop: ConversationLoop,
): (prompt: string, opts?: { maxTokens?: number; systemPrompt?: string }) => Promise<string> {
  return (prompt, opts) => {
    const maxTokens = clampMaxTokens(opts?.maxTokens);
    return conversationLoop.generateText(prompt, maxTokens, opts?.systemPrompt);
  };
}
