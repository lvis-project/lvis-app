/**
 * Boot step — routine engine, conversation loop, late bindings, and the
 * agent-loop-dependent services (§4.5 + §7, extracted from boot.ts C18).
 *
 * This is the densest late-binding block: it builds the per-routine
 * ConversationLoop factory, registers the manifest-driven plugin IPC bridges,
 * assembles the interactive ConversationLoop, injects the late-binding refs the
 * plugin runtime holds (loop / callLlm / pluginCallLlm), starts the preference
 * refresh service, constructs the SubAgentRunner (reusing the loop's dep set),
 * and finally the WorkBoardEngine + reporter that depend on the runner + one-
 * shot LLM caller. The mutable plugin-notification / event-bridge disposers are
 * stored on the context so `shutdown()` + `refreshPluginNotifications` can drive
 * them post-boot.
 */
import { BrowserWindow as BrowserWindowValue } from "electron";
import type { BrowserWindow } from "electron";
import { createRoutineEngine } from "../routine.js";
import {
  createPostTurnHookChain,
  createConversationLoop,
  createRoutineConversationLoop,
  createSideChatConversationLoop,
  createCallLlm,
  createCallLlmForPlugin,
} from "../conversation.js";
import { MemoryManager } from "../../memory/memory-manager.js";
import { openFeatureNamespace } from "../../main/storage/feature-namespace.js";
import { registerPluginNotifications } from "../plugins.js";
import { registerPluginEventBridge } from "./ipc-bridge.js";
import { readPermissionSettings } from "../../permissions/permission-settings-store.js";
import { retainedDescendantWorkspaceRoots } from "../../permissions/workspace-root-reconciler.js";
import { broadcastPermissionConfigChanged as broadcastPermissionConfigChangedFromIpc } from "../../ipc/domains/permissions.js";
import { PreferenceRefreshService } from "../../memory/preference-refresh-service.js";
import { MemoryConsolidationService, MemoryMaintenanceCoordinator } from "../../memory/memory-consolidation-service.js";
import { MemoryReviewerService } from "../../memory/memory-reviewer-service.js";
import { SubAgentRunner } from "../../engine/subagent-runner.js";
import { A2ASubAgentMessageBus } from "../../engine/a2a-subagent-message-bus.js";
import { A2AAgentMessageBus } from "../../engine/a2a-agent-message-bus.js";
import { A2AAgentMessageMailbox } from "../../engine/a2a-agent-message-mailbox.js";
import { SubAgentMessageMailbox } from "../../engine/subagent-message-mailbox.js";
import { createWorkBoardEngine, type WorkBoardEngine,
} from "../../core/work-board-engine.js";
import { createWorkBoardReporter, type WorkBoardReporter,
} from "../../work-board/work-report.js";
import { appendMemory } from "../../work-board/work-memory.js";
import { WORK_BOARD } from "../../shared/ipc-channels.js";
import { fanOutToAllWindows } from "../../ipc/broadcast-helpers.js";
import { emitEvent } from "../types.js";
import { createLogger } from "../../lib/logger.js";
import { createSubscriptionLlmProvider } from "../../main/subscription-llm-provider.js";
import {
  SubscriptionRuntimeServiceError,
  type SubscriptionRuntimeAuditSink,
} from "../../main/subscription-runtime-service.js";
import { validateExternalUrl } from "../../shared/external-url.js";
import type { LLMProvider } from "../../engine/llm/types.js";
import type { SubscriptionChatRuntimeSelection } from "../../shared/subscription-runtime.js";
import type { AuditLogger } from "../../audit/audit-logger.js";
import type { BootContext } from "../context.js";
import type { ConversationLoop } from "../../engine/conversation-loop.js";
import { captureRationalePolicyEpoch } from "../../tools/pipeline/rationale-policy-epoch.js";
import type { RationaleCoordinatorFactory } from "../../engine/turn/rationale-conversation-orchestration.js";

const log = createLogger("lvis");

