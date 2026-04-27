/**
 * Boot §4.2 Step 7 — ConversationLoop + dependencies (hooks, approval gate,
 * permission manager, PostTurnHookChain, callLlm sanitiser).
 */
import type { BrowserWindow } from "electron";
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
import { ConversationLoop } from "../engine/conversation-loop.js";
import { PostTurnHookChain } from "../hooks/post-turn-hook-chain.js";
import { HookRunner } from "../hooks/hook-runner.js";
import { loadHooksConfig } from "../hooks/config-loader.js";
import { ExternalHookExecutor } from "../hooks/external-executor.js";
import { AuditLogger } from "../audit/audit-logger.js";
import type { NotificationService } from "../main/notification-service.js";

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
    // Phase 1.5 Option C — 비활성 plugin 카탈로그 공급.
    getPluginCards: () => pluginRuntime.listPluginCards(toolRegistry),
    getActiveSkillsSection,
  });
}

export async function createPermissionManager(): Promise<PermissionManager> {
  // §6.3: PermissionManager (Layer 2-3)
  const permissionManager = new PermissionManager();
  // 기본 allow 규칙: 조회성 도구 자동 허용
  permissionManager.setRules([
    { pattern: "memory_search", action: "allow" },
    { pattern: "memory_list", action: "allow" },
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
   * Sprint 1-A A3 — shared AuditLogger. When provided, PostTurnHookChain
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
  // Tier A4 (W3): load hooks config from admin-dir + ~/.lvis/hooks.json and
  // attach an ExternalHookExecutor to the HookRunner so every preToolUse /
  // postToolUse event routes through it. Host owns the runner lifecycle so
  // external hooks fire inside the ToolExecutor's 8-step pipeline.
  const hookRunner = new HookRunner();
  try {
    const hooksConfig = loadHooksConfig();
    const externalHookExecutor = new ExternalHookExecutor(hooksConfig, process.cwd());
    hookRunner.setExternalExecutor(externalHookExecutor);
    const preCount = hooksConfig.preToolUse.length;
    const postCount = hooksConfig.postToolUse.length;
    console.log(
      "[lvis] boot: external hook executor attached (pre=%d, post=%d)",
      preCount,
      postCount,
    );
  } catch (err) {
    console.warn(
      "[lvis] boot: external hook executor setup failed (non-fatal):",
      (err as Error).message,
    );
  }
  return hookRunner;
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
  pluginRuntime: PluginRuntime;
  /** C2(c): per-session SkillOverlay handle, cleared on newConversation(). */
  skillOverlay?: { clear(sessionId: string): void };
  /** Issue #260: optional notification service for turn-end auto-fire. */
  notificationService?: NotificationService;
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
 * routine turns never appear in the user's chat transcript. The heavier
 * interactive-only deps (postTurnHookChain, approvalGate, hookRunner,
 * idleScheduler, bashAstValidator) are intentionally omitted — routines run
 * headlessly and do not need approval modals or idle-poke side-effects.
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
  | "pluginRuntime"
>;

export function createRoutineConversationLoop(deps: RoutineConversationLoopDeps): ConversationLoop {
  return new ConversationLoop({
    settingsService: deps.settingsService,
    systemPromptBuilder: deps.systemPromptBuilder,
    keywordEngine: deps.keywordEngine,
    routeEngine: deps.routeEngine,
    toolRegistry: deps.toolRegistry,
    memoryManager: deps.memoryManager,
    permissionManager: deps.permissionManager,
    pluginRuntime: deps.pluginRuntime,
    // postTurnHookChain / approvalGate / hookRunner / idleScheduler / bashAstValidator
    // intentionally omitted — routine loops are headless and isolated.
  });
}

/**
 * Trigger-isolated ConversationLoop factory.
 *
 * Proactive triggers (`hostApi.triggerConversation()`) must NOT execute on
 * the interactive chat's loop — doing so pushes templated proactive turns
 * into the user's session history and pollutes the LLM context for the
 * user's next direct message. We mirror the routine isolation pattern:
 * fresh ConversationLoop per trigger, own ConversationHistory, own
 * sessionId.
 *
 * Where this differs from {@link createRoutineConversationLoop}:
 *   - keeps `approvalGate` — destructive ops (mail send, calendar write)
 *     must still surface a user-confirmation modal even when the turn was
 *     started by a brain plugin; proactive autonomy ≠ permission grant.
 *   - keeps `bashAstValidator` — the LLM may legitimately call bash tools
 *     and the validator gate must still run.
 *   - `permissionManager` retained (source-aware policies on `proactive:*`
 *     origins are the eventual P-next deliverable; the slot must be live).
 *   - `postTurnHookChain` / `hookRunner` / `idleScheduler` omitted — those
 *     mutate the user's chat session/history; trigger loops are headless.
 */
export type TriggerConversationLoopDeps = Pick<
  ConversationDeps,
  | "settingsService"
  | "systemPromptBuilder"
  | "keywordEngine"
  | "routeEngine"
  | "toolRegistry"
  | "memoryManager"
  | "permissionManager"
  | "approvalGate"
  | "bashAstValidator"
  | "pluginRuntime"
>;

export function createTriggerConversationLoop(
  deps: TriggerConversationLoopDeps,
): ConversationLoop {
  return new ConversationLoop({
    settingsService: deps.settingsService,
    systemPromptBuilder: deps.systemPromptBuilder,
    keywordEngine: deps.keywordEngine,
    routeEngine: deps.routeEngine,
    toolRegistry: deps.toolRegistry,
    memoryManager: deps.memoryManager,
    permissionManager: deps.permissionManager,
    approvalGate: deps.approvalGate,
    bashAstValidator: deps.bashAstValidator,
    pluginRuntime: deps.pluginRuntime,
    // postTurnHookChain / hookRunner / idleScheduler intentionally omitted.
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
    routineEngine: deps.routineEngine,
    idleScheduler: deps.idleScheduler,
    postTurnHookChain: deps.postTurnHookChain,
    bashAstValidator: deps.bashAstValidator,
    approvalGate: deps.approvalGate,
    hookRunner: deps.hookRunner,
    // Phase 1.5 Option C — request_plugin 메타 툴 pluginId 검증용.
    pluginRuntime: deps.pluginRuntime,
    skillOverlay: deps.skillOverlay,
    notificationService: deps.notificationService,
  });
}

/**
 * callLlm의 maxTokens는 플러그인이 실수로 큰 값을 넘겨 지연·비용 폭발이 나지
 * 않도록 호스트에서 sanitize: 유효한 양의 정수만 수용하고 상한(CALL_LLM_MAX_TOKENS_CEILING)
 * 으로 clamp. 유효하지 않으면 undefined로 넘겨 generateText의 기본값(400)을 사용.
 *
 * Sprint 4-B §B-7 — per-pluginId token bucket (default 20 calls / 10 min) +
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
  const CALL_LLM_MAX_TOKENS_CEILING = 4096;
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

    let maxTokens: number | undefined;
    const raw = opts?.maxTokens;
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
      maxTokens = Math.min(Math.floor(raw), CALL_LLM_MAX_TOKENS_CEILING);
    }

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
  const CALL_LLM_MAX_TOKENS_CEILING = 4096;
  return (prompt, opts) => {
    let maxTokens: number | undefined;
    const raw = opts?.maxTokens;
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
      maxTokens = Math.min(Math.floor(raw), CALL_LLM_MAX_TOKENS_CEILING);
    }
    return conversationLoop.generateText(prompt, maxTokens, opts?.systemPrompt);
  };
}
