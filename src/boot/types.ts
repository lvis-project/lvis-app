/**
 * Boot module — shared types + event bus
 *
 * Event handlers live here so every boot/* module publishes/subscribes
 * on the same map. Keeps boot.ts and boot/plugins.ts in sync without a
 * circular dependency.
 */
import type { PluginRuntime } from "../plugins/runtime.js";
import type { PluginMarketplaceService } from "../plugins/marketplace.js";
import type { SettingsService } from "../data/settings-store.js";
import type { MemoryManager } from "../memory/memory-manager.js";
import type { KeywordEngine } from "../core/keyword-engine.js";
import type { RouteEngine } from "../core/route-engine.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { SystemPromptBuilder } from "../prompts/system-prompt-builder.js";
import type { ConversationLoop } from "../engine/conversation-loop.js";
import type { RoutineEngine } from "../core/routine-engine.js";
import type { McpManager } from "../mcp/mcp-manager.js";
import type { IdleSchedulerService } from "../main/idle-scheduler.js";
import type { BashAstValidator } from "../main/bash-ast-validator.js";
import type { AuditService } from "../main/audit-service.js";
import type { AuditLogger } from "../audit/audit-logger.js";
import type { PostTurnHookChain } from "../hooks/post-turn-hook-chain.js";
import type { ApprovalGate } from "../permissions/approval-gate.js";
import type { StarredStore } from "../data/starred-store.js";
import type { FeedbackStore } from "../data/feedback-store.js";
import type { TelemetryService } from "../main/telemetry.js";
import type { PluginTelemetryClient } from "../telemetry/client.js";
import type { NotificationService } from "../main/notification-service.js";
import type { PythonRuntimeBootstrapper } from "../main/python-runtime.js";
import type { PreferenceRefreshService } from "../memory/preference-refresh-service.js";
import { createLogger } from "../lib/logger.js";
const log = createLogger("lvis");

export type EventHandler = (data: unknown) => void;

const eventHandlers = new Map<string, Set<EventHandler>>();

export function emitEvent(type: string, data?: unknown): void {
  const handlers = eventHandlers.get(type);
  if (handlers) {
    for (const handler of handlers) {
      try { handler(data); } catch (err) { log.error({ err, eventType: type }, `event handler error (${type})`); }
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
  memoryManager: MemoryManager;
  keywordEngine: KeywordEngine;
  routeEngine: RouteEngine;
  toolRegistry: ToolRegistry;
  systemPromptBuilder: SystemPromptBuilder;
  conversationLoop: ConversationLoop;
  routineEngine?: RoutineEngine;
  mcpManager: McpManager;
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
  bashAstValidator: BashAstValidator;
  auditService: AuditService;
  /** A3 — structured audit logger (JSONL, ~/.lvis/audit/) */
  auditLogger: AuditLogger;
  postTurnHookChain: PostTurnHookChain;
  /** B1: 승인 게이트 — mainWindow 준비 후 생성 */
  approvalGate?: ApprovalGate;
  /** Rebuild Layer 5 reviewer bindings after persisted reviewer settings change. */
  rewireReviewerAgent?: () => void;
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
   * #893 — Re-sync the plugin runtime's wildcard config overrides
   * (`hostApiKey` / `hostApiVendor`) against the current active LLM
   * vendor's apiKey. Invoked from the settings IPC handler after the
   * vendor changes or an apiKey is set/deleted, so plugins reading
   * `hostApi.config.get("hostApiKey")` observe the new value on their
   * next call without an app restart.
   */
  refreshActiveLlmWildcard?: () => void;
  /** Whether knowledge search tools were successfully registered. */
  knowledgeAvailable: boolean;
  /** Starred messages persistence (~/.lvis/starred.json) */
  starredStore?: StarredStore;
  /** Privacy hardening — feedback persistence separate from audit log (~/.lvis/feedback.jsonl) */
  feedbackStore?: FeedbackStore;
  /** Workflow tools — exposed for IPC handlers + shutdown wiring. */
  routinesStore?: import("../main/routines-store.js").RoutinesStore;
  routinesScheduler?: import("../main/routines-scheduler.js").RoutinesScheduler;
  sessionTodoStore?: import("../main/session-todo-store.js").SessionTodoStore;
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
  /** 플러그인 설치/제거 후 OS 알림 핸들러를 재구성한다. */
  refreshPluginNotifications?: () => void;
  /** SoT — canonical plugin install/cache paths. */
  pluginPaths?: ReturnType<typeof import("../plugins/plugin-paths.js").resolvePluginPaths>;
  /** Host-owned wipe for persistent plugin auth sessions. */
  clearAuthPartitionService?: (partition: string) => Promise<void>;
  /** Returns the tracked persistent auth partitions for a plugin, including the base partition. */
  listPluginAuthPartitionsService?: (pluginId: string) => string[];
  /** Drops tracked persistent auth partitions after uninstall cleanup completes. */
  forgetPluginAuthPartitionsService?: (pluginId: string) => void;
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
   * scan + the 60-min tick emit `agent_hub.work_item.due_soon` onto a fully
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
