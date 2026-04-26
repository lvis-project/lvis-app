/**
 * Boot Sequence — §4.2 (thin orchestrator).
 *
 * Composes the 8-step boot pipeline from focused modules under `src/boot/`:
 *
 *   Step 0-1 + 4-5  src/boot/services.ts          core services (python,
 *                                                 ms-graph, audit, settings,
 *                                                 memory, keyword/route,
 *                                                 tool-registry, task-service)
 *   Step 3 + 5      src/boot/steps/plugin-runtime — PluginRuntime + per-plugin
 *                                                 HostApi factory + startAll
 *                                                 + manifest startupTools +
 *                                                 ToolRegistry registration +
 *                                                 dev hot-reload watcher.
 *   Step 2 + 5 + 6  src/boot/conversation.ts      system-prompt,
 *                                                 permission-manager,
 *                                                 post-turn-hook-chain,
 *                                                 approval-gate,
 *                                                 hook-runner,
 *                                                 conversation-loop,
 *                                                 callLlm builders.
 *   Step 6          src/boot/routine.ts           routine runtime +
 *                                                 calendar loaders.
 *   Step 6          src/boot/steps/routine-coordinator — trigger coordinator
 *                                                 + idle-scheduler composite.
 *   Step 4          src/boot/tools.ts             builtin tools +
 *                                                 request_plugin meta-tool +
 *                                                 knowledge/idle wiring.
 *   Step 3 + 7      src/boot/plugins.ts           manifest → notification +
 *                                                 event/tool helpers.
 *   Step 7          src/boot/steps/ipc-bridge     manifest-driven plugin →
 *                                                 renderer event forwarder
 *                                                 (with transcript coalescing).
 *   Step 8          src/boot/steps/post-boot      release prep (crash reporter,
 *                                                 telemetry, auto-updater) +
 *                                                 plugin update-check timer.
 *
 * No plugin-specific code lives here — all plugins register themselves via the
 * HostApi manufactured in `steps/plugin-runtime.ts`.
 */
import { app, powerMonitor } from "electron";
import type { BrowserWindow } from "electron";
import { adaptPowerMonitor } from "./main/idle-scheduler.js";
import { DisabledMarketplaceFetcher, PluginMarketplaceService } from "./plugins/marketplace.js";
import type { MarketplaceFetcher } from "./plugins/marketplace.js";
import { RealCloudMarketplaceFetcher } from "./plugins/real-cloud-marketplace-fetcher.js";
import { StarredStore } from "./data/starred-store.js";
import { FeedbackStore } from "./data/feedback-store.js";
import { McpGovernance } from "./mcp/mcp-governance.js";
import { McpManager } from "./mcp/mcp-manager.js";
import { openAuthWindow as openAuthWindowService } from "./main/auth-window-service.js";

import { type AppServices } from "./boot/types.js";
import { notifyBootstrapStatus } from "./boot/bootstrap-status.js";
import { bootstrapCoreServices } from "./boot/services.js";
import { registerPluginNotifications } from "./boot/plugins.js";
import {
  registerBuiltinTools,
  registerRequestPluginMetaTool,
  wireKnowledgeAndIdleScheduler,
  type WorkflowToolDeps,
} from "./boot/tools.js";
import { RemindersStore } from "./main/reminders-store.js";
import { RemindersScheduler } from "./main/reminders-scheduler.js";
import { SessionTodoStore } from "./main/session-todo-store.js";
import { AskUserQuestionGate, IPC_ASK_USER_QUESTION_REQUEST } from "./main/ask-user-question-gate.js";
import { SkillStore } from "./main/skill-store.js";
import { SkillOverlay } from "./main/skill-overlay.js";
import { SkillApprovalsStore } from "./main/skill-approvals-store.js";
import { SubAgentRunner } from "./engine/subagent-runner.js";
import type { AgentSpawnEvent } from "./tools/agent-spawn.js";
import type { SkillLoadEvent } from "./tools/skill-load.js";
import {
  createRoutineEngine,
} from "./boot/routine.js";
import {
  createSystemPromptBuilder,
  createPermissionManager,
  createPostTurnHookChain,
  createApprovalGate,
  createHookRunner,
  createConversationLoop,
  createRoutineConversationLoop,
  createTriggerConversationLoop,
  createCallLlm,
  createCallLlmForPlugin,
} from "./boot/conversation.js";
import { TriggerExecutor } from "./engine/trigger-executor.js";
import type { ConversationLoop } from "./engine/conversation-loop.js";
import { initPluginRuntime } from "./boot/steps/plugin-runtime.js";
import { registerPluginEventBridge } from "./boot/steps/ipc-bridge.js";
import { wireRoutineCoordinator } from "./boot/steps/routine-coordinator.js";
import { wireReleasePrep, wireUpdateCheck } from "./boot/steps/post-boot.js";
import { resolveManagedPluginBootstrap } from "./boot/managed-marketplace.js";

