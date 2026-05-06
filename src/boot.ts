/**
 * Boot Sequence — §4.2 (thin orchestrator).
 *
 * Composes the 8-step boot pipeline from focused modules under `src/boot/`:
 *
 *   Step 0-1 + 4-5  src/boot/services.ts          core services (python,
 *                                                 ms-graph, audit, settings,
 *                                                 memory, keyword/route,
 *                                                 tool-registry)
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
import { resolve } from "node:path";
import { homedir } from "node:os";
import { adaptPowerMonitor } from "./main/idle-scheduler.js";
import { DisabledMarketplaceFetcher, PluginMarketplaceService } from "./plugins/marketplace.js";
import type { MarketplaceFetcher } from "./plugins/marketplace.js";
import { RealCloudMarketplaceFetcher } from "./plugins/real-cloud-marketplace-fetcher.js";
import { PluginArtifactStore } from "./plugins/plugin-artifact-store.js";
import { getBundledPublicKeys } from "./plugins/publisher-keys.js";
import { StarredStore } from "./data/starred-store.js";
import { FeedbackStore } from "./data/feedback-store.js";
import { McpGovernance } from "./mcp/mcp-governance.js";
import { McpManager } from "./mcp/mcp-manager.js";
import { openAuthWindow as openAuthWindowService } from "./main/auth-window-service.js";
import { openLinkWindow as openLinkWindowService } from "./main/link-window-service.js";
import { shell } from "electron";

import { type AppServices, emitEvent, onEvent } from "./boot/types.js";
import { startWatcherTelemetryCollector } from "./boot/steps/watcher-telemetry-collector.js";
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
import { NotificationService } from "./main/notification-service.js";
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
import { runManagedBootstrap } from "./boot/managed-marketplace.js";
import { createLogger } from "./lib/logger.js";
const log = createLogger("lvis");

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
  log.info("boot: starting...");

  // §4.2 Step 0-1 + 4-5: Core services.
  const core = await bootstrapCoreServices(mainWindow);
  const {
    pythonPath,
    pythonRuntime,
    bashAstValidator,
    auditService,
    settingsService,
    memoryManager,
    keywordEngine,
    toolRegistry,
    routeEngine,
  } = core;

  // Sprint 1-A A3 — shared AuditLogger instance (plugin runtime + hooks + gate).
  const { AuditLogger } = await import("./audit/audit-logger.js");
  const bootAuditLogger = new AuditLogger();

  // Issue #260 — system notification service. Constructed up-front so all
  // 4 trigger sites (turn-end, routine, ask-user, approval) can call .fire().
  // Live mainWindow getter avoids a stale handle after Electron close+reopen.
  const notificationService = new NotificationService({
    getMainWindow,
    auditLogger: bootAuditLogger,
  });
  // Safety net: NotificationService is always constructed at this point.
  // If it's somehow undefined, that indicates a boot-order regression
  // (e.g. a refactor that moved the construction after a conditional branch).
  // Throw early with a clear message so the regression is caught immediately
  // rather than silently no-oping on every notification fire.
  if (!notificationService) {
    throw new Error("NotificationService failed to initialize — boot order regression");
  }
  // Routine delivery sites pass `notificationService` explicitly per-call so
  // there's no module-level singleton to reset between tests/processes.

  // B1 + §F7: ApprovalGate with audit. Constructed BEFORE initPluginRuntime so
  // the per-plugin HostApi factory can wire `agentApproval` namespace to the
  // live gate — without this ordering, plugins receive a hostApi missing the
  // namespace and §8 main-process approval routing silently no-ops.
  const approvalGate = await createApprovalGate(mainWindow, bootAuditLogger, notificationService);

  // §4.2 Step 3 + 5: PluginRuntime + per-plugin HostApi factory.
  const {
    pluginRuntime,
    deploymentGuard,
    lateBinding,
    pluginPaths,
  } = await initPluginRuntime({
    projectRoot,
    settingsService,
    memoryManager,
    keywordEngine,
    toolRegistry,
    pythonPath,
    bootAuditLogger,
    mainWindow,
    openAuthWindowService,
    openLinkWindowService,
    shellOpenExternal: (url: string) => shell.openExternal(url),
    approvalGate,
  });

  // Workflow system tools (S1+S2) — services constructed up-front so the
  // tool registry can register them in one pass below. Late bindings
  // (subAgentRunner, askUserQuestionGate) hop through closures so the
  // ConversationLoop / BrowserWindow are available before the tool fires.
  const remindersStore = new RemindersStore();
  await remindersStore.load().catch((err) => {
    log.warn("boot: reminders load failed (non-fatal): %s", (err as Error).message);
  });
  const remindersScheduler = new RemindersScheduler(remindersStore);
  const sessionTodoStore = new SessionTodoStore();
  const skillStore = new SkillStore();
  const skillOverlay = new SkillOverlay();
  const skillApprovalsStore = new SkillApprovalsStore();
  await skillApprovalsStore.load().catch((err) => {
    log.warn(
      "boot: skill-approvals load failed (non-fatal): %s",
      (err as Error).message,
    );
  });
  const askUserQuestionGate = new AskUserQuestionGate(
    // Lazy resolver — dev-mode reloads destroy the captured webContents.
    // Looking it up on every send keeps the gate working across reloads
    // and across window recreation.
    () => getMainWindow()?.webContents ?? null,
    undefined,
    notificationService,
  );
  let subAgentRunnerRef: { fn: SubAgentRunner | undefined } = { fn: undefined };
  // ApprovalGate ref — gate is constructed up-front (before initPluginRuntime)
  // so this is bound immediately. skill_load reuses the same gate the
  // executor uses so user-authored skills pop the approval modal on first
  // load (and only on first load).
  let approvalGateRef: { fn: import("./permissions/approval-gate.js").ApprovalGate | undefined } = { fn: approvalGate };
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
        log.warn("agent_spawn emit failed: %s", (err as Error).message);
      }
    },
    emitSkillLoad: (event: SkillLoadEvent) => {
      try {
        getMainWindow()?.webContents.send("lvis:skill-load:event", event);
      } catch (err) {
        log.warn("skill_load emit failed: %s", (err as Error).message);
      }
    },
  };

  // §4.2 Step 4: builtin tools + request_plugin meta tool.
  registerBuiltinTools(memoryManager, toolRegistry, settingsService, workflowDeps);
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
  // No `MockMarketplaceFetcher` fallback at boot. Default points at the
  // production tunnel (`https://marketplace.lvisai.xyz`); dev operators
  // running the marketplace server locally override via the settings UI.
  // Tests inject their own fetcher.
  let marketplaceFetcher: MarketplaceFetcher;
  if (marketplaceSettings.realCloudBaseUrl) {
    marketplaceFetcher = new RealCloudMarketplaceFetcher({
      baseUrl: marketplaceSettings.realCloudBaseUrl,
      apiKey: settingsService.getSecret("marketplace.apiKey") ?? undefined,
      allowPrivateNetwork: marketplaceSettings.realCloudAllowPrivateNetwork,
    });
    log.info("boot: marketplace backend = real-cloud (%s)", marketplaceSettings.realCloudBaseUrl);
  } else {
    marketplaceFetcher = new DisabledMarketplaceFetcher();
    log.warn("boot: marketplace backend disabled (no realCloudBaseUrl configured)");
  }
  const pluginMarketplace = new PluginMarketplaceService(
    pluginPaths,
    marketplaceFetcher,
    deploymentGuard,
  );

  // §9.5 — Managed plugin bootstrap. Mandatory enterprise plugins are fetched
  // from the marketplace on boot (VS Code-style), not packaged in app source.
  // Graceful: marketplace unreachable or per-plugin failure never bricks boot.
  // Phase 2d surfaces lifecycle status (start/complete/error) to the renderer
  // so the user sees something when the marketplace is unreachable or
  // partial-fails. The same helper backs the `lvis:bootstrap:retry` IPC.
  await runManagedBootstrap({
    pluginMarketplace,
    pluginRuntime,
    mainWindow,
    marketplace: marketplaceSettings,
    isPackaged: app.isPackaged,
  });

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
  // Initialize the safety flag from persisted settings so the first turn
  // respects whatever the user last saved (default false on fresh installs).
  systemPromptBuilder.setContinuousBackendEnabled(
    settingsService.get("features")?.experimentalContinuousBackend ?? false,
  );

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
  // Note: routine notification firing lives inside deliverRoutineResult so all
  // 3 delivery paths (coordinator / IPC dev-trigger / shutdown) participate.
  // notificationService is passed in explicitly so each delivery site forwards
  // it via deliverRoutineResult(... { notificationService }).
  const routineCoordinator = wireRoutineCoordinator({
    routineEngine,
    pluginRuntime,
    settingsService,
    powerMonitor: adaptPowerMonitor(powerMonitor),
    mainWindow,
    notificationService,
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

  // ApprovalGate already constructed above (before initPluginRuntime) so the
  // plugin HostApi factory could wire `agentApproval` to the live gate.
  // approvalGateRef was bound at construction time.

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
    notificationService,
  });

  // Late-binding 주입 — ConversationLoop 생성 직후.
  lateBinding.conversationLoopRef.fn = conversationLoop;
  lateBinding.llmCallerRef.fn = createCallLlm(conversationLoop);
  lateBinding.pluginCallLlmRef.fn = createCallLlmForPlugin(conversationLoop, bootAuditLogger);
  log.info("boot: plugin callLlm ready (rate-limited)");

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
      log.warn("reminder fired emit failed: %s", (err as Error).message);
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
  log.info("boot: trigger executor wired (proactive turns isolated)");

  // §9.5: MCP Server 연결.
  const mcpGovernance = new McpGovernance();
  const mcpManager = new McpManager(mcpGovernance, toolRegistry, undefined, permissionManager, bootAuditLogger);
  try {
    const configs = await mcpManager.loadFromConfig();
    if (configs.length > 0) {
      await mcpManager.connectAll();
      log.info("boot: MCP servers connected");
    }
  } catch (err) {
    log.warn("boot: MCP initialization failed (non-fatal): %s", (err as Error).message);
  }
  mcpGovernance.startPolicyRefresh((revokedIds) => {
    for (const serverId of revokedIds) {
      void mcpManager.killSwitch(serverId).catch((err) => {
        log.error({ serverId, err }, "boot: revoked MCP server kill failed");
      });
    }
  });

  // §FU#259 — MCP marketplace artifact store. Rooted at ~/.lvis/mcp/ so the
  // server config (servers.json) and install directories share one parent —
  // user-controlled state lives under ~/.lvis/, not Electron's userData.
  // Each installed server gets ~/.lvis/mcp/<slug>/; the catalog config sits
  // at ~/.lvis/mcp/servers.json. Constructed only when the fetcher supports
  // verified downloads (the disabled fetcher throws on any download attempt
  // anyway).
  const mcpArtifactStore = (() => {
    if (marketplaceFetcher instanceof DisabledMarketplaceFetcher) return undefined;
    const mcpInstallRoot = resolve(homedir(), ".lvis", "mcp");
    return new PluginArtifactStore({
      installRoot: mcpInstallRoot,
      cacheRoot: resolve(mcpInstallRoot, ".cache"),
      fetcher: marketplaceFetcher,
      publicKeys: getBundledPublicKeys(),
    });
  })();

  // Backlog #3: surface degraded-validator state at boot-ready so it's
  // prominent in the operator log alongside the tool/plugin/mcp counts.
  const validationStatus = pluginRuntime.isValidatorDegraded() ? " validation:degraded" : "";
  log.info("boot: ready (%d tools, %d plugins, %d mcp%s)", toolRegistry.size, pluginRuntime.listPluginIds().length, mcpManager.listServers().filter(s => s.status === "connected").length, validationStatus);

  // Watcher telemetry consumer — ms-graph (v0.1.27+) 가 발행하는
  // `email.watcher.poll.completed` 이벤트를 ~/.lvis/logs/watcher-poll.jsonl
  // 에 적재. 정식 metrics pipeline 도입 전 단계 — 사용자 머신의 cold-seed
  // latency / payload 분포를 raw 로 모아 사후 jq 분석. 향후 ms-graph 의
  // chunked-seed / interval 튜닝 의사결정 데이터 소스.
  const watcherTelemetryLogPath = resolve(homedir(), ".lvis", "logs", "watcher-poll.jsonl");
  const watcherTelemetryCollector = startWatcherTelemetryCollector({
    filePath: watcherTelemetryLogPath,
    subscribe: (type, handler) => onEvent(type, handler),
    log: (msg, meta) => log.warn({ meta }, msg),
  });
  app.on("before-quit", () => watcherTelemetryCollector.stop());

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
    pythonRuntime, pythonPath,
    pluginRuntime, pluginMarketplace, settingsService,
    memoryManager, keywordEngine, routeEngine, toolRegistry,
    systemPromptBuilder, conversationLoop, routineEngine, mcpManager, mcpArtifactStore,
    triggerExecutor: lateBinding.triggerExecutorRef.fn ?? undefined,
    idleScheduler, bashAstValidator, auditService, auditLogger: bootAuditLogger, postTurnHookChain,
    approvalGate, knowledgeAvailable, starredStore, feedbackStore,
    remindersStore, remindersScheduler, sessionTodoStore, askUserQuestionGate, skillStore,
    notificationService,
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
      })();
      return shutdownPromise;
    },
  };
}
