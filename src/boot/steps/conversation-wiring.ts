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
import { broadcastPermissionConfigChanged as broadcastPermissionConfigChangedFromIpc } from "../../ipc/domains/permissions.js";
import { PreferenceRefreshService } from "../../memory/preference-refresh-service.js";
import { SubAgentRunner } from "../../engine/subagent-runner.js";
import { createWorkBoardEngine, type WorkBoardEngine } from "../../core/work-board-engine.js";
import { createWorkBoardReporter, type WorkBoardReporter } from "../../work-board/work-report.js";
import { appendMemory } from "../../work-board/work-memory.js";
import { WORK_BOARD } from "../../shared/ipc-channels.js";
import { fanOutToAllWindows } from "../../ipc/broadcast-helpers.js";
import { emitEvent } from "../types.js";
import { createLogger } from "../../lib/logger.js";
import type { BootContext } from "../context.js";

const log = createLogger("lvis");

export function wireConversation(ctx: BootContext): void {
  const {
    settingsService,
    systemPromptBuilder,
    keywordEngine,
    routeEngine,
    toolRegistry,
    memoryManager,
    permissionManager,
    approvalGate,
    hookRunner,
    scriptHookManager,
    bashAstValidator,
    pluginRuntime,
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
  } = ctx;

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
    approvalGate,
    hookRunner,
    scriptHookManager,
    bashAstValidator,
    pluginRuntime,
    auditLogger: bootAuditLogger,
    llmFetch,
  };
  const routineEngine = createRoutineEngine({
    createConversationLoop: (input) => createRoutineConversationLoop(
      routineLoopDeps,
      { scope: input.scope },
    ),
    // Permission policy Layer 4 — snapshot the live plugin runtime's active id set so
    // routines with `scope.pluginIds.mode === "inherit"` are normalized
    // to a concrete allow-list at fire time (never at loop-construction).
    getActivePluginIds: () => pluginRuntime.listPluginIds(),
  });

  // §4.2 Step 7: manifest-driven IPC bridges. Plugin notifications route
  // through `notificationService` (#841) so they inherit the same focus
  // gate, cooldown, sanitization, and audit policy as the host's lifecycle
  // notifications.
  ctx.disposePluginNotifications = registerPluginNotifications(pluginRuntime, mainWindow, notificationService, bootAuditLogger);
  ctx.disposePluginEventBridge = registerPluginEventBridge(pluginRuntime, mainWindow);
  ctx.pluginEventBridgeWindow = mainWindow;
  ctx.replacePluginEventBridge = (win: BrowserWindow) => {
    ctx.pluginEventBridgeWindow = win;
    ctx.disposePluginEventBridge();
    ctx.disposePluginEventBridge = registerPluginEventBridge(pluginRuntime, win);
  };

  // §4.5 + Agent 6: PostTurnHookChain.
  const { postTurnHookChain } = createPostTurnHookChain({
    memoryManager,
    idleScheduler,
    settingsService,
    auditLogger: bootAuditLogger,
    sessionTodoStore,
  });

  // ApprovalGate already constructed above (before initPluginRuntime) so the
  // plugin HostApi factory could wire `agentApproval` to the live gate.
  // approvalGateRef was bound at construction time.

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
    scriptHookManager,
    getAdditionalDirectories: () => readPermissionSettings().permissions.additionalDirectories,
    // Round-3 fix: dialog-driven session-add grants must broadcast so
    // multi-window PermissionsTab refreshes. Boot owns getMainWindow
    // and forwards it to the broadcaster declared in the permissions
    // IPC domain — no engine→ipc coupling, just a callback handed down.
    broadcastPermissionConfigChanged: () => {
      broadcastPermissionConfigChangedFromIpc({ getMainWindow, getAppWindows: () => BrowserWindowValue.getAllWindows() } as Parameters<typeof broadcastPermissionConfigChangedFromIpc>[0]);
    },
    pluginRuntime,
    skillOverlay,
    sessionTodoStore,
    notificationService,
    auditLogger: bootAuditLogger,
    rewireReviewerAgent,
    llmFetch,
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
  const sideChatMemoryManager = new MemoryManager({
    lvisDir: openFeatureNamespace("side-chat").dir,
  });
  sideChatMemoryManager.load();
  const sideChatConversationLoop = createSideChatConversationLoop({
    settingsService,
    keywordEngine,
    routeEngine,
    toolRegistry,
    permissionManager,
    approvalGate,
    hookRunner,
    scriptHookManager,
    bashAstValidator,
    pluginRuntime,
    auditLogger: bootAuditLogger,
    llmFetch,
    sideChatMemoryManager,
    getAdditionalDirectories: () => readPermissionSettings().permissions.additionalDirectories,
  });
  ctx.sideChatConversationLoop = sideChatConversationLoop;

  // Late-binding 주입 — ConversationLoop 생성 직후.
  lateBinding.conversationLoopRef.fn = conversationLoop;
  lateBinding.llmCallerRef.fn = createCallLlm(conversationLoop);
  lateBinding.pluginCallLlmRef.fn = createCallLlmForPlugin(conversationLoop, bootAuditLogger);
  log.info("boot: plugin callLlm ready (rate-limited)");

  const preferenceRefreshService = new PreferenceRefreshService({
    memoryManager,
    generateText: lateBinding.llmCallerRef.fn,
    idleScheduler,
    isIdleRefreshEnabled: () => settingsService.get("features")?.idlePreferenceRefresh ?? true,
  });
  preferenceRefreshService.start();

  // Sub-agent runs persist to an ISOLATED MemoryManager rooted at
  // `~/.lvis/subagent/` (resolved via openFeatureNamespace, the storage-
  // namespace SOT — no hand-rolled mkdir/mode bits). Reusing the main
  // `memoryManager` here is exactly what leaked orphan sub-agent JSONL into
  // the main `~/.lvis/sessions/` list; a dedicated store keeps sub-agent
  // transcripts out of `chat.sessions` and gives same-instance resume its own
  // addressable namespace. Mirrors the sideChatMemoryManager wiring above.
  const subAgentMemoryManager = new MemoryManager({
    lvisDir: openFeatureNamespace("subagent").dir,
  });
  subAgentMemoryManager.load();

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
      scriptHookManager,
      auditLogger: bootAuditLogger,
      getAdditionalDirectories: () => readPermissionSettings().permissions.additionalDirectories,
      rewireReviewerAgent,
      llmFetch,
    },
    toolRegistry,
    subAgentMemoryManager,
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
      });
    },
    // Self-improvement (Hermes): after a run completes, append a one-line
    // learning to the work-board MEMORY.md. appendMemory enforces the hard
    // line cap; the engine fires this swallow-on-error so it never fails a run.
    onRunComplete: ({ itemId, title }) =>
      appendMemory(workBoardStorage, [
        `${new Date().toISOString().slice(0, 10)}: 자율 실행 완료 — #${itemId} ${title}`,
      ]),
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
  ctx.workBoardEngine = workBoardEngine;
  ctx.workBoardReporter = workBoardReporter;
}