export type { AppServices } from "./boot/types.js";

/**
 * @param getMainWindow Live BrowserWindow getter — must read the current
 *   `main.ts` binding because Electron close+reopen replaces the window.
 *   Bootstrap-time consumers (e.g. plugin event bridge) take the resolved
 *   `mainWindow`; runtime consumers (e.g. TriggerExecutor) take this getter.
 *   Defaults to a closure over `mainWindow` for callers that don't have a
 *   live reference, but those callers will silently lose IPC after window
 *   recreation.
 */
export async function bootstrap(
  projectRoot: string,
  mainWindow: BrowserWindow,
  getMainWindow: () => BrowserWindow | null = () => mainWindow,
): Promise<AppServices> {
  console.log("[lvis] boot: starting...");

  // §4.2 Step 0-1 + 4-5: Core services.
  const core = await bootstrapCoreServices(mainWindow);
  const {
    pythonPath,
    bashAstValidator,
    msGraphService,
    auditService,
    settingsService,
    memoryManager,
    keywordEngine,
    toolRegistry,
    routeEngine,
    taskService,
  } = core;

  // Sprint 1-A A3 — shared AuditLogger instance (plugin runtime + hooks + gate).
  const { AuditLogger } = await import("./audit/audit-logger.js");
  const bootAuditLogger = new AuditLogger();

  // §4.2 Step 3 + 5: PluginRuntime + per-plugin HostApi factory.
  const {
    pluginRuntime,
    deploymentGuard,
    taskSourceRegistry,
    lateBinding,
    pluginPaths,
  } = await initPluginRuntime({
    projectRoot,
    settingsService,
    memoryManager,
    keywordEngine,
    toolRegistry,
    taskService,
    msGraphService,
    pythonPath,
    bootAuditLogger,
    mainWindow,
    openAuthWindowService,
  });

  // Workflow system tools (S1+S2) — services constructed up-front so the
  // tool registry can register them in one pass below. Late bindings
  // (subAgentRunner, askUserQuestionGate) hop through closures so the
  // ConversationLoop / BrowserWindow are available before the tool fires.
  const remindersStore = new RemindersStore();
  await remindersStore.load().catch((err) => {
    console.warn("[lvis] boot: reminders load failed (non-fatal):", (err as Error).message);
  });
  const remindersScheduler = new RemindersScheduler(remindersStore);
  const sessionTodoStore = new SessionTodoStore();
  const skillStore = new SkillStore();
  const skillOverlay = new SkillOverlay();
  const skillApprovalsStore = new SkillApprovalsStore();
  await skillApprovalsStore.load().catch((err) => {
    console.warn(
      "[lvis] boot: skill-approvals load failed (non-fatal):",
      (err as Error).message,
    );
  });
  const askUserQuestionGate = new AskUserQuestionGate(mainWindow.webContents);
  let subAgentRunnerRef: { fn: SubAgentRunner | undefined } = { fn: undefined };
  // Late-bound ApprovalGate ref — populated after createApprovalGate() below.
  // skill_load needs the same gate the executor uses so user-authored skills
  // pop the approval modal on first load (and only on first load).
  let approvalGateRef: { fn: import("./permissions/approval-gate.js").ApprovalGate | undefined } = { fn: undefined };
  const workflowDeps: WorkflowToolDeps = {
    remindersStore,
    sessionTodoStore,
    skillStore,
    skillOverlay,
    skillApprovalsStore,
    getAskUserQuestionGate: () => askUserQuestionGate,
    getApprovalGate: () => approvalGateRef.fn,
    getSubAgentRunner: () => subAgentRunnerRef.fn,
    emitAgentSpawn: (event: AgentSpawnEvent) => {
      try {
        getMainWindow()?.webContents.send("lvis:agent-spawn:event", event);
      } catch (err) {
        console.warn("[lvis] agent_spawn emit failed:", (err as Error).message);
      }
    },
    emitSkillLoad: (event: SkillLoadEvent) => {
      try {
        getMainWindow()?.webContents.send("lvis:skill-load:event", event);
      } catch (err) {
        console.warn("[lvis] skill_load emit failed:", (err as Error).message);
      }
    },
  };

  // §4.2 Step 4: builtin tools + request_plugin meta tool.
  registerBuiltinTools(memoryManager, toolRegistry, settingsService, taskService, workflowDeps);
  registerRequestPluginMetaTool(toolRegistry);

  // §4.4 HybridRetriever + Knowledge Tools DI, §6.1 IdleSchedulerService.
  const { idleScheduler, knowledgeAvailable } = await wireKnowledgeAndIdleScheduler({
    pluginRuntime,
    toolRegistry,
    auditService,
  });

  // §9.5 M4: marketplace backend selection.
  const marketplaceSettings = settingsService.get("marketplace");
  // Phase 2-final marketplace fetcher selection — single production path:
  //   - real-cloud + URL → RealCloudMarketplaceFetcher
  //   - otherwise (no URL configured) → DisabledMarketplaceFetcher
  // No `MockMarketplaceFetcher` fallback at boot. Dev environments default
  // to `realCloudBaseUrl: "http://localhost:8000"` (settings-store default)
  // and run the marketplace server locally; tests inject their own fetcher.
  let marketplaceFetcher: MarketplaceFetcher;
  if (marketplaceSettings.realCloudBaseUrl) {
    marketplaceFetcher = new RealCloudMarketplaceFetcher({
      baseUrl: marketplaceSettings.realCloudBaseUrl,
      apiKey: settingsService.getSecret("marketplace.apiKey") ?? undefined,
      allowPrivateNetwork: marketplaceSettings.realCloudAllowPrivateNetwork,
    });
    console.log("[lvis] boot: marketplace backend = real-cloud (%s)", marketplaceSettings.realCloudBaseUrl);
  } else {
    marketplaceFetcher = new DisabledMarketplaceFetcher();
    console.warn("[lvis] boot: marketplace backend disabled (no realCloudBaseUrl configured)");
  }
  const pluginMarketplace = new PluginMarketplaceService(
    pluginPaths,
    marketplaceFetcher,
    deploymentGuard,
  );

  // §9.5 — Managed plugin bootstrap. Mandatory enterprise plugins are fetched
  // from the marketplace on boot (VS Code-style), not packaged in app source.
  // Graceful: marketplace unreachable or per-plugin failure never bricks boot.
  const managedBootstrap = resolveManagedPluginBootstrap({
    marketplace: marketplaceSettings,
    isPackaged: app.isPackaged,
  });
  // Phase 2d: surface bootstrap status to the renderer so the user sees
  // something tangible when the marketplace is unreachable or partial-fails.
  // Three states emitted: start / complete / error.
  if (managedBootstrap.enabled) {
    notifyBootstrapStatus(mainWindow, { phase: "start" });
    try {
      const ensureResult = await pluginMarketplace.ensureManagedInstalled();
      if (ensureResult.installed.length > 0) {
        console.log(
          `[lvis] boot: managed plugin bootstrap installed ${ensureResult.installed.length}: ${ensureResult.installed.join(", ")}`,
        );
        await pluginRuntime.restartAll();
      }
      if (ensureResult.failed.length > 0) {
        console.warn(
          `[lvis] boot: managed plugin bootstrap failed ${ensureResult.failed.length}:`,
          ensureResult.failed,
        );
      }
      notifyBootstrapStatus(mainWindow, {
        phase: "complete",
        installed: ensureResult.installed,
        failed: ensureResult.failed,
      });
    } catch (err) {
      const message = (err as Error).message;
      console.warn(`[lvis] boot: ensureManagedInstalled error:`, message);
      notifyBootstrapStatus(mainWindow, { phase: "error", message });
    }
  } else {
    console.warn(`[lvis] boot: managed plugin bootstrap skipped: ${managedBootstrap.reason}`);
    notifyBootstrapStatus(mainWindow, {
      phase: "complete",
      installed: [],
      failed: [],
      skippedReason: managedBootstrap.reason,
    });
  }

  // wireUpdateCheck needs a concrete fetcher for update detection.
  const updateCheckFetcher: MarketplaceFetcher | undefined = marketplaceFetcher;

  // §4.5.9: SystemPromptBuilder.
  // C2(c): wire the skill overlay reader so each turn's system prompt
  // includes the <lvis-active-skills> section for the current session.
  const systemPromptBuilder = createSystemPromptBuilder({
    memoryManager,
    toolRegistry,
    pluginRuntime,
    getActiveSkillsSection: (sessionId) => skillOverlay.buildSection(sessionId),
  });

  // §6.3: PermissionManager (Layer 2-3).
  const permissionManager = await createPermissionManager();
  toolRegistry.setDenyRules(permissionManager.getVisibilityDenyRules());

  // §7: Routine Engine — 루틴마다 독립된 ConversationLoop를 생성하는 factory를 주입.
  // interactive 채팅의 ConversationLoop 인스턴스를 공유하면 세션 히스토리 오염 및
  // concurrent IPC 채팅 턴과의 race condition이 발생한다. factory는 stateless deps만
  // 캡처하므로 순환 의존 없이 즉시 바인딩할 수 있다.
  const routineLoopDeps = {
    settingsService,
    systemPromptBuilder,
    keywordEngine,
    routeEngine,
    toolRegistry,
    memoryManager,
    permissionManager,
    pluginRuntime,
  };
  const routineEngine = createRoutineEngine({
    createConversationLoop: () => createRoutineConversationLoop(routineLoopDeps),
    memoryManager,
  });

  // §7 Routine wiring — schedule cron timer + RoutineIdleSignaler (idle entry/exit).
  const routineCoordinator = wireRoutineCoordinator({
    routineEngine,
    taskService,
    pluginRuntime,
    settingsService,
    powerMonitor: adaptPowerMonitor(powerMonitor),
    mainWindow,
  });

  // §4.2 Step 7: manifest-driven IPC bridges.
  let disposePluginNotifications = registerPluginNotifications(pluginRuntime, mainWindow);
  let disposePluginEventBridge = registerPluginEventBridge(pluginRuntime, mainWindow);

  // §4.5 + Agent 6: PostTurnHookChain.
  const { postTurnHookChain } = createPostTurnHookChain({
    memoryManager,
    idleScheduler,
    settingsService,
    auditLogger: bootAuditLogger,
  });

  // B1 + §F7: ApprovalGate with audit.
  const approvalGate = await createApprovalGate(mainWindow, bootAuditLogger);
  approvalGateRef.fn = approvalGate;

  // Tier A4 (W3): HookRunner.
  const hookRunner = createHookRunner();

  // §4.5: ConversationLoop.
  const conversationLoop = createConversationLoop({
    settingsService,
    systemPromptBuilder,
    keywordEngine,
    routeEngine,
    toolRegistry,
    memoryManager,
    permissionManager,
    routineEngine,
    idleScheduler,
    postTurnHookChain,
    bashAstValidator,
    approvalGate,
    hookRunner,
    pluginRuntime,
    skillOverlay,
  });

  // Late-binding 주입 — ConversationLoop 생성 직후.
  lateBinding.conversationLoopRef.fn = conversationLoop;
  lateBinding.llmCallerRef.fn = createCallLlm(conversationLoop);
  lateBinding.pluginCallLlmRef.fn = createCallLlmForPlugin(conversationLoop, bootAuditLogger);
  console.log("[lvis] boot: plugin callLlm ready (rate-limited)");

  // Workflow system tools — late bindings now that ConversationLoop exists.
  // SubAgentRunner reuses the parent loop's deps (LLM, registry, gates) but
  // a fresh ConversationLoop is constructed per spawn inside the runner.
  subAgentRunnerRef.fn = new SubAgentRunner({
    parentDeps: {
      settingsService,
      systemPromptBuilder,
      keywordEngine,
      routeEngine,
      toolRegistry,
      memoryManager,
      permissionManager,
      approvalGate,
      bashAstValidator,
      hookRunner,
    },
    toolRegistry,
  });
  // C2(c): skill_load no longer mutates conversation history. The body is
  // registered into SkillOverlay (per-session) and read each turn by
  // SystemPromptBuilder via getActiveSkillsSection. See main/skill-overlay.ts
  // for the registry; src/tools/skill-load.ts for the tool entry point.

  // Reminders scheduler — fires `lvis:reminder:fired` per due reminder. The
  // renderer's RemindersList subscribes to this channel and shows a toast.
  remindersScheduler.onFired(({ reminder }) => {
    try {
      getMainWindow()?.webContents.send("lvis:reminder:fired", reminder);
    } catch (err) {
      console.warn("[lvis] reminder fired emit failed:", (err as Error).message);
    }
  });
  // L1: NOT started here. Boot order matters — if scheduler.start() runs
  // before the renderer has its IPC listeners attached, a past-due
  // reminder fires immediately into a void. main.ts now invokes
  // `services.startRemindersScheduler()` AFTER `registerIpcHandlers()` to
  // close that gap.

  // Trigger executor — spawns a fresh ConversationLoop per
  // hostApi.triggerConversation() call so the user's chat history is never
  // polluted by templated proactive turns. See trigger-executor.ts.
  lateBinding.triggerExecutorRef.fn = new TriggerExecutor({
    createLoop: () =>
      createTriggerConversationLoop({
        settingsService,
        systemPromptBuilder,
        keywordEngine,
        routeEngine,
        toolRegistry,
        memoryManager,
        permissionManager,
        approvalGate,
        bashAstValidator,
        pluginRuntime,
      }),
    // Live getter so close+reopen window cycles still deliver trigger events.
    getMainWindow,
    auditLogger: bootAuditLogger,
  });
  console.log("[lvis] boot: trigger executor wired (proactive turns isolated)");

  // §9.5: MCP Server 연결.
  const mcpGovernance = new McpGovernance();
  const mcpManager = new McpManager(mcpGovernance, toolRegistry, undefined, permissionManager, bootAuditLogger);
  try {
    const configs = await mcpManager.loadFromConfig();
    if (configs.length > 0) {
      await mcpManager.connectAll();
      console.log("[lvis] boot: MCP servers connected");
    }
  } catch (err) {
    console.warn("[lvis] boot: MCP initialization failed (non-fatal):", (err as Error).message);
  }
  mcpGovernance.startPolicyRefresh((revokedIds) => {
    for (const serverId of revokedIds) {
      void mcpManager.killSwitch(serverId).catch((err) => {
        console.error("[lvis] boot: revoked MCP server kill failed:", serverId, (err as Error).message);
      });
    }
  });

  console.log("[lvis] boot: ready (%d tools, %d plugins, %d mcp)", toolRegistry.size, pluginRuntime.listPluginIds().length, mcpManager.listServers().filter(s => s.status === "connected").length);

  // Sprint 4.C — starred store + D6 feedback store.
  const starredStore = new StarredStore();
  const feedbackStore = new FeedbackStore();

  // §4.2 Step 8: Post-boot — release prep (telemetry/crash/updater) + plugin update-check.
  const { telemetry, pluginTelemetry, autoUpdaterStop } = wireReleasePrep({
    mainWindow,
    settingsService,
    bootAuditLogger,
  });
  if (updateCheckFetcher) {
    wireUpdateCheck({
      mainWindow,
      settingsService,
      marketplaceFetcher: updateCheckFetcher,
      pluginPaths,
    });
  }

  // void unused imports avoidance — app reference retained for type imports.
  void app;
  let shutdownPromise: Promise<void> | null = null;

  return {
    pluginRuntime, pluginMarketplace, taskService, taskSourceRegistry, settingsService,
    memoryManager, keywordEngine, routeEngine, toolRegistry,
    systemPromptBuilder, conversationLoop, routineEngine, mcpManager,
    triggerExecutor: lateBinding.triggerExecutorRef.fn ?? undefined,
    idleScheduler, bashAstValidator, auditService, auditLogger: bootAuditLogger, msGraphService, postTurnHookChain,
    approvalGate, knowledgeAvailable, starredStore, feedbackStore,
    remindersStore, remindersScheduler, sessionTodoStore, askUserQuestionGate, skillStore,
    telemetry, pluginTelemetry, autoUpdaterStop,
    startRemindersScheduler: () => remindersScheduler.start(),
    refreshPluginNotifications: () => {
      disposePluginNotifications();
      disposePluginNotifications = registerPluginNotifications(pluginRuntime, mainWindow);
      disposePluginEventBridge();
      disposePluginEventBridge = registerPluginEventBridge(pluginRuntime, mainWindow);
    },
    registerPluginEventBridge: (win) => registerPluginEventBridge(pluginRuntime, win),
    shutdown: () => {
      if (shutdownPromise) return shutdownPromise;
      shutdownPromise = (async () => {
        disposePluginNotifications();
        disposePluginEventBridge();
        routineCoordinator.dispose();
        autoUpdaterStop?.();
        telemetry?.stop();
        pluginTelemetry?.stop();
        idleScheduler?.stop();
        remindersScheduler.stop();
        askUserQuestionGate.disposeAll();
        mcpGovernance.stopPolicyRefresh();
        await mcpManager.disconnectAll();
        await auditService.stop();
        taskService.close();
      })();
      return shutdownPromise;
    },
  };
}
