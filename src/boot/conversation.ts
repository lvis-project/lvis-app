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
import type { SkillCatalogEntry } from "../main/skill-store.js";
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
import { isDefaultWorkspaceRoot } from "../main/default-workspace-root.js";
import {
  defaultWorkspaceProject,
  resolveAuthorizedWorkspaceProject,
} from "../main/project-root-authorization.js";

function authorizeWorkspaceProjectRoot(projectRoot: string, projectName?: string) {
  const resolved = resolveAuthorizedWorkspaceProject(projectRoot, projectName);
  return resolved.authorized ? resolved.project : null;
}

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
   * C2(c): current-turn SkillOverlay reader. The builder calls this each
   * round with the active session id and folds the returned section into
   * the system prompt. Optional so unit tests can stub the builder
   * without touching the overlay.
   */
  getActiveSkillsSection?: (sessionId: string) => string;
  getAvailableSkills?: () => SkillCatalogEntry[];
  /**
   * Session-scoped on-demand activation allow-list — see
   * {@link SystemPromptBuilderDeps.getActivatablePluginIds}. Routine sessions
   * pass their `allowedPluginIds` so an allow-listed-but-disabled plugin shows
   * as requestable; main chat omits it.
   */
  getActivatablePluginIds?: () => ReadonlySet<string>;
}): SystemPromptBuilder {
  const { memoryManager, toolRegistry, pluginRuntime, getActiveSkillsSection, getAvailableSkills, getActivatablePluginIds } = opts;
  return new SystemPromptBuilder({
    memoryManager,
    toolRegistry,

    getPluginCards: () => pluginRuntime.listPluginCards(toolRegistry),
    getActivatablePluginIds,
    getAvailableSkills,
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

  permissionManager.setRules([
    { pattern: "skill_list", action: "allow" },
    { pattern: "agent_list", action: "allow" },
    { pattern: "web_search", action: "allow" },
    { pattern: "web_fetch", action: "allow" },
  ]);

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
  /**
   * Same SessionTodoStore instance the conversation loop holds — the hook
   * marks a completed plan here and the loop's `clearIfPending` executes it at
   * the next turn boundary.
   */
  sessionTodoStore?: SessionTodoStore;
}): { postTurnHookChain: PostTurnHookChain; auditLogger: AuditLogger } {

  const auditLogger = opts.auditLogger ?? new AuditLogger();
  const postTurnHookChain = new PostTurnHookChain({
    memoryManager: opts.memoryManager,
    auditLogger,
    idleScheduler: opts.idleScheduler,
    settingsService: opts.settingsService,
    sessionTodoStore: opts.sessionTodoStore,
  });
  return { postTurnHookChain, auditLogger };
}

export async function createApprovalGate(
  mainWindow: BrowserWindow,
  auditLogger: AuditLogger,
  notificationService?: NotificationService,
): Promise<ApprovalGate> {


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
  // Permission policy single hook path: production external hooks are loaded by
  // wireHookSystem() from BOTH discrete pre/post/perm-*.sh files AND a
  // declarative ~/.config/lvis/hooks/hooks.json — but every one of them flows
  // through the SAME TOFU quarantine/accept gate (#811). A new or changed
  // hooks.json is quarantined to .disabled/ and its command entries NEVER run
  // until the user runs `/permission hooks accept hooks.json`; only a trusted,
  // unchanged config contributes runnable commands. The in-process HookRunner
  // returned here is for internal/test hooks only and has no external surface.
  return new HookRunner();
}

export interface ConversationDeps {
  settingsService: SettingsService;
  systemPromptBuilder: SystemPromptBuilder;
  keywordEngine: KeywordEngine;
  routeEngine: RouteEngine;
  toolRegistry: ToolRegistry;
  /** Host-owned capability; defaults false when omitted. */
  supportsA2AParentDelivery?: boolean;
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
  isDefaultProjectRoot?: (projectRoot: string) => boolean;
  getDefaultProject?: () => { projectRoot?: string; projectName?: string; isDefault?: boolean };
  authorizeProject?: (
    projectRoot: string,
    projectName?: string,
  ) => { projectRoot: string; projectName?: string; isDefault?: boolean } | null;
  /**
   * Fan-out hook for permission config mutations. Boot wires this from
   * `ipc/domains/permissions.ts:broadcastPermissionConfigChanged` so the
   * conversation loop's `addSessionAdditionalDirectory` (dialog-driven
   * session grants) reaches multi-window PermissionsTab subscribers,
   * not only slash-dispatch grants.
   */
  broadcastPermissionConfigChanged?: () => void;
  /** C2(c): current-turn SkillOverlay handle, cleared on newConversation(). */
  skillOverlay?: { clear(sessionId: string): void };
  /**
   * Session-scoped assistant TO-DO lifecycle. Required: the interactive loop
   * must run the next-turn `clearIfPending`. A missing wire silently disables
   * completed-plan clearing — the post-turn hook would keep marking sessions
   * that nothing consumes. Routine loops use a separate factory and never
   * carry this store.
   */
  sessionTodoStore: SessionTodoStore;
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
  | "isDefaultProjectRoot"
  | "getDefaultProject"
  | "authorizeProject"
>;

export function createRoutineConversationLoop(
  deps: RoutineConversationLoopDeps,
  opts: { scope?: import("../shared/routines-types.js").RoutineScope } = {},
): ConversationLoop {
  // Permission policy Layer 4 — translate the discriminated scope into the loop's
  // ConversationLoopDeps shape. The scope must already be normalized
  // (no `inherit`) by the dispatcher before this factory runs. Computed BEFORE
  // the prompt builder so the allow-list can be threaded into the requestable
  // catalog predicate (session-scoped on-demand activation of disabled plugins).
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
  // Layer 1 (UX hot-fix v3): each routine fire gets its *own* SystemPromptBuilder
  // instance with routineMode=true so the LLM is instructed to append a
  // <summary>…</summary> tag. A dedicated instance (not the shared main-chat
  // builder) is used to prevent routineMode from leaking into main-chat turns
  // even when concurrent routine fires and user chat turns overlap.
  const routineSystemPromptBuilder = createSystemPromptBuilder({
    memoryManager: deps.memoryManager,
    toolRegistry: deps.toolRegistry,
    pluginRuntime: deps.pluginRuntime,
    // Session-scoped on-demand activation — surface allow-listed-but-disabled
    // plugins in the requestable catalog so the routine LLM can request_plugin
    // them. The session activates them non-persistently (registry stays
    // enabled:false); main chat never sets this.
    getActivatablePluginIds: () => allowedPluginIds,
    // Skill overlay is interactive-only — routine sessions are headless.
  });
  routineSystemPromptBuilder.setRoutineMode(true);
  const forcedActivePluginIds = new Set(scope?.forcedPluginIds ?? []);
  const forcedActiveToolNames = new Set(
    deps.toolRegistry
      .listAll()
      .filter((tool) => tool.source === "plugin" && tool.pluginId && forcedActivePluginIds.has(tool.pluginId))
      .map((tool) => tool.name),
  );
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
    isDefaultProjectRoot: deps.isDefaultProjectRoot ?? isDefaultWorkspaceRoot,
    getDefaultProject: deps.getDefaultProject ?? defaultWorkspaceProject,
    authorizeProject: deps.authorizeProject ?? authorizeWorkspaceProjectRoot,
    allowedPluginIds,
    forcedActivePluginIds,
    ...(forcedActiveToolNames.size > 0 ? { forcedActiveToolNames } : {}),
    additionalDirectories: scope?.directories ?? [],
    headless: true,
    // postTurnHookChain / idleScheduler intentionally omitted — routine loops
    // are isolated from interactive chat side effects. The fallback persistence
    // path still saves the routine session through the normal session model.
  });
}

