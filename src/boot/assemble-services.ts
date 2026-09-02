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
import type { ReadyBootContext } from "./context.js";

export function assembleAppServices(ctx: ReadyBootContext): AppServices {
  let shutdownPromise: Promise<void> | null = null;
  let activeLlmWildcardDisposed = false;

  // App cleanup invokes plugin shutdown handlers before `services.shutdown()`.
  // Dispose here as well as in `shutdown()` so a pending vendor-change debounce
  // cannot restart a plugin while its shutdown hook is running.
  const disposeActiveLlmWildcard = (): void => {
    if (activeLlmWildcardDisposed) return;
    ctx.disposeRefreshActiveLlmWildcard();
    activeLlmWildcardDisposed = true;
  };

  return {
    pythonRuntime: ctx.pythonRuntime,
    pythonPath: ctx.pythonPath,
    pluginRuntime: ctx.pluginRuntime,
    pluginMarketplace: ctx.pluginMarketplace,
    settingsService: ctx.settingsService,
    a2aRemoteRuntime: ctx.a2aRemoteRuntime,
    remoteA2AActionController: ctx.remoteA2AActionController,
    memoryManager: ctx.memoryManager,
    memoryCaptureService: ctx.memoryCaptureService,
    inputClassifier: ctx.inputClassifier,
    routeEngine: ctx.routeEngine,
    toolRegistry: ctx.toolRegistry,
    systemPromptBuilder: ctx.systemPromptBuilder,
    // The same instance the prompt builder reads — the `mcp.uiModelContext` IPC is its
    // only writer.
    mcpAppModelContext: ctx.mcpAppModelContext,
    conversationLoop: ctx.conversationLoop,
    sideChatConversationLoop: ctx.sideChatConversationLoop,
    // Tiled chat groups resolve their own loop through this. It is assembled
    // by name like everything else here, so leaving it out is how the IPC
    // domain ends up unable to build any group but the primary.
    resolveChatGroupLoop: ctx.resolveChatGroupLoop,
    releaseChatGroupLoop: ctx.releaseChatGroupLoop,
    findLoopBySessionId: ctx.findLoopBySessionId,
    findChatGroupLoop: ctx.findChatGroupLoop,
    routineEngine: ctx.routineEngine,
    mcpManager: ctx.mcpManager,
    pluginLoopbackManager: ctx.pluginLoopbackManager,
    pluginBundleLifecycle: ctx.pluginBundleLifecycle,
    getPluginToolInvoker: () => ctx.lateBinding.pluginToolInvokerRef.fn,
    requestPluginOperationGrant: ctx.requestPluginOperationGrant,
    revokePluginOperationSession: ctx.revokePluginOperationSession,
    mcpArtifactStore: ctx.mcpArtifactStore,
    agentArtifactStore: ctx.agentArtifactStore,
    skillArtifactStore: ctx.skillArtifactStore,
    idleScheduler: ctx.idleScheduler,
    preferenceRefreshService: ctx.preferenceRefreshService,
    memoryConsolidationService: ctx.memoryConsolidationService,
    memoryMaintenanceCoordinator: ctx.memoryMaintenanceCoordinator,
    bashAstValidator: ctx.bashAstValidator,
    auditService: ctx.auditService,
    auditLogger: ctx.bootAuditLogger,
    postTurnHookChain: ctx.postTurnHookChain,
    approvalGate: ctx.approvalGate,
    rewireReviewerAgent: ctx.rewireReviewerAgent,
    getApprovalSentenceSelector: () => ctx.approvalSentenceSelector,
    refreshMarketplaceFetcherConfig: ctx.refreshMarketplaceFetcherConfig,
    refreshActiveLlmWildcard: ctx.refreshActiveLlmWildcard,
    refreshSandboxNetworkConfig: ctx.refreshSandboxNetworkConfig,
    routinesStore: ctx.routinesStore,
    routinesScheduler: ctx.routinesScheduler,
    workBoardStore: ctx.workBoardStore,
    workBoardEngine: ctx.workBoardEngine,
    workBoardReport: ctx.workBoardReporter,
    sessionTasksStore: ctx.sessionTasksStore,
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
    runPluginShutdownHandlers: async () => {
      disposeActiveLlmWildcard();
      await ctx.runPluginShutdownHandlers();
    },
    pluginPaths: ctx.pluginPaths,
    clearAuthPartitionService,
    forgetPluginAuthPartitionsService,
    listPluginAuthPartitionsService,
    startRoutinesScheduler: () => ctx.routinesScheduler.start(),
    startWorkBoardDueSoon: ctx.startWorkBoardDueSoon,
    refreshPluginNotifications: () => {
      ctx.disposePluginNotifications();
      ctx.disposePluginNotifications = registerPluginNotifications(ctx.pluginRuntime, ctx.pluginEventBridgeWindow, ctx.notificationService, ctx.bootAuditLogger,
      );
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

        // Direct callers bypass the app-level plugin-shutdown phase.
        attempt(disposeActiveLlmWildcard);
        attempt(() => ctx.disposePluginNotifications());
        attempt(() => ctx.disposePluginEventBridge());
        attempt(() => ctx.autoUpdaterStop?.());
        attempt(() => ctx.telemetry?.stop());
        attempt(() => ctx.pluginTelemetry?.stop());
        attempt(() => ctx.memoryMaintenanceCoordinator.stop());
        attempt(() => ctx.memoryCaptureService.stop());
        attempt(() => ctx.preferenceRefreshService.stop());
        attempt(() => ctx.idleScheduler?.stop());
        attempt(() => ctx.a2aRemoteRuntime?.dispose());
        attempt(() => ctx.routinesScheduler.stop());
        if (ctx.dueSoonTimer) attempt(() => clearInterval(ctx.dueSoonTimer));

        attempt(() => ctx.conversationLoop.abortCurrentTurn(new Error("application shutdown"),
          ),
        );
        attempt(() => ctx.sideChatConversationLoop.abortCurrentTurn(new Error("application shutdown"),
          ),
        );
        attempt(() => ctx.rationaleHostService?.shutdown());

        attempt(() => ctx.approvalGate.disposeAll());
        attempt(() => ctx.askUserQuestionGate.disposeAll());
        attempt(() => ctx.mcpGovernance.stopPolicyRefresh());
        await attemptAsync(() => ctx.mcpManager.disconnectAll());
        await attemptAsync(() => ctx.bootAuditLogger.close());
        await attemptAsync(() => ctx.auditService.stop());

        if (errors.length > 0) {
          throw new AggregateError(errors, "application service shutdown failed",
          );
        }
      })();
      return shutdownPromise;
    },
  };
}
