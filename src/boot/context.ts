/**
 * BootContext — the accumulator threaded through the boot pipeline (C18).
 *
 * `bootstrap()` builds an empty context from its inputs, then hands it to the
 * ordered boot steps under `src/boot/steps/*`. Each step READS the services
 * built by prior steps and WRITES its own outputs back onto the same object.
 * `assembleAppServices(ctx)` reads the fully-populated context at the end to
 * build the returned {@link AppServices} literal.
 *
 * The context deliberately holds BOTH the fields that survive into AppServices
 * and the boot-only locals a later step needs (deploymentGuard, marketplace
 * fetcher, the mutable IPC-bridge disposers, late-binding refs, …). Fields are
 * declared required unless they are genuinely optional in a successful boot
 * (`pythonPath`, the signed-artifact stores, the due-soon timer, release-prep
 * handles) so step bodies can read them without non-null noise; the accumulator
 * pattern initialises them progressively (see {@link createBootContext}).
 */
import type { BrowserWindow } from "electron";
import type { LvisHomeDocUpgradeMarker } from "../main/seed-lvis-home-docs.js";
import type { PythonRuntimeBootstrapper } from "../main/python-runtime.js";
import type { BashAstValidator } from "../main/bash-ast-validator.js";
import type { AuditService } from "../main/audit-service.js";
import type { SettingsService } from "../data/settings-store.js";
import type { MemoryManager } from "../memory/memory-manager.js";
import type { KeywordEngine } from "../core/keyword-engine.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { RouteEngine } from "../core/route-engine.js";
import type { AuditLogger } from "../audit/audit-logger.js";
import type { NotificationService } from "../main/notification-service.js";
import type { ApprovalGate } from "../permissions/approval-gate.js";
import type { PermissionManager } from "../permissions/permission-manager.js";
import type { RoutinesStore } from "../main/routines-store.js";
import type { RoutinesScheduler } from "../main/routines-scheduler.js";
import type { PluginRuntime } from "../plugins/runtime.js";
import type { PluginDeploymentGuard } from "../plugins/deployment-guard.js";
import type { LateBindingRefs } from "./steps/plugin-runtime.js";
import type { WorkBoardStore } from "../main/work-board-store.js";
import type { WorkBoardEngine } from "../core/work-board-engine.js";
import type { WorkBoardReporter } from "../work-board/work-report.js";
import type { SessionTodoStore } from "../main/session-todo-store.js";
import type { SkillStore } from "../main/skill-store.js";
import type { AgentProfileStore } from "../main/agent-profile-store.js";
import type { PersonaPromptStore } from "../main/persona-prompt-store.js";
import type { SkillOverlay } from "../main/skill-overlay.js";
import type { SkillApprovalsStore } from "../main/skill-approvals-store.js";
import type { AskUserQuestionGate } from "../main/ask-user-question-gate.js";
import type { SubAgentRunner } from "../engine/subagent-runner.js";
import type { IdleSchedulerService } from "../main/idle-scheduler.js";
import type { MarketplaceFetcher, PluginMarketplaceService } from "../plugins/marketplace.js";
import type { PluginArtifactStore } from "../plugins/plugin-artifact-store.js";
import type { SystemPromptBuilder } from "../prompts/system-prompt-builder.js";
import type { McpAppModelContextStore } from "../mcp/mcp-app-model-context.js";
import type { RoutineEngine } from "../core/routine-engine.js";
import type { PostTurnHookChain } from "../hooks/post-turn-hook-chain.js";
import type { ConversationLoop } from "../engine/conversation-loop.js";
import type { PreferenceRefreshService } from "../memory/preference-refresh-service.js";
import type { McpManager } from "../mcp/mcp-manager.js";
import type { PluginLoopbackManager } from "../mcp/plugin-loopback-manager.js";
import type { McpGovernance } from "../mcp/mcp-governance.js";
import type { StarredStore } from "../data/starred-store.js";
import type { FeedbackStore } from "../data/feedback-store.js";
import type { TelemetryService } from "../main/telemetry.js";
import type { PluginTelemetryClient } from "../telemetry/client.js";
import type { HookRunner } from "../hooks/hook-runner.js";
import type { ScriptHookManager } from "../hooks/script-hook-manager.js";

type PluginPaths = ReturnType<typeof import("../plugins/plugin-paths.js").resolvePluginPaths>;
type WorkBoardStorage = ReturnType<typeof import("../work-board/storage.js").createDirStorage>;

export interface BootContext {
  // ── Inputs (available immediately) ─────────────────────────────────────────
  readonly projectRoot: string;
  readonly mainWindow: BrowserWindow;
  readonly getMainWindow: () => BrowserWindow | null;

  // ── Network fetch surface (setupNetworkFetch) ──────────────────────────────
  networkFetch: typeof fetch;
  privateNetworkFetch: typeof fetch;
  pluginNetworkFetch: typeof fetch;
  llmFetch: typeof fetch;

  // ── Home docs seed ─────────────────────────────────────────────────────────
  lvisHomeDocUpgradeMarkers: LvisHomeDocUpgradeMarker[];

  // ── Core services (bootstrapCoreServices) ──────────────────────────────────
  pythonPath: string | undefined;
  pythonRuntime: PythonRuntimeBootstrapper;
  bashAstValidator: BashAstValidator;
  auditService: AuditService;
  settingsService: SettingsService;
  memoryManager: MemoryManager;
  keywordEngine: KeywordEngine;
  toolRegistry: ToolRegistry;
  routeEngine: RouteEngine;