/**
 * Side-chat ConversationLoop factory (workspace-rail side chat).
 *
 * Like the routine factory, this returns a SECOND ConversationLoop that is fully
 * isolated from the interactive main chat — it owns its own ConversationHistory,
 * sessionId, and (crucially) its own {@link MemoryManager} rooted at
 * `~/.lvis/side-chat/` (`sideChatMemoryManager`) so side-chat sessions never
 * appear in the main chat's session list and can be cleared as a single domain
 * (project CLAUDE.md storage-namespace rule).
 *
 * UNLIKE routine loops, side chat is INTERACTIVE and PERSISTENT:
 *   - `headless: false` — it streams to the renderer through the dedicated
 *     `CHANNELS.sidechat.*` sink (see `domains/sidechat.ts`).
 *   - a dedicated PostTurnHookChain persists each turn to the side-chat store.
 *   - a dedicated (non-routine) SystemPromptBuilder — routineMode stays false.
 *
 * Model + permissions are INHERITED from the main chat by sharing the same
 * stateless deps (`settingsService` → same vendor/model; `permissionManager` +
 * `approvalGate` → same rules + approval modal). Side chat is NOT scope-isolated
 * (no allow-list): it runs with the full active plugin/tool set, exactly like
 * the main chat.
 */
export type SideChatConversationLoopDeps = Pick<
  ConversationDeps,
  | "settingsService"
  | "keywordEngine"
  | "routeEngine"
  | "toolRegistry"
  | "permissionManager"
  | "approvalGate"
  | "hookRunner"
  | "scriptHookManager"
  | "bashAstValidator"
  | "pluginRuntime"
  | "llmFetch"
  | "auditLogger"
