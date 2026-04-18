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
import type { ProactiveEngine } from "../core/proactive-engine.js";
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

export function createSystemPromptBuilder(opts: {
  memoryManager: MemoryManager;
  toolRegistry: ToolRegistry;
  pluginRuntime: PluginRuntime;
}): SystemPromptBuilder {
  const { memoryManager, toolRegistry, pluginRuntime } = opts;
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
): Promise<ApprovalGate> {
  // B1: Policy 로드 후 ApprovalGate 생성 — mainWindow.webContents 준비 후
  // §F7: bootAuditLogger 주입 → requested/decided/timeout/send-failed 4 phase 감사
  const bootPolicy = await loadPolicy();
  return new ApprovalGate(mainWindow.webContents, bootPolicy, 5 * 60 * 1000, auditLogger);
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
  proactiveEngine: ProactiveEngine;
  idleScheduler?: IdleSchedulerService;
  postTurnHookChain: PostTurnHookChain;
  bashAstValidator: BashAstValidator;
  approvalGate: ApprovalGate;
  hookRunner: HookRunner;
  pluginRuntime: PluginRuntime;
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
    proactiveEngine: deps.proactiveEngine,
    idleScheduler: deps.idleScheduler,
    postTurnHookChain: deps.postTurnHookChain,
    bashAstValidator: deps.bashAstValidator,
    approvalGate: deps.approvalGate,
    hookRunner: deps.hookRunner,
    // Phase 1.5 Option C — request_plugin 메타 툴 pluginId 검증용.
    pluginRuntime: deps.pluginRuntime,
  });
}

/**
 * callLlm의 maxTokens는 플러그인이 실수로 큰 값을 넘겨 지연·비용 폭발이 나지
 * 않도록 호스트에서 sanitize: 유효한 양의 정수만 수용하고 상한(CALL_LLM_MAX_TOKENS_CEILING)
 * 으로 clamp. 유효하지 않으면 undefined로 넘겨 generateText의 기본값(400)을 사용.
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
