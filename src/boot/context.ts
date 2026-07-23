/**
 * BootContext — the accumulator threaded through the boot pipeline (C18).
 *
 * `bootstrap()` builds a staged context from its inputs, then hands it to the
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
 * pattern initialises them progressively, then an exhaustive own-property gate
 * proves every producer ran before assembly (see {@link createBootContext}).
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
import type { RationaleScopeReviewer } from "../permissions/reviewer/rationale-scope-reviewer.js";
import type { RationaleHostService } from "../tools/pipeline/rationale-host-service.js";
import type { A2ARemoteRuntime } from "../main/a2a-remote-runtime.js";
import type { RemoteA2AActionController } from "../main/remote-a2a-action-controller.js";
import type { PluginBundleLifecycle } from "../plugins/plugin-bundle-lifecycle.js";

type PluginPaths = ReturnType<typeof import("../plugins/plugin-paths.js").resolvePluginPaths>;
type WorkBoardStorage = ReturnType<typeof import("../work-board/storage.js").createDirStorage>;

export interface BootContextInputs {
  projectRoot: string;
  mainWindow: BrowserWindow;
  getMainWindow: () => BrowserWindow | null;
}

export class BootContext {
  // ── Inputs (available immediately) ─────────────────────────────────────────
  declare readonly projectRoot: string;
  declare readonly mainWindow: BrowserWindow;
  declare readonly getMainWindow: () => BrowserWindow | null;

  // ── Network fetch surface (setupNetworkFetch) ──────────────────────────────
  declare networkFetch: typeof fetch;
  declare pluginNetworkFetch: typeof fetch;
  declare llmFetch: typeof fetch;

  // ── Home docs seed ─────────────────────────────────────────────────────────
  declare lvisHomeDocUpgradeMarkers: LvisHomeDocUpgradeMarker[];

  // ── Core services (bootstrapCoreServices) ──────────────────────────────────
  declare pythonPath: string | undefined;
  declare pythonRuntime: PythonRuntimeBootstrapper;
  declare bashAstValidator: BashAstValidator;
  declare auditService: AuditService;
  declare settingsService: SettingsService;
  declare a2aRemoteRuntime: A2ARemoteRuntime | undefined;
  declare remoteA2AActionController: RemoteA2AActionController | undefined;
  declare memoryManager: MemoryManager;
  declare keywordEngine: KeywordEngine;
  declare toolRegistry: ToolRegistry;
  declare routeEngine: RouteEngine;

  // ── Audit + notification (setupAuditAndNotification) ───────────────────────
  declare bootAuditLogger: AuditLogger;
  declare notificationService: NotificationService;

  // ── Approval / permission / routines (pre-plugin-runtime) ──────────────────
  declare approvalGate: ApprovalGate;
  declare permissionManager: PermissionManager;
  declare routinesStore: RoutinesStore;

  // ── Plugin runtime (initPluginRuntime) ─────────────────────────────────────
  declare pluginRuntime: PluginRuntime;
  declare deploymentGuard: PluginDeploymentGuard;
  declare lateBinding: LateBindingRefs;
  declare runPluginShutdownHandlers: () => Promise<void>;
  declare pluginPaths: PluginPaths;

  // ── Workflow services + stores ─────────────────────────────────────────────
  declare routinesScheduler: RoutinesScheduler;
  declare workBoardStore: WorkBoardStore;
  declare workBoardStorage: WorkBoardStorage;
  declare dueSoonTimer: ReturnType<typeof setInterval> | undefined;
  declare startWorkBoardDueSoon: () => void;
  declare sessionTodoStore: SessionTodoStore;
  declare skillStore: SkillStore;
  declare agentProfileStore: AgentProfileStore;
  declare personaPromptStore: PersonaPromptStore;
  declare skillOverlay: SkillOverlay;
  declare skillApprovalsStore: SkillApprovalsStore;
  declare askUserQuestionGate: AskUserQuestionGate;
  declare subAgentRunnerRef: { fn: SubAgentRunner | undefined };
  declare idleScheduler: IdleSchedulerService | undefined;
  declare knowledgeAvailable: boolean;

  // ── Marketplace (setupMarketplace) ─────────────────────────────────────────
  declare marketplaceFetcher: MarketplaceFetcher;
  declare pluginMarketplace: PluginMarketplaceService;
  declare refreshMarketplaceFetcherConfig: () => void;
  declare refreshActiveLlmWildcard: () => void;
  declare refreshSandboxNetworkConfig: () => void;
  declare buildSandboxUnionDomains: () => Promise<string[]>;

  // ── Prompt / reviewer wiring ───────────────────────────────────────────────
  declare systemPromptBuilder: SystemPromptBuilder;
  /**
   * MCP-app `ui/update-model-context` slots. ONE instance, two consumers, and that is the
   * whole design: the gated IPC WRITES a card's slot, and the SystemPromptBuilder source
   * READS the active session's slots at turn build. Nothing pushes.
   */
  declare mcpAppModelContext: McpAppModelContextStore;
  declare rationaleScopeReviewer: RationaleScopeReviewer;
  declare rationaleHostService: RationaleHostService | undefined;
  declare rewireReviewerAgent: () => void;

  // ── Hooks + plugin tool execution surface ──────────────────────────────────
  declare hookRunner: HookRunner;
  declare scriptHookManager: ScriptHookManager;
  declare pluginBundleLifecycle: PluginBundleLifecycle | undefined;
  declare requestPluginOperationGrant: (request: {
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
  declare revokePluginOperationGeneration: (pluginId: string, generationId: string) => void;

  // ── Conversation / agent loop ──────────────────────────────────────────────
  declare routineEngine: RoutineEngine;
  declare postTurnHookChain: PostTurnHookChain;
  declare conversationLoop: ConversationLoop;
  /** Side-chat (workspace rail) — 2nd loop with isolated `~/.lvis/side-chat/` store. */
  declare sideChatConversationLoop: ConversationLoop;
  declare preferenceRefreshService: PreferenceRefreshService;
  declare workBoardEngine: WorkBoardEngine;
  declare workBoardReporter: WorkBoardReporter;

  // ── Plugin IPC bridges (mutable disposers) ─────────────────────────────────
  declare disposePluginNotifications: () => void;
  declare disposePluginEventBridge: () => void;
  declare pluginEventBridgeWindow: BrowserWindow;
  declare replacePluginEventBridge: (win: BrowserWindow) => void;

  // ── MCP + signed-artifact stores ───────────────────────────────────────────
  declare mcpGovernance: McpGovernance;
  declare mcpManager: McpManager;
  /** Owns each plugin's loopback MCP host — the loopback-first arm of the render IPC's `ui://` resolver. */
  declare pluginLoopbackManager: PluginLoopbackManager;
  declare mcpArtifactStore: PluginArtifactStore | undefined;
  declare agentArtifactStore: PluginArtifactStore | undefined;
  declare skillArtifactStore: PluginArtifactStore | undefined;

  // ── Starred / feedback ─────────────────────────────────────────────────────
  declare starredStore: StarredStore;
  declare feedbackStore: FeedbackStore;

  // ── Post-boot release prep ─────────────────────────────────────────────────
  declare telemetry: TelemetryService | undefined;
  declare pluginTelemetry: PluginTelemetryClient | undefined;
  declare autoUpdaterStop: (() => void) | undefined;

  constructor(inputs: BootContextInputs) {
    this.projectRoot = inputs.projectRoot;
    this.mainWindow = inputs.mainWindow;
    this.getMainWindow = inputs.getMainWindow;
    this.dueSoonTimer = undefined;
  }
}

const BOOT_CONTEXT_FIELDS = [
  "projectRoot",
  "mainWindow",
  "getMainWindow",
  "networkFetch",
  "pluginNetworkFetch",
  "llmFetch",
  "lvisHomeDocUpgradeMarkers",
  "pythonPath",
  "pythonRuntime",
  "bashAstValidator",
  "auditService",
  "settingsService",
  "a2aRemoteRuntime",
  "remoteA2AActionController",
  "memoryManager",
  "keywordEngine",
  "toolRegistry",
  "routeEngine",
  "bootAuditLogger",
  "notificationService",
  "approvalGate",
  "permissionManager",
  "routinesStore",
  "pluginRuntime",
  "deploymentGuard",
  "lateBinding",
  "runPluginShutdownHandlers",
  "pluginPaths",
  "routinesScheduler",
  "workBoardStore",
  "workBoardStorage",
  "dueSoonTimer",
  "startWorkBoardDueSoon",
  "sessionTodoStore",
  "skillStore",
  "agentProfileStore",
  "personaPromptStore",
  "skillOverlay",
  "skillApprovalsStore",
  "askUserQuestionGate",
  "subAgentRunnerRef",
  "idleScheduler",
  "knowledgeAvailable",
  "marketplaceFetcher",
  "pluginMarketplace",
  "refreshMarketplaceFetcherConfig",
  "refreshActiveLlmWildcard",
  "refreshSandboxNetworkConfig",
  "buildSandboxUnionDomains",
  "systemPromptBuilder",
  "mcpAppModelContext",
  "rationaleScopeReviewer",
  "rationaleHostService",
  "rewireReviewerAgent",
  "hookRunner",
  "scriptHookManager",
  "pluginBundleLifecycle",
  "requestPluginOperationGrant",
  "revokePluginOperationGeneration",
  "routineEngine",
  "postTurnHookChain",
  "conversationLoop",
  "sideChatConversationLoop",
  "preferenceRefreshService",
  "workBoardEngine",
  "workBoardReporter",
  "disposePluginNotifications",
  "disposePluginEventBridge",
  "pluginEventBridgeWindow",
  "replacePluginEventBridge",
  "mcpGovernance",
  "mcpManager",
  "pluginLoopbackManager",
  "mcpArtifactStore",
  "agentArtifactStore",
  "skillArtifactStore",
  "starredStore",
  "feedbackStore",
  "telemetry",
  "pluginTelemetry",
  "autoUpdaterStop",
] as const satisfies readonly (keyof BootContext)[];

type MissingBootContextField = Exclude<keyof BootContext, typeof BOOT_CONTEXT_FIELDS[number]>;
const bootContextFieldListIsExhaustive: MissingBootContextField extends never ? true : never = true;
void bootContextFieldListIsExhaustive;

declare const READY_BOOT_CONTEXT: unique symbol;
export type ReadyBootContext = BootContext & { readonly [READY_BOOT_CONTEXT]: true };

/**
 * Convert the mutable boot accumulator into the only context assembly accepts.
 * Own-property checks distinguish a step that explicitly produced `undefined`
 * (valid for optional services) from a step that never produced its field.
 */
export function assertBootContextReady(ctx: BootContext): asserts ctx is ReadyBootContext {
  const missing = BOOT_CONTEXT_FIELDS.filter((field) => !Object.hasOwn(ctx, field));
  if (missing.length > 0) {
    throw new Error(`boot-context-incomplete: missing ${missing.join(", ")}`);
  }
}

/**
 * Build the typed accumulator from the immediately-available inputs. Remaining
 * fields are declared staged slots and become own properties only when their
 * producing step assigns them. {@link assertBootContextReady} validates that
 * every producer ran before the context crosses into service assembly.
 */
export function createBootContext(inputs: BootContextInputs): BootContext {
  return new BootContext(inputs);
}
