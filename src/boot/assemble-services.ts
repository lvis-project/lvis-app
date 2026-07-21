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
    a2aRemoteRuntime: ctx.a2aRemoteRuntime,
    remoteA2AActionController: ctx.remoteA2AActionController,
    memoryManager: ctx.memoryManager,
    keywordEngine: ctx.keywordEngine,
    routeEngine: ctx.routeEngine,
    toolRegistry: ctx.toolRegistry,
    systemPromptBuilder: ctx.systemPromptBuilder,
    // The same instance the prompt builder reads — the `mcp.uiModelContext` IPC is its
    // only writer.
    mcpAppModelContext: ctx.mcpAppModelContext,
    conversationLoop: ctx.conversationLoop,
    sideChatConversationLoop: ctx.sideChatConversationLoop,
    routineEngine: ctx.routineEngine,
    mcpManager: ctx.mcpManager,
    pluginLoopbackManager: ctx.pluginLoopbackManager,
    getPluginToolInvoker: () => ctx.lateBinding.pluginToolInvokerRef.fn,
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
        const errors: unknown[] = [];
        const attempt = (operation: () => void): void => {
          try {
            operation();
          } catch (error) {
            errors.push(error);
          }
        };
        const attemptAsync = async (
          operation: () => Promise<void>,
        ): Promise<void> => {
          try {
            await operation();
          } catch (error) {
            errors.push(error);
          }
        };

        attempt(() => ctx.disposePluginNotifications());
        attempt(() => ctx.disposePluginEventBridge());
        attempt(() => ctx.autoUpdaterStop?.());
        attempt(() => ctx.telemetry?.stop());
        attempt(() => ctx.pluginTelemetry?.stop());
        attempt(() => ctx.preferenceRefreshService.stop());
        attempt(() => ctx.idleScheduler?.stop());
        attempt(() => ctx.a2aRemoteRuntime?.dispose());
        attempt(() => ctx.routinesScheduler.stop());
        if (ctx.dueSoonTimer) attempt(() => clearInterval(ctx.dueSoonTimer));

        attempt(() => ctx.conversationLoop.abortCurrentTurn(new Error("application shutdown")));
        attempt(() => ctx.sideChatConversationLoop.abortCurrentTurn(new Error("application shutdown")));
        attempt(() => ctx.rationaleHostService?.shutdown());

        attempt(() => ctx.approvalGate.disposeAll());
        attempt(() => ctx.askUserQuestionGate.disposeAll());
        attempt(() => ctx.mcpGovernance.stopPolicyRefresh());
        await attemptAsync(() => ctx.mcpManager.disconnectAll());
        await attemptAsync(() => ctx.auditService.stop());

        if (errors.length > 0) {
          throw new AggregateError(errors, "application service shutdown failed");
        }
      })();
      return shutdownPromise;
    },
  };
}
