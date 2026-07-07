/**
 * assembleAppServices — build the final {@link AppServices} return literal from
 * a fully-populated {@link BootContext} (C18).
 *
 * The key set here is a LOCKED contract: it must match the C3 bootstrap
 * integration snapshot exactly (same names, same construction). This module owns
 * the deferred lifecycle closures main.ts drives after boot
 * (`startRoutinesScheduler`, `startWorkBoardDueSoon`, `refreshPluginNotifications`,
 * `registerPluginEventBridge`, `shutdown`) — they read + mutate the context so
 * the plugin-notification / event-bridge disposers and the due-soon timer stay
 * live across window recreation and are torn down deterministically on quit.
 */
import { registerPluginNotifications } from "./plugins.js";
import {
  clearAuthPartition as clearAuthPartitionService,
  forgetTrackedPluginAuthPartitions as forgetPluginAuthPartitionsService,
  getTrackedPluginAuthPartitions as listPluginAuthPartitionsService,
} from "../main/auth-window-service.js";
import type { AppServices } from "./types.js";
import type { BootContext } from "./context.js";

export function assembleAppServices(ctx: BootContext): AppServices {
  let shutdownPromise: Promise<void> | null = null;

  return {
    pythonRuntime: ctx.pythonRuntime,
    pythonPath: ctx.pythonPath,
    pluginRuntime: ctx.pluginRuntime,
    pluginMarketplace: ctx.pluginMarketplace,
    settingsService: ctx.settingsService,
    memoryManager: ctx.memoryManager,
    keywordEngine: ctx.keywordEngine,
    routeEngine: ctx.routeEngine,
    toolRegistry: ctx.toolRegistry,
    systemPromptBuilder: ctx.systemPromptBuilder,
    conversationLoop: ctx.conversationLoop,
    sideChatConversationLoop: ctx.sideChatConversationLoop,
    routineEngine: ctx.routineEngine,
    mcpManager: ctx.mcpManager,
    mcpArtifactStore: ctx.mcpArtifactStore,
    agentArtifactStore: ctx.agentArtifactStore,
    skillArtifactStore: ctx.skillArtifactStore,
    idleScheduler: ctx.idleScheduler,
    preferenceRefreshService: ctx.preferenceRefreshService,
    bashAstValidator: ctx.bashAstValidator,
    auditService: ctx.auditService,
    auditLogger: ctx.bootAuditLogger,
    postTurnHookChain: ctx.postTurnHookChain,
    approvalGate: ctx.approvalGate,
    rewireReviewerAgent: ctx.rewireReviewerAgent,
    refreshMarketplaceFetcherConfig: ctx.refreshMarketplaceFetcherConfig,
    refreshActiveLlmWildcard: ctx.refreshActiveLlmWildcard,
    refreshSandboxNetworkConfig: ctx.refreshSandboxNetworkConfig,
    routinesStore: ctx.routinesStore,
    routinesScheduler: ctx.routinesScheduler,
    workBoardStore: ctx.workBoardStore,
    workBoardEngine: ctx.workBoardEngine,
    workBoardReport: ctx.workBoardReporter,
    sessionTodoStore: ctx.sessionTodoStore,
    getSubAgentRunner: () => ctx.subAgentRunnerRef.fn,
    askUserQuestionGate: ctx.askUserQuestionGate,
    skillStore: ctx.skillStore,
    agentProfileStore: ctx.agentProfileStore,
    personaPromptStore: ctx.personaPromptStore,
    knowledgeAvailable: ctx.knowledgeAvailable,
    starredStore: ctx.starredStore,
    feedbackStore: ctx.feedbackStore,
    notificationService: ctx.notificationService,
    scriptHookManager: ctx.scriptHookManager,
    telemetry: ctx.telemetry,
    pluginTelemetry: ctx.pluginTelemetry,
    autoUpdaterStop: ctx.autoUpdaterStop,
    runPluginShutdownHandlers: ctx.runPluginShutdownHandlers,
    pluginPaths: ctx.pluginPaths,
    clearAuthPartitionService,
    forgetPluginAuthPartitionsService,
    listPluginAuthPartitionsService,
    startRoutinesScheduler: () => ctx.routinesScheduler.start(),
    startWorkBoardDueSoon: ctx.startWorkBoardDueSoon,
    refreshPluginNotifications: () => {
      ctx.disposePluginNotifications();
      ctx.disposePluginNotifications = registerPluginNotifications(ctx.pluginRuntime, ctx.pluginEventBridgeWindow, ctx.notificationService, ctx.bootAuditLogger);
      ctx.replacePluginEventBridge(ctx.pluginEventBridgeWindow);
    },
    registerPluginEventBridge: ctx.replacePluginEventBridge,
    shutdown: () => {
      if (shutdownPromise) return shutdownPromise;
      shutdownPromise = (async () => {
        ctx.disposePluginNotifications();
        ctx.disposePluginEventBridge();
        ctx.autoUpdaterStop?.();
        ctx.telemetry?.stop();
        ctx.pluginTelemetry?.stop();
        ctx.preferenceRefreshService.stop();
        ctx.idleScheduler?.stop();
        ctx.routinesScheduler.stop();
        if (ctx.dueSoonTimer) clearInterval(ctx.dueSoonTimer);
        ctx.askUserQuestionGate.disposeAll();
        ctx.mcpGovernance.stopPolicyRefresh();
        await ctx.mcpManager.disconnectAll();
        await ctx.auditService.stop();
      })();
      return shutdownPromise;
    },
  };
}
