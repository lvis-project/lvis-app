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
 *   Step 6          src/boot/proactive.ts         proactive engine +
 *                                                 calendar loaders.
 *   Step 6          src/boot/steps/proactive-coordinator — trigger coordinator
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
import { resolve } from "node:path";
import { app } from "electron";
import type { BrowserWindow } from "electron";
import { MockMarketplaceFetcher, PluginMarketplaceService } from "./plugins/marketplace.js";
import type { MarketplaceFetcher } from "./plugins/marketplace.js";
import { RealCloudMarketplaceFetcher } from "./plugins/real-cloud-marketplace-fetcher.js";
import { StarredStore } from "./data/starred-store.js";
import { FeedbackStore } from "./data/feedback-store.js";
import { McpGovernance } from "./mcp/mcp-governance.js";
import { McpManager } from "./mcp/mcp-manager.js";

import { type AppServices } from "./boot/types.js";
import { bootstrapCoreServices } from "./boot/services.js";
import { registerPluginNotifications } from "./boot/plugins.js";
import {
  registerBuiltinTools,
  registerRequestPluginMetaTool,
  wireKnowledgeAndIdleScheduler,
} from "./boot/tools.js";
import {
  createProactiveEngine,
  loadCalendarToday,
  loadWeeklyCalendarIfMonday,
} from "./boot/proactive.js";
import {
  createSystemPromptBuilder,
  createPermissionManager,
  createPostTurnHookChain,
  createApprovalGate,
  createHookRunner,
  createConversationLoop,
  createCallLlm,
  createCallLlmForPlugin,
} from "./boot/conversation.js";
import { initPluginRuntime } from "./boot/steps/plugin-runtime.js";
import { registerPluginEventBridge } from "./boot/steps/ipc-bridge.js";
import { wireProactiveCoordinator } from "./boot/steps/proactive-coordinator.js";
import { wireReleasePrep, wireUpdateCheck } from "./boot/steps/post-boot.js";

export type { AppServices } from "./boot/types.js";

