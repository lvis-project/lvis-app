/**
 * Boot module — shared types + event bus
 *
 * Event handlers live here so every boot/* module publishes/subscribes
 * on the same map. Keeps boot.ts and boot/plugins.ts in sync without a
 * circular dependency.
 */
import type { PluginRuntime, PluginToolInvocationDelegate,
} from "../plugins/runtime.js";
import type { PluginMarketplaceService } from "../plugins/marketplace.js";
import type { SettingsService } from "../data/settings-store.js";
import type { MemoryManager } from "../memory/memory-manager.js";
import type { MemoryCaptureService } from "../memory/memory-capture-service.js";
import type { InputClassifier } from "../core/input-classifier.js";
import type { RouteEngine } from "../core/route-engine.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { SystemPromptBuilder } from "../prompts/system-prompt-builder.js";
import type { McpAppModelContextStore } from "../mcp/mcp-app-model-context.js";
import type { ConversationLoop } from "../engine/conversation-loop.js";
import type { RoutineEngine } from "../routines/routine-engine.js";
import type { McpManager } from "../mcp/mcp-manager.js";
import type { PluginLoopbackManager } from "../mcp/plugin-loopback-manager.js";
import type { IdleSchedulerService } from "../main/idle-scheduler.js";
import type { BashAstValidator } from "../main/bash-ast-validator.js";
import type { AuditService } from "../main/audit-service.js";
import type { AuditLogger } from "../audit/audit-logger.js";
import type { PostTurnHookChain } from "../hooks/post-turn-hook-chain.js";
import type { ApprovalGate } from "../permissions/approval-gate.js";
import type { ApprovalSentenceSelector } from "../permissions/reviewer/approval-sentence-selector.js";
import type { StarredStore } from "../data/starred-store.js";
import type { FeedbackStore } from "../data/feedback-store.js";
import type { TelemetryService } from "../main/telemetry.js";
import type { PluginTelemetryClient } from "../telemetry/client.js";
import type { NotificationService } from "../main/notification-service.js";
import type { PythonRuntimeBootstrapper } from "../main/python-runtime.js";
import type { PreferenceRefreshService } from "../memory/preference-refresh-service.js";
import type { MemoryConsolidationService, MemoryMaintenanceCoordinator } from "../memory/memory-consolidation-service.js";
import type { A2ARemoteRuntime } from "../main/a2a-remote-runtime.js";
import type { RemoteA2AActionController } from "../main/remote-a2a-action-controller.js";
import { createLogger } from "../lib/logger.js";
const log = createLogger("lvis");

export type EventHandler = (data: unknown) => void;

const eventHandlers = new Map<string, Set<EventHandler>>();

export function emitEvent(type: string, data?: unknown): void {
  const handlers = eventHandlers.get(type);
  if (handlers) {
    for (const handler of handlers) {
      try { handler(data); } catch (err) { log.error({ err, eventType: type }, `event handler error (${type})`);
      }
    }
  }
}

/**
 * Subscribe to a host event. Returns an unsubscribe disposer so callers
 * (PluginRuntime.onDisable, test cleanup) can remove handlers
 * deterministically without having to hold onto the original reference.
 */
export function onEvent(type: string, handler: EventHandler): () => void {
  if (!eventHandlers.has(type)) eventHandlers.set(type, new Set());
  eventHandlers.get(type)!.add(handler);
  return () => {
    eventHandlers.get(type)?.delete(handler);
  };
}

export function offEvent(type: string, handler: EventHandler): void {
  eventHandlers.get(type)?.delete(handler);
}