export interface SubscriptionChatLoopBindings {
  readonly subscriptionProviderFactory: (
    selection: SubscriptionChatRuntimeSelection,
    fallbackSelection?: SubscriptionChatRuntimeSelection,
  ) => LLMProvider | null;
}

/**
 * Main-process-only subscription provider factory. It
 * intentionally owns no runtime paths and accepts only a settings-normalized
 * selection; the shared runtime service owns credential and transport state.
 */
export function createSubscriptionChatLoopBindings(input: {
  readonly shellOpenExternal: (url: string) => Promise<void>;
  readonly auditLogger: Pick<AuditLogger, "log">;
}): SubscriptionChatLoopBindings {
  const openExternal = async (url: string): Promise<void> => {
    const validated = validateExternalUrl(url);
    if (!validated.ok) {
      throw new SubscriptionRuntimeServiceError("subscription-verification-url-unavailable");
    }
    await input.shellOpenExternal(validated.url);
  };
  const audit: SubscriptionRuntimeAuditSink = (event) => {
    const requestKind = typeof event.requestKind === "string"
      && /^[a-z-]{1,80}$/.test(event.requestKind)
      ? event.requestKind
      : undefined;
    try {
      input.auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: "subscription-runtime",
        type: "warn",
        input: JSON.stringify({
          provider: event.provider,
          outcome: event.outcome,
          ...(requestKind ? { requestKind } : {}),
        }),
      });
    } catch {
      // Audit availability must not make the provider usable or unusable.
    }
  };
  return Object.freeze({
    subscriptionProviderFactory: (
      selection: SubscriptionChatRuntimeSelection,
      fallbackSelection?: SubscriptionChatRuntimeSelection,
    ) => createSubscriptionLlmProvider({
      selection,
      ...(fallbackSelection ? { fallbackSelection } : {}),
      openExternal,
      runtimeServiceOptions: { audit },
    }),
  });
}

export interface IsolatedConversationMemoryManagers {
  sideChatMemoryManager: MemoryManager;
  subAgentMemoryManager: MemoryManager;
}

export interface LoopRationaleBindings {
  readonly rationaleCoordinatorFactory?: RationaleCoordinatorFactory;
  readonly closeRationaleSession?: (sessionId: string) => void;
}

export function createLoopRationaleBindings(input: {
  readonly service: BootContext["rationaleHostService"];
  readonly permissionManager: BootContext["permissionManager"];
  readonly hookRunner: BootContext["hookRunner"];
  readonly scriptHookManager: BootContext["scriptHookManager"];
  readonly getLoop: () => ConversationLoop;
}): LoopRationaleBindings {
  const service = input.service;
  if (!service) return {};

  const rationaleCoordinatorFactory = service.createCoordinatorFactory({
    getRationalePolicyEpoch: () =>
      captureRationalePolicyEpoch({
        permissionManager: input.permissionManager,
        hookRunner: input.hookRunner,
        scriptHookManager: input.scriptHookManager,
        additionalDirectories:
          input.getLoop().getTurnAdditionalDirectories(),
      }),
    isSessionCurrent: (sessionId) =>
      input.getLoop().getSessionId() === sessionId,
  });

  return {
    rationaleCoordinatorFactory,
    closeRationaleSession: (sessionId) => service.closeSession(sessionId),
  };
}

export function createIsolatedConversationMemoryManagers(): IsolatedConversationMemoryManagers {
  const sideChatMemoryManager = new MemoryManager({
    lvisDir: openFeatureNamespace("side-chat").dir,
  });
  sideChatMemoryManager.load();
  const subAgentMemoryManager = new MemoryManager({
    lvisDir: openFeatureNamespace("subagent").dir,
  });
  subAgentMemoryManager.load();
  return { sideChatMemoryManager, subAgentMemoryManager };
}