export async function bootstrap(projectRoot: string, mainWindow: BrowserWindow): Promise<AppServices> {
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
  });

  // §4.2 Step 4: builtin tools + request_plugin meta tool.
  registerBuiltinTools(memoryManager, toolRegistry, settingsService);
  registerRequestPluginMetaTool(toolRegistry);

  // §4.4 HybridRetriever + Knowledge Tools DI, §6.1 IdleSchedulerService.
  const { idleScheduler, knowledgeAvailable } = await wireKnowledgeAndIdleScheduler({
    pluginRuntime,
    toolRegistry,
    auditService,
  });

  // §9.5 M4: marketplace backend selection.
  const marketplaceSettings = settingsService.get("marketplace");
  // For "real-cloud" mode, pass an explicit fetcher so the service uses the
  // network backend with catalog caching enabled.
  // For "mock" mode, pass no fetcher — PluginMarketplaceService creates its
  // own internal MockMarketplaceFetcher and disables catalog caching so that
  // the bundled plugins/marketplace.json is always read fresh (no stale
  // ~/.lvis/marketplace-cache/ data can shadow local changes).
  let marketplaceFetcher: MarketplaceFetcher | undefined;
  if (
    marketplaceSettings.backend === "real-cloud" &&
    marketplaceSettings.realCloudBaseUrl
  ) {
    marketplaceFetcher = new RealCloudMarketplaceFetcher({
      baseUrl: marketplaceSettings.realCloudBaseUrl,
      apiKey: settingsService.getSecret("marketplace.apiKey") ?? undefined,
      allowPrivateNetwork: marketplaceSettings.realCloudAllowPrivateNetwork,
    });
    console.log("[lvis] boot: marketplace backend = real-cloud (%s)", marketplaceSettings.realCloudBaseUrl);
  }
  const pluginMarketplace = new PluginMarketplaceService(
    projectRoot,
    deploymentGuard,
    marketplaceFetcher,
  );
  // wireUpdateCheck needs a concrete fetcher for update detection.
  // In mock mode, create a dedicated MockMarketplaceFetcher (caching is
  // irrelevant for update checks — they always want fresh data).
  const updateCheckFetcher: MarketplaceFetcher =
    marketplaceFetcher ?? new MockMarketplaceFetcher(resolve(projectRoot, "plugins/marketplace.json"));

  // §4.5.9: SystemPromptBuilder.
  const systemPromptBuilder = createSystemPromptBuilder({
    memoryManager, toolRegistry, pluginRuntime,
  });

  // §6.3: PermissionManager (Layer 2-3).
  const permissionManager = await createPermissionManager();

  // §7: Proactive Engine.
  const proactiveEngine = createProactiveEngine({
    taskService,
    memoryManager,
    pluginRuntime,
    isDailyBriefingEnabled: () =>
      settingsService.get("proactive")?.enableDailyBriefing ?? false,
    callLlm: async (prompt, opts) => {
      if (!lateBinding.llmCallerRef.fn) throw new Error("LLM provider not ready");
      return lateBinding.llmCallerRef.fn(prompt, opts);
    },
    getLastBriefingDate: () => settingsService.get("proactive")?.lastBriefingAt,
    setLastBriefingDate: (dateKst) => {
      const cur = settingsService.get("proactive") ?? { enableDailyBriefing: false };
      settingsService.patch({ proactive: { ...cur, lastBriefingAt: dateKst } });
    },
    getLastDismissedAt: () => settingsService.get("proactive")?.lastDismissedAt,
    auditLogger: bootAuditLogger,
  });

  // Sprint 3-A-2: ProactiveTriggerCoordinator + idle-scheduler composite.
  wireProactiveCoordinator({
    proactiveEngine,
    taskService,
    pluginRuntime,
    settingsService,
    idleScheduler,
    mainWindow,
  });

  // 오늘 일정 초기 로드.
  loadCalendarToday(pluginRuntime, proactiveEngine);

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
    proactiveEngine,
    idleScheduler,
    postTurnHookChain,
    bashAstValidator,
    approvalGate,
    hookRunner,
    pluginRuntime,
  });

  // Late-binding 주입 — ConversationLoop 생성 직후.
  lateBinding.conversationLoopRef.fn = conversationLoop;
  lateBinding.llmCallerRef.fn = createCallLlm(conversationLoop);
  lateBinding.pluginCallLlmRef.fn = createCallLlmForPlugin(conversationLoop, bootAuditLogger);
  console.log("[lvis] boot: plugin callLlm ready (rate-limited)");

  // Feature 4: 월요일 주간 일정 캐시 로드 (KST 기준).
  loadWeeklyCalendarIfMonday(pluginRuntime, proactiveEngine);

  // §9.5: MCP Server 연결.
  const mcpGovernance = new McpGovernance();
  const mcpManager = new McpManager(mcpGovernance, toolRegistry);
  try {
    const configs = await mcpManager.loadFromConfig();
    if (configs.length > 0) {
      await mcpManager.connectAll();
      console.log("[lvis] boot: MCP servers connected");
    }
  } catch (err) {
    console.warn("[lvis] boot: MCP initialization failed (non-fatal):", (err as Error).message);
  }
  mcpGovernance.startPolicyRefresh();

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
  wireUpdateCheck({
    projectRoot,
    mainWindow,
    settingsService,
    marketplaceFetcher: updateCheckFetcher,
  });

  // void unused imports avoidance — app reference retained for type imports.
  void app;

  return {
    pluginRuntime, pluginMarketplace, taskService, taskSourceRegistry, settingsService,
    memoryManager, keywordEngine, routeEngine, toolRegistry,
    systemPromptBuilder, conversationLoop, proactiveEngine, mcpManager,
    idleScheduler, bashAstValidator, auditService, auditLogger: bootAuditLogger, postTurnHookChain,
    approvalGate, knowledgeAvailable, starredStore, feedbackStore,
    telemetry, pluginTelemetry, autoUpdaterStop,
    refreshPluginNotifications: () => {
      disposePluginNotifications();
      disposePluginNotifications = registerPluginNotifications(pluginRuntime, mainWindow);
      disposePluginEventBridge();
      disposePluginEventBridge = registerPluginEventBridge(pluginRuntime, mainWindow);
    },
    registerPluginEventBridge: (win) => registerPluginEventBridge(pluginRuntime, win),
  };
}