export interface AppServices {
  pythonRuntime?: PythonRuntimeBootstrapper;
  pythonPath?: string;
  pluginRuntime: PluginRuntime;
  pluginMarketplace: PluginMarketplaceService;
  settingsService: SettingsService;
  /** Optional host-owned P4-5 runtime. Absent means both immutable boot gates were OFF. */
  a2aRemoteRuntime?: A2ARemoteRuntime;
  /** Main-owned renderer action boundary; renderer supplies only target id and user intent. */
  remoteA2AActionController?: RemoteA2AActionController;
  memoryManager: MemoryManager;
  /** Host-owned LLM review gate for explicit and automatic long-term memory. */
  memoryCaptureService?: MemoryCaptureService;
  inputClassifier: InputClassifier;
  routeEngine: RouteEngine;
  toolRegistry: ToolRegistry;
  systemPromptBuilder: SystemPromptBuilder;
  /**
   * MCP-app `ui/update-model-context` slots — ONE instance shared by its only two
   * consumers: the gated IPC (`mcp.uiModelContext`) writes a card's slot, and the
   * SystemPromptBuilder's "MCP App Context" source reads the active session's slots at
   * turn build. No push path exists between them, which is precisely why an app context
   * update can never trigger a turn.
   */
  mcpAppModelContext: McpAppModelContextStore;
  conversationLoop: ConversationLoop;
  /**
   * Side-chat (workspace rail) — a SECOND, independently-streaming
   * ConversationLoop with its own history/sessionId and an isolated
   * MemoryManager rooted at `~/.lvis/side-chat/`. Optional: absent in test
   * fixtures that boot only the main loop. Wired in `conversation-wiring.ts`.
   */
  sideChatConversationLoop?: ConversationLoop;
  /**
   * Resolves the loop that owns one tiled chat group.
   *
   * The main area can hold several conversations at once, and a conversation is
   * one ConversationLoop — the loop holds the live history and can run exactly
   * one turn — so N tiles means N loops, not N views of one. Group `"main"`
   * always resolves to {@link conversationLoop}; the rest are created on first
   * use and capped, because an uncapped one would let the window spawn
   * background agents faster than the user can see them.
   *
   * Optional: absent in fixtures that boot only the main loop, where every
   * request is the main group by definition.
   */
  resolveChatGroupLoop?: (chatGroupId: string) => ConversationLoop;
  /** Forgets a group's loop once its tile is gone, so the ceiling counts live tiles only. */
  releaseChatGroupLoop?: (chatGroupId: string) => void;
  /**
   * The loop HOLDING `sessionId` right now, the primary included.
   *
   * A lookup, never a constructor: {@link resolveChatGroupLoop} would build
   * the tile it was asked about, which is the opposite of what a surface
   * asking "whose conversation is this?" means. `undefined` is a real answer —
   * no open conversation holds that session — and callers must treat it as a
   * mismatch rather than reaching for the primary loop.
   *
   * Always wired. Unlike the two above it has no "groups unavailable" answer to
   * stand in for it — a surface that could not ask would read every card as a
   * stale session — so main composition owes it to every consumer.
   */
  findLoopBySessionId: (sessionId: string) => ConversationLoop | undefined;
  /**
   * The loop behind an ALREADY-OPEN chat group, or `undefined` for a group the
   * window is not holding.
   *
   * The lookup half of {@link resolveChatGroupLoop}. A surface that is told
   * which tile the owner meant must not CREATE that tile as a side effect of
   * asking, and a group id it does not recognise is a caller naming a tile that
   * does not exist — a refusal, never the primary loop standing in.
   * Always wired, for the same reason as {@link findLoopBySessionId}.
   */
  findChatGroupLoop: (chatGroupId: string) => ConversationLoop | undefined;
  /**
   * The tiled chat group this bundle is bound to. Set only on the per-group
   * bundle `chat.ts` derives for a non-primary tile; the bundle assembled at
   * boot has none and is the primary's.
   */
  chatGroupId?: string;
  routineEngine?: RoutineEngine;
  mcpManager: McpManager;
  /**
   * Owns each first-party plugin's in-process loopback MCP host. Backs the
   * loopback-first arm of the render IPC's unified `ui://` resolver
   * (`resolveMcpUiBackend`): a plugin's `ui://` card is served here because its
   * `serverId === pluginId` is NEVER in `mcpManager.clients` (external-only).
   */
  pluginLoopbackManager: PluginLoopbackManager;
  pluginBundleLifecycle?: import("../plugins/plugin-bundle-lifecycle.js").PluginBundleLifecycle;
  /**
   * The gated tool-invocation delegate (the plugin-surface `ToolExecutor` →
   * `inspectHostRisk` → reviewer/approval → audit), read LAZILY: it is a late
   * binding installed by the `plugin-tool-executor` boot step, so a consumer
   * registered earlier (the IPC domains) must resolve it per call, not capture it.
   *
   * Sole consumer today: the `oncalltool` IPC's EXTERNAL arm, which runs a foreign
   * MCP server's namespaced registry `Tool` through the same executor the model's
   * calls take. Plugin (loopback) tools do NOT come through here — they keep going
   * through `PluginRuntime.callFromUi`, which installs this same delegate itself.
   */
  getPluginToolInvoker: () => PluginToolInvocationDelegate | null;
  /** Host-owned one-shot grant issuer for a plugin panel mutation. */
  requestPluginOperationGrant: (request: {
    pluginId: string;
    toolName: string;
    input: Record<string, unknown>;
    appSessionId: string;
    origin?: "ui" | "mcp-app";
    expectedGenerationId?: string;
  }) => Promise<{
    operationGrantToken: string;
    grantId: string;
    expiresAt: number;
  }>;
  /** Revoke one plugin-panel session and its read/grant lifecycle state. */
  revokePluginOperationSession: (appSessionId: string) => void;
  /**
   * §FU#259 — artifact store rooted at `userData/mcp-servers/`.
   * Constructed at boot when the marketplace fetcher supports verified
   * downloads; absent when the build uses the disabled fetcher (no
   * marketplace configured) so the MCP install IPC degrades gracefully.
   */
  mcpArtifactStore?: import("../plugins/plugin-artifact-store.js").PluginArtifactStore;
  /** Issue #456 — signed marketplace agent packages extracted under ~/.lvis/agents/. */
  agentArtifactStore?: import("../plugins/plugin-artifact-store.js").PluginArtifactStore;
  /** Issue #456 — signed marketplace skill packages extracted under ~/.lvis/skills/. */
  skillArtifactStore?: import("../plugins/plugin-artifact-store.js").PluginArtifactStore;
  idleScheduler?: IdleSchedulerService;
  preferenceRefreshService?: PreferenceRefreshService;
  memoryConsolidationService?: MemoryConsolidationService;
  memoryMaintenanceCoordinator?: MemoryMaintenanceCoordinator;
  bashAstValidator: BashAstValidator;
  auditService: AuditService;
  /** A3 — structured audit logger (JSONL, ~/.lvis/audit/) */
  auditLogger: AuditLogger;
  postTurnHookChain: PostTurnHookChain;
  /** B1: approval gate, created after mainWindow is ready. */
  approvalGate?: ApprovalGate;
  /** Rebuild Layer 5 reviewer bindings after persisted reviewer settings change. */
  rewireReviewerAgent?: () => void;
  /**
   * Issue #1940 — current `/allow` sentence selector. A GETTER, not the
   * instance: reviewer re-wiring replaces it (a login that finally configures
   * a provider heals it from the no-op stand-in to the live one), and a value
   * captured at IPC-registration time would pin the stand-in forever.
   */
  getApprovalSentenceSelector?: () => ApprovalSentenceSelector | undefined;
  /**
   * Re-apply the live MarketplaceTab settings to the marketplace fetcher
   * constructed at boot. Currently used for the SSRF-guard bypass toggle
   * (`marketplace.cloudAllowPrivateNetwork`) — the field is read
   * per-request on the fetcher, so calling this after a settings patch
   * makes the toggle effective on the next marketplace request without
   * an app restart. No-op for the disabled fetcher.
   */
  refreshMarketplaceFetcherConfig?: () => void;
  /**
   * #893 — Re-sync the plugin runtime's wildcard config overrides. Only the
   * non-secret `hostApiVendor` is projected, and only while an API provider
   * owns generation; subscription runtime selection clears it. Invoked from
   * settings IPC after runtime or API-vendor changes so plugins observe the
   * correct execution identity on their next call without an app restart.
   */
  refreshActiveLlmWildcard?: () => void;
  /**
   * Live-refresh the shared ASRT sandbox network allow-list after a settings
   * change. Recomputes the strict-union (plugin manifest domains ∪ host-resolved
   * DYNAMIC vendor endpoint hostnames — e.g. a reconfigured Azure OpenAI / custom
   * baseUrl) and swaps the live ASRT config so a reconfigured endpoint is
   * enforced/allowed without an app restart. No-op when the sandbox gate is OFF
   * (ASRT never initialized) — there is no live config to update. Invoked from
   * the settings IPC handler when a vendor/endpoint changes.
   */
  refreshSandboxNetworkConfig?: () => Promise<void>;
  /** Starred messages persistence (~/.lvis/sessions/starred.json) */
  starredStore?: StarredStore;
  /** Privacy hardening — feedback persistence separate from audit log (~/.lvis/feedback.jsonl) */
  feedbackStore?: FeedbackStore;
  /** Workflow tools — exposed for IPC handlers + shutdown wiring. */
  routinesStore?: import("../main/routines-store.js").RoutinesStore;
  routinesScheduler?: import("../main/routines-scheduler.js").RoutinesScheduler;
  sessionTasksStore?: import("../main/session-tasks-store.js").SessionTasksStore;
  sessionGoalStore?: import("../main/session-goal-store.js").SessionGoalStore;
  /** Late-bound sub-agent runner lookup for read-only transcript/status IPC surfaces. */
  getSubAgentRunner?: () =>
    | import("../engine/subagent-runner.js").SubAgentRunner | undefined;
  /** Work board persistence (~/.lvis/work-board/board.json) — backs the work-board IPC domain. */
  workBoardStore?: import("../main/work-board-store.js").WorkBoardStore;
  /**
   * Work board agent-orchestration engine — owns the plan→approve→execute run
   * for one item. Wired after the SubAgentRunner exists at boot; reached by the
   * work-board IPC `run` handler and the `work_board_run` LLM tool.
   */
  workBoardEngine?: import("../core/work-board-engine.js").WorkBoardEngine;
  /**
   * Host Work Board reporter (daily / weekly). Constructed at boot after the
   * one-shot LLM caller exists; the work-board IPC domain's `generate-report`
   * channel forwards renderer requests here. Absent ⇒ boot did not construct
   * it (the IPC handler then returns `{ ok: false, error: "no-reporter" }`).
   */
  workBoardReport?: import("../work-board/work-report.js").WorkBoardReporter;
  askUserQuestionGate?: import("../main/ask-user-question-gate.js").AskUserQuestionGate;
  skillStore?: import("../main/skill-store.js").SkillStore;
  agentProfileStore?: import("../main/agent-profile-store.js").AgentProfileStore;
  personaPromptStore?: import("../main/persona-prompt-store.js").PersonaPromptStore;
  /** Rebuild OS notification handlers after plugin install or removal. */
  refreshPluginNotifications?: () => void;
  /** SoT — canonical plugin install/cache paths. */
  pluginPaths?: ReturnType<typeof import("../plugins/plugin-paths.js").resolvePluginPaths>;
  /** Host-owned wipe for persistent plugin auth sessions. */
  clearAuthPartitionService?: (partition: string) => Promise<void>;
  /** Returns the tracked persistent auth partitions for a plugin, including the base partition. */
  listPluginAuthPartitionsService?: (pluginId: string) => string[];
  /** Drops tracked persistent auth partitions after uninstall cleanup completes. */
  forgetPluginAuthPartitionsService?: (pluginId: string) => void | Promise<void>;
  /**
   * Issue 5: Re-register the generic plugin event bridge for a new window.
   * Call on macOS `activate` when a new BrowserWindow is created.
   */
  registerPluginEventBridge?: (win: import("electron").BrowserWindow) => void;
  /**
   * Release-prep — anonymous telemetry service. Retained here so
   * `before-quit` can run a final flush + stop() before the process exits
   * (otherwise queued events are lost on shutdown).
   */
  telemetry?: TelemetryService;
  /**
   * S12 — plugin lifecycle telemetry client (opt-in). Tracks
   * plugin_install / plugin_uninstall / plugin_update / plugin_error events
   * to POST /telemetry/events on the marketplace backend.
   * Never active until the user answers the first-boot consent prompt.
   */
  pluginTelemetry?: PluginTelemetryClient;
  /**
   * Release-prep — auto-updater stop handle. Retained so shutdown can
   * clear the 4h interval deterministically instead of relying on unref().
   */
  autoUpdaterStop?: () => void;
  /** Runs HostApi onShutdown handlers exactly once; shared by normal quit and updater install prep. */
  runPluginShutdownHandlers?: () => Promise<void>;
  /** Central app shutdown hook for timers, background services, and transports. */
  shutdown?: () => Promise<void>;
  /**
   * L1: deferred RoutinesScheduler.start() handle. main.ts calls this AFTER
   * registerIpcHandlers() so a past-due routine firing immediately on boot
   * has a renderer listener attached. Idempotent — safe to call multiple times.
   */
  startRoutinesScheduler?: () => void;
  /**
   * Deferred Work Board due-soon scanner handle. main.ts calls this AFTER
   * registerIpcHandlers() (mirroring startRoutinesScheduler) so the initial
   * scan + the 60-min tick emit `work_board.work_item.due_soon` onto a fully
   * wired plugin bus. The interval is cleared in `shutdown()`.
   */
  startWorkBoardDueSoon?: () => void;
  /**
   * Issue #260 — system-level notification service. Auto-fires desktop
   * notifications at lifecycle points (turn-end / routine / ask-user /
   * approval / plugin / system). Constructed AFTER main window exists in boot.ts. The LLM never
   * sees this — it's a passive surface called by the host at trigger sites.
   */
  notificationService?: NotificationService;
  /**
   * Permission policy P4 — Layer 6 hook system runtime. Holds the trusted-hook list
   * resolved from `~/.config/lvis/hooks/` after boot-time hash verification
   * and any explicit `/permission hooks accept <name>` command. Executor /
   * approval-gate consult this for pre/post/perm hooks. Absent when the hooks
   * directory cannot be created (rare).
   */
  scriptHookManager?: import("../hooks/script-hook-manager.js").ScriptHookManager;
}