export async function wireConversation(
  ctx: BootContext,
  removedWorkspaceRoots: readonly string[],
  isolatedMemoryManagers: IsolatedConversationMemoryManagers,
): Promise<void> {
  const {
    settingsService,
    systemPromptBuilder,
    inputClassifier,
    routeEngine,
    toolRegistry,
    memoryManager,
    memoryCaptureService,
    permissionManager,
    approvalGate,
    hookRunner,
    scriptHookManager,
    rationaleHostService,
    bashAstValidator,
    pluginRuntime,
    pluginOperationGrants,
    pluginOperationIdentityProvider,
    bootAuditLogger,
    llmFetch,
    idleScheduler,
    sessionTodoStore,
    skillOverlay,
    notificationService,
    rewireReviewerAgent,
    lateBinding,
    subAgentRunnerRef,
    workBoardStore,
    workBoardStorage,
    agentProfileStore,
    getMainWindow,
    mainWindow,
    subscriptionProviderFactory,
  } = ctx;

  const { sideChatMemoryManager, subAgentMemoryManager } = isolatedMemoryManagers;

  // One host-owned, no-tool lane for every automatic memory transformation.
  // The resolver is intentionally late: queued review work follows the current
  // active login/model after a provider change rather than retaining a stale one.
  const memoryReviewer = new MemoryReviewerService({
    resolveActiveChatOneShot: () => lateBinding.llmCallerRef.fn,
  });

  const routineLoopDeps = {
    settingsService,
    systemPromptBuilder,
    inputClassifier,
    routeEngine,
    toolRegistry,
    memoryManager,
    memoryReviewer,
    permissionManager,
    approvalGate,
    hookRunner,
    scriptHookManager,
    bashAstValidator,
    pluginRuntime,
    pluginOperationGrants,
    pluginOperationIdentityProvider,
    auditLogger: bootAuditLogger,
    llmFetch,
    subscriptionProviderFactory,
  };
  const routineEngine = createRoutineEngine({
    createConversationLoop: (input) => createRoutineConversationLoop(
      routineLoopDeps,
      { scope: input.scope }),
    // Permission policy Layer 4 — snapshot the live plugin runtime's active id set so
    // routines with `scope.pluginIds.mode === "inherit"` are normalized
    // to a concrete allow-list at fire time (never at loop-construction).
    getActivePluginIds: () => pluginRuntime.listPluginIds(),
  });
  // Durable routine-scope pruning is best-effort during boot. Keep the newly
  // constructed engine fail-closed even when that persistence cleanup failed.
  const retainedWorkspaceRoots = readPermissionSettings().permissions.additionalDirectories;
  for (const root of removedWorkspaceRoots) {
    routineEngine.revokeWorkspaceRoot(root, {
      preserveRoots: retainedDescendantWorkspaceRoots(root, retainedWorkspaceRoots,
      ),
    });
  }

  // §4.2 Step 7: manifest-driven IPC bridges. Plugin notifications route
  // through `notificationService` (#841) so they inherit the same focus
  // gate, cooldown, sanitization, and audit policy as the host's lifecycle
  // notifications.
  ctx.disposePluginNotifications = registerPluginNotifications(pluginRuntime, mainWindow, notificationService, bootAuditLogger,
  );
  ctx.disposePluginEventBridge = registerPluginEventBridge(pluginRuntime, mainWindow,
  );
  ctx.pluginEventBridgeWindow = mainWindow;
  ctx.replacePluginEventBridge = (win: BrowserWindow) => {
    ctx.pluginEventBridgeWindow = win;
    ctx.disposePluginEventBridge();
    ctx.disposePluginEventBridge = registerPluginEventBridge(pluginRuntime, win,
    );
  };

  // §4.5 + Agent 6: PostTurnHookChain.
  const { postTurnHookChain } = createPostTurnHookChain({
    memoryManager,
    idleScheduler,
    settingsService,
    memoryCaptureService,
    auditLogger: bootAuditLogger,
    sessionTodoStore,
  });

  // ApprovalGate already constructed above (before initPluginRuntime) so the
  // plugin HostApi factory could wire `agentApproval` to the live gate.
  // approvalGateRef was bound at construction time.

  // §4.5: ConversationLoop.
  let conversationLoop!: ConversationLoop;
  const rationaleBindings = createLoopRationaleBindings({
    service: rationaleHostService,
    permissionManager,
    hookRunner,
    scriptHookManager,
    getLoop: () => conversationLoop,
  });
  conversationLoop = createConversationLoop({
    settingsService,
    systemPromptBuilder,
    inputClassifier,
    routeEngine,
    toolRegistry,
    supportsA2AParentDelivery: true,
    memoryManager,
    memoryCaptureService,
    memoryReviewer,
    permissionManager,
    routineEngine,
    idleScheduler,
    postTurnHookChain,
    bashAstValidator,
    approvalGate,
    hookRunner,
    scriptHookManager,
    getAdditionalDirectories: () => readPermissionSettings().permissions.additionalDirectories,
    // Round-3 fix: dialog-driven session-add grants must broadcast so
    // multi-window PermissionsTab refreshes. Boot owns getMainWindow
    // and forwards it to the broadcaster declared in the permissions
    // IPC domain — no engine→ipc coupling, just a callback handed down.
    broadcastPermissionConfigChanged: () => {
      broadcastPermissionConfigChangedFromIpc({ getMainWindow, getAppWindows: () => BrowserWindowValue.getAllWindows(),
      } as Parameters<typeof broadcastPermissionConfigChangedFromIpc>[0]);
    },
    pluginRuntime,
    pluginOperationGrants,
    pluginOperationIdentityProvider,
    skillOverlay,
    sessionTodoStore,
    notificationService,
    auditLogger: bootAuditLogger,
    rewireReviewerAgent,
    llmFetch,
    subscriptionProviderFactory,
    ...rationaleBindings,
  });

  // Side-chat (workspace rail) — a SECOND ConversationLoop with an ISOLATED
  // MemoryManager rooted at `~/.lvis/side-chat/`. The dir path is resolved
  // through openFeatureNamespace (storage-namespace SOT) rather than a raw
  // join, so side-chat data lives in its own domain directory and can be
  // cleared/backed-up as a unit. The loop shares the same settingsService
  // (model inheritance) and permissionManager/approvalGate (permission
  // inheritance) as the main chat but never mixes sessions with it — the
  // isolated store guarantees `chat.sessions` (main) never lists a side-chat
  // session. Its own history/sessionId keep the two streams fully independent.
  let sideChatConversationLoop!: ConversationLoop;
  const sideChatRationaleBindings = createLoopRationaleBindings({
    service: rationaleHostService,
    permissionManager,
    hookRunner,
    scriptHookManager,
    getLoop: () => sideChatConversationLoop,
  });
  sideChatConversationLoop = createSideChatConversationLoop({
    settingsService,
    inputClassifier,
    routeEngine,
    toolRegistry,
    permissionManager,
    memoryReviewer,
    approvalGate,
    hookRunner,
    scriptHookManager,
    bashAstValidator,
    pluginRuntime,
    pluginOperationGrants,
    pluginOperationIdentityProvider,
    auditLogger: bootAuditLogger,
    llmFetch,
    sideChatMemoryManager,
    getAdditionalDirectories: () => readPermissionSettings().permissions.additionalDirectories,
    subscriptionProviderFactory,
    ...sideChatRationaleBindings,
  });
  ctx.sideChatConversationLoop = sideChatConversationLoop;


  lateBinding.conversationLoopRef.fn = conversationLoop;
  lateBinding.llmCallerRef.fn = createCallLlm(conversationLoop);
  memoryCaptureService.setMemoryReviewer(memoryReviewer);
  lateBinding.pluginCallLlmRef.fn = createCallLlmForPlugin(conversationLoop, bootAuditLogger,
  );
  log.info("boot: plugin callLlm ready (rate-limited)");

  const preferenceRefreshService = new PreferenceRefreshService({
    memoryManager,
    memoryReviewer,
    isIdleRefreshEnabled: () => settingsService.get("features")?.idlePreferenceRefresh ?? false,
  });
  const memoryConsolidationService = new MemoryConsolidationService({
    memoryManager,
    memoryReviewer,
    isIdleConsolidationEnabled: () => settingsService.get("features")?.idleMemoryConsolidation ?? false,
  });
  // This is the only IDLE_SCAN listener for provider-backed memory maintenance.
  // It serializes preference refresh before derived long-term consolidation.
  const memoryMaintenanceCoordinator = new MemoryMaintenanceCoordinator({
    memoryCaptureService,
    idleScheduler,
    preferenceRefreshService,
    memoryConsolidationService,
    getCurrentProject: () => conversationLoop.getSessionProjectIsDefault?.()
      ? undefined
      : conversationLoop.getSessionMemoryProjectContext?.(),
  });
  memoryMaintenanceCoordinator.start();

  // Sub-agent runs persist to an ISOLATED MemoryManager rooted at
  // `~/.lvis/subagent/` (resolved via openFeatureNamespace, the storage-
  // namespace SOT — no hand-rolled mkdir/mode bits). Reusing the main
  // `memoryManager` here is exactly what leaked orphan sub-agent JSONL into
  // the main `~/.lvis/sessions/` list; a dedicated store keeps sub-agent
  // transcripts out of `chat.sessions` and gives same-instance resume its own
  // addressable namespace. Mirrors the sideChatMemoryManager wiring above.
  const subAgentMessagingNamespace = openFeatureNamespace("subagent-messaging");
  const subAgentMessageMailbox = new SubAgentMessageMailbox(
    subAgentMessagingNamespace,
  );
  const subAgentMessageBus = new A2ASubAgentMessageBus({
    parentLoop: conversationLoop,
    mailbox: subAgentMessageMailbox,
    settingsService,
    auditLogger: bootAuditLogger,
    resolveChildAddress: async (parentSessionId, childSessionId, messageId) => {
      const runner = subAgentRunnerRef.fn;
      return runner
        ? await runner.resolveSubAgentAddress(parentSessionId, childSessionId, messageId,
          )
        : null;
    },
    releaseEphemeralChildAddress: (parentSessionId, childSessionId, messageId,
    ) =>
      subAgentRunnerRef.fn?.releaseEphemeralParentDelivery(
        parentSessionId,
        childSessionId,
        messageId,
      ),
  });
  const agentMessageMailbox = new A2AAgentMessageMailbox(
    subAgentMessagingNamespace,
  );
  const agentMessageBus = new A2AAgentMessageBus({
    parentBus: subAgentMessageBus,
    mailbox: agentMessageMailbox,
    auditLogger: bootAuditLogger,
    isOriginActive: (originSessionId) =>
      subAgentRunnerRef.fn?.isSubAgentOriginActive(originSessionId) ?? true,
    resolveSender: async (senderChildSessionId) => {
      const runner = subAgentRunnerRef.fn;
      return runner ? await runner.resolveSubAgentSender(senderChildSessionId) : null;
    },
    resolvePeer: async (
      senderChildSessionId,
      recipientChildSessionId) => {
      const runner = subAgentRunnerRef.fn;
      return runner
        ? await runner.resolveSubAgentPeer(
            senderChildSessionId,
            recipientChildSessionId,
          )
        : { ok: false, reason: "unknown-sender" };
    },
  });

  // Workflow system tools — late bindings now that ConversationLoop exists.
  // SubAgentRunner reuses the parent loop's deps (LLM, registry, gates) but
  // a fresh ConversationLoop is constructed per spawn inside the runner.
  subAgentRunnerRef.fn = new SubAgentRunner({
    parentDeps: {
      settingsService,
      systemPromptBuilder,
      inputClassifier,
      routeEngine,
      toolRegistry,
      memoryManager,
      memoryReviewer,
      permissionManager,
      approvalGate,
      bashAstValidator,
      hookRunner,
      scriptHookManager,
      pluginOperationGrants,
      pluginOperationIdentityProvider,
      auditLogger: bootAuditLogger,
      getAdditionalDirectories: () => readPermissionSettings().permissions.additionalDirectories,
      ...(conversationLoop.deps?.isDefaultProjectRoot
        ? { isDefaultProjectRoot: conversationLoop.deps.isDefaultProjectRoot }
        : {}),
      ...(conversationLoop.deps?.getDefaultProject
        ? { getDefaultProject: conversationLoop.deps.getDefaultProject }
        : {}),
      ...(conversationLoop.deps?.authorizeProject
        ? { authorizeProject: conversationLoop.deps.authorizeProject }
        : {}),
      rewireReviewerAgent,
      llmFetch,
      subscriptionProviderFactory,
    },
    toolRegistry,
    subAgentMemoryManager,
    messageBus: subAgentMessageBus,
    agentMessageBus,
  });
  // skill_load no longer mutates conversation history. The body is registered
  // into SkillOverlay for the current user-turn window and read by
  // SystemPromptBuilder via getActiveSkillsSection. See main/skill-overlay.ts
  // for the registry; src/tools/skill-load.ts for the tool entry point.

  // WorkBoardEngine — plan→approve→execute orchestration for one work item.
  // Wired here, right after the SubAgentRunner exists, because the engine
  // reuses the runner (via the late-bound subAgentRunnerRef closure) for both
  // child phases. emitProgress mirrors emitAgentSpawn — it pushes a
  // WorkBoardRunEvent to the renderer over the WORK_BOARD.runProgress channel.
  const workBoardEngine: WorkBoardEngine = createWorkBoardEngine({
    store: workBoardStore,
    getRunner: () => subAgentRunnerRef.fn,
    approvalGate,
    getAgentProfile: (name) => agentProfileStore.load(name),
    emitProgress: (event) => {
      // Fan the per-phase WorkBoardRunEvent out to every open window (mirroring
      // the itemChanged broadcast in the work-board IPC domain) so detached
      // panels show the live running indicator in lock-step. sendToWindow's
      // destroyed-check + send-race swallow is reused per window.
      fanOutToAllWindows(BrowserWindowValue.getAllWindows(), WORK_BOARD.runProgress, event, {
        logger: log,
      },
      );
    },
    // Self-improvement (Hermes): after a run completes, append a one-line
    // learning to the item's project work memory. appendMemory enforces the
    // hard line cap; the engine fires this swallow-on-error so it never fails a run.
    onRunComplete: ({ itemId, title, projectRoot }) =>
      appendMemory(workBoardStorage, [
        `${new Date().toISOString().slice(0, 10)}: autonomous run completed — #${itemId} ${title}`,
        ],
        projectRoot ? { projectRoot } : undefined,
      ),
    // Persist each run's plan+execute conversation to sessions/<id>/<runId>.jsonl
    // so run context survives restart and accumulates across re-runs.
    transcriptStorage: workBoardStorage,
  });

  // Work Board reporter — host-native daily/weekly reports. Reuses the
  // work-board namespace storage (the same activity.jsonl + memories/ the store
  // writes) and the host one-shot LLM caller wired above.
  const workBoardReporter: WorkBoardReporter = createWorkBoardReporter({
    store: workBoardStore,
    storage: workBoardStorage,
    callLlm: lateBinding.llmCallerRef.fn,
    emit: emitEvent,
  });

  ctx.routineEngine = routineEngine;
  ctx.postTurnHookChain = postTurnHookChain;
  ctx.conversationLoop = conversationLoop;
  ctx.preferenceRefreshService = preferenceRefreshService;
  ctx.memoryConsolidationService = memoryConsolidationService;
  ctx.memoryMaintenanceCoordinator = memoryMaintenanceCoordinator;
  ctx.workBoardEngine = workBoardEngine;
  ctx.workBoardReporter = workBoardReporter;
}