> & {
  /** Isolated MemoryManager rooted at `~/.lvis/side-chat/`. */
  sideChatMemoryManager: MemoryManager;
  /** Shared settings service — reads `additionalDirectories` at each turn. */
  getAdditionalDirectories?: () => readonly string[];
  isDefaultProjectRoot?: (projectRoot: string) => boolean;
  getDefaultProject?: () => { projectRoot?: string; projectName?: string; isDefault?: boolean };
  authorizeProject?: (
    projectRoot: string,
    projectName?: string,
  ) => { projectRoot: string; projectName?: string; isDefault?: boolean } | null;
};

export function createSideChatConversationLoop(
  deps: SideChatConversationLoopDeps,
): ConversationLoop {
  // Dedicated SystemPromptBuilder bound to the side-chat MemoryManager so its
  // memory/AGENTS.md context comes from the side-chat namespace, not the main
  // one. routineMode stays false (default) — side chat is a normal interactive
  // session, not a summarizing routine.
  const sideChatSystemPromptBuilder = createSystemPromptBuilder({
    memoryManager: deps.sideChatMemoryManager,
    toolRegistry: deps.toolRegistry,
    pluginRuntime: deps.pluginRuntime,
  });
  // Dedicated post-turn hook chain — persists each side-chat turn to the
  // isolated store. No idleScheduler (side chat does not drive idle refresh).
  const { postTurnHookChain } = createPostTurnHookChain({
    memoryManager: deps.sideChatMemoryManager,
    settingsService: deps.settingsService,
    ...(deps.auditLogger ? { auditLogger: deps.auditLogger } : {}),
  });
  return new ConversationLoop({
    settingsService: deps.settingsService,
    systemPromptBuilder: sideChatSystemPromptBuilder,
    keywordEngine: deps.keywordEngine,
    routeEngine: deps.routeEngine,
    toolRegistry: deps.toolRegistry,
    memoryManager: deps.sideChatMemoryManager,
    permissionManager: deps.permissionManager,
    approvalGate: deps.approvalGate,
    hookRunner: deps.hookRunner,
    scriptHookManager: deps.scriptHookManager,
    bashAstValidator: deps.bashAstValidator,
    pluginRuntime: deps.pluginRuntime,
    postTurnHookChain,
    auditLogger: deps.auditLogger,
    llmFetch: deps.llmFetch,
    isDefaultProjectRoot: deps.isDefaultProjectRoot ?? isDefaultWorkspaceRoot,
    getDefaultProject: deps.getDefaultProject ?? defaultWorkspaceProject,
    authorizeProject: deps.authorizeProject ?? authorizeWorkspaceProjectRoot,
    ...(deps.getAdditionalDirectories
      ? { getAdditionalDirectories: deps.getAdditionalDirectories }
      : {}),
    // headless defaults to false — interactive, streaming loop.
  });
}

export function createConversationLoop(deps: ConversationDeps): ConversationLoop {
  // §4.5: ConversationLoop
  const loop = new ConversationLoop({
    settingsService: deps.settingsService,
    systemPromptBuilder: deps.systemPromptBuilder,
    keywordEngine: deps.keywordEngine,
    routeEngine: deps.routeEngine,
    toolRegistry: deps.toolRegistry,
    supportsA2AParentDelivery: deps.supportsA2AParentDelivery === true,
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
    isDefaultProjectRoot: deps.isDefaultProjectRoot ?? isDefaultWorkspaceRoot,
    getDefaultProject: deps.getDefaultProject ?? defaultWorkspaceProject,
    authorizeProject: deps.authorizeProject ?? authorizeWorkspaceProjectRoot,

    pluginRuntime: deps.pluginRuntime,
    skillOverlay: deps.skillOverlay,
    sessionTodoStore: deps.sessionTodoStore,
    notificationService: deps.notificationService,
    auditLogger: deps.auditLogger,
    rewireReviewerAgent: deps.rewireReviewerAgent,
    llmFetch: deps.llmFetch,
  });
  loop.newConversation("main");
  return loop;
}

/**
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
): (pluginId: string, prompt: string, opts?: { maxTokens?: number; systemPrompt?: string; signal?: AbortSignal }) => Promise<string> {
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

    try {
      auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: "plugin",
        type: "tool_call",
        input: `[plugin:${pluginId}] callLlm promptLen=${prompt.length}`,
      });
    } catch {}

    return conversationLoop.generateText(prompt, opts?.systemPrompt, opts?.signal);
  };
}

/**
 * Back-compat entry point for non-plugin callers (e.g. RoutineEngine) that
 * don't carry a pluginId. These are not rate-limited.
 */
export function createCallLlm(
  conversationLoop: ConversationLoop,
): (prompt: string, opts?: { maxTokens?: number; systemPrompt?: string; signal?: AbortSignal }) => Promise<string> {
  return (prompt, opts) => {
    return conversationLoop.generateText(prompt, opts?.systemPrompt, opts?.signal);
  };
}