  // ── Audit + notification (setupAuditAndNotification) ───────────────────────
  bootAuditLogger: AuditLogger;
  notificationService: NotificationService;

  // ── Approval / permission / routines (pre-plugin-runtime) ──────────────────
  approvalGate: ApprovalGate;
  permissionManager: PermissionManager;
  routinesStore: RoutinesStore;

  // ── Plugin runtime (initPluginRuntime) ─────────────────────────────────────
  pluginRuntime: PluginRuntime;
  deploymentGuard: PluginDeploymentGuard;
  lateBinding: LateBindingRefs;
  runPluginShutdownHandlers: () => Promise<void>;
  pluginPaths: PluginPaths;

  // ── Workflow services + stores ─────────────────────────────────────────────
  routinesScheduler: RoutinesScheduler;
  workBoardStore: WorkBoardStore;
  workBoardStorage: WorkBoardStorage;
  dueSoonTimer: ReturnType<typeof setInterval> | undefined;
  startWorkBoardDueSoon: () => void;
  sessionTodoStore: SessionTodoStore;
  skillStore: SkillStore;
  agentProfileStore: AgentProfileStore;
  personaPromptStore: PersonaPromptStore;
  skillOverlay: SkillOverlay;
  skillApprovalsStore: SkillApprovalsStore;
  askUserQuestionGate: AskUserQuestionGate;
  subAgentRunnerRef: { fn: SubAgentRunner | undefined };
  idleScheduler: IdleSchedulerService | undefined;
  knowledgeAvailable: boolean;

  // ── Marketplace (setupMarketplace) ─────────────────────────────────────────
  marketplaceFetcher: MarketplaceFetcher;
  pluginMarketplace: PluginMarketplaceService;
  refreshMarketplaceFetcherConfig: () => void;
  refreshActiveLlmWildcard: () => void;
  refreshSandboxNetworkConfig: () => void;
  buildSandboxUnionDomains: () => Promise<string[]>;

  // ── Prompt / reviewer wiring ───────────────────────────────────────────────
  systemPromptBuilder: SystemPromptBuilder;
  /**
   * MCP-app `ui/update-model-context` slots. ONE instance, two consumers, and that is the
   * whole design: the gated IPC WRITES a card's slot, and the SystemPromptBuilder source
   * READS the active session's slots at turn build. Nothing pushes.
   */
  mcpAppModelContext: McpAppModelContextStore;
  rewireReviewerAgent: () => void;

  // ── Hooks + plugin tool execution surface ──────────────────────────────────
  hookRunner: HookRunner;
  scriptHookManager: ScriptHookManager;

  // ── Conversation / agent loop ──────────────────────────────────────────────
  routineEngine: RoutineEngine;
  postTurnHookChain: PostTurnHookChain;
  conversationLoop: ConversationLoop;
  /** Side-chat (workspace rail) — 2nd loop with isolated `~/.lvis/side-chat/` store. */
  sideChatConversationLoop: ConversationLoop;
  preferenceRefreshService: PreferenceRefreshService;
  workBoardEngine: WorkBoardEngine;
  workBoardReporter: WorkBoardReporter;

  // ── Plugin IPC bridges (mutable disposers) ─────────────────────────────────
  disposePluginNotifications: () => void;
  disposePluginEventBridge: () => void;
  pluginEventBridgeWindow: BrowserWindow;
  replacePluginEventBridge: (win: BrowserWindow) => void;

  // ── MCP + signed-artifact stores ───────────────────────────────────────────
  mcpGovernance: McpGovernance;
  mcpManager: McpManager;
  /** Owns each plugin's loopback MCP host — the loopback-first arm of the render IPC's `ui://` resolver. */
  pluginLoopbackManager: PluginLoopbackManager;
  mcpArtifactStore: PluginArtifactStore | undefined;
  agentArtifactStore: PluginArtifactStore | undefined;
  skillArtifactStore: PluginArtifactStore | undefined;

  // ── Starred / feedback ─────────────────────────────────────────────────────
  starredStore: StarredStore;
  feedbackStore: FeedbackStore;

  // ── Post-boot release prep ─────────────────────────────────────────────────
  telemetry: TelemetryService | undefined;
  pluginTelemetry: PluginTelemetryClient | undefined;
  autoUpdaterStop: (() => void) | undefined;
}

/**
 * Build the initial BootContext from the immediately-available inputs. The
 * remaining fields are populated by the ordered boot steps; this factory casts
 * the partial to {@link BootContext} because the accumulator is filled in over
 * the course of `bootstrap()` (the same well-known pattern used for staged
 * dependency graphs — no field is read before its producing step runs).
 */
export function createBootContext(inputs: {
  projectRoot: string;
  mainWindow: BrowserWindow;
  getMainWindow: () => BrowserWindow | null;
}): BootContext {
  return {
    projectRoot: inputs.projectRoot,
    mainWindow: inputs.mainWindow,
    getMainWindow: inputs.getMainWindow,
    // Initialised so the shutdown handle can clear it even if the due-soon
    // scanner was never started.
    dueSoonTimer: undefined,
  } as BootContext;
}
