// Types extracted from src/renderer.tsx.
// Pure type declarations — no React runtime, no hook state, no side effects.

import type { PluginUiExtensionView } from "../../plugin-ui-host.js";
import type {
  AgentInstallResultPayload,
  PluginInstallResultPayload,
  SkillInstallResultPayload,
} from "../../contract/app-contract.js";
import type { ChatStreamEvent, ChatEntry } from "../../lib/chat-stream-state.js";
import type { AgentSpawnEvent } from "../../shared/subagent-events.js";
import type { McpResourceSummary, McpResourceTemplateSummary, McpServerConfig, McpServerConfigDto, McpServerState, McpUiResourceBundle, McpUiToolCallOutcome } from "../../mcp/types.js";
import type { McpUiMessageOutcome } from "../../mcp/mcp-ui-message.js";
import type { McpUiDownloadOutcome } from "../../mcp/mcp-app-download.js";
import type { McpUiModelContextOutcome } from "../../mcp/mcp-app-model-context.js";
import type { SerializedHistoryMessage } from "../../shared/chat-history.js";
import type { PluginConfigRecord } from "../../shared/plugin-config.js";
import type { MarketplaceInstalledProviderPreset } from "../../shared/marketplace-package-assets.js";
import type {
  CodexSubscriptionActionResult,
  CodexSubscriptionDeviceCodeResult,
  CodexSubscriptionModelsResult,
} from "../../shared/codex-subscription.js";
import type {
  AcpSubscriptionActionResult,
  AcpSubscriptionProviderId,
} from "../../shared/acp-subscription.js";
import type {
  SubscriptionLoginMethod,
  SubscriptionRuntimeActionResult,
  SubscriptionRuntimeErrorCode,
  SubscriptionRuntimeId,
  SubscriptionRuntimeModelsResult,
  SubscriptionUsageSource,
  SubscriptionRuntimeStatusUpdatedEvent,
} from "../../shared/subscription-runtime.js";
import type { ChatSendInputOrigin } from "../../shared/chat-origin.js";
import type { TailnetSharingOwnerApi } from "../../shared/tailnet-sharing.js";
import type { TailnetObserverConfigApi } from "../../shared/tailnet-observer-config.js";
import type { TelegramConnectionOwnerApi } from "../../shared/telegram-connection.js";
import type { AwayAuthorityOwnerApi } from "../../shared/away-authority-arm.js";
import type { RolePreset } from "../../data/role-presets.js";
import type { PermissionEvaluationContext as PermissionEvaluationContextShape } from "../../permissions/evaluation-context.js";
import type { ToolCategory, ToolSource, RiskLevel, DeferredGrantScope } from "../../shared/permission-review-status.js";
import type {
  AssistantAgentSummary,
  AssistantSkillSummary,
  MarketplacePackageType,
} from "../../shared/assistant-context.js";
import type { MarketplacePackageAsset } from "../../shared/marketplace-package-assets.js";
import type {
  NativeContextMenuAction,
  NativeContextMenuPayload,
  DynamicNativeMenuAction,
  DynamicNativeMenuPayload,
} from "../../shared/native-context-menu.js";
import type { AiProviderPingIpcResult } from "../../shared/ai-provider-ping.js";
import type {
  OpenHtmlPreviewWindowPayload,
  OpenHtmlPreviewWindowResult,
} from "../../shared/render-html-preview.js";
import type { SessionTaskItem } from "../../shared/session-tasks.js";
import type { SessionGoal } from "../../shared/session-goal.js";
import type { MarketplaceAnnouncementPayload } from "../../shared/marketplace-announcements.js";
import type { NetworkAccessAcknowledgement } from "../../shared/network-access.js";
import type { PluginInstallFailureKind } from "../../shared/plugin-install-failure.js";
import type { PluginOnboardingSpec } from "../../plugins/types.js";
import type {
  LlmModelListRequest,
  LlmModelListResult,
} from "../../shared/llm-model-list.js";
import type {
  SandboxCapabilityInfo,
  SandboxWindowsStatusInfo,
  SandboxWindowsInstallResult,
} from "../../shared/sandbox-capability-info.js";

// Re-export MCP types for renderer-side consumers (type-only, no main-process runtime)
export type { McpServerConfig, McpServerConfigDto, McpServerState };
export type { PermissionEvaluationContext } from "../../permissions/evaluation-context.js";
export type { ExecutionMode } from "../../shared/permission-mode.js";

// Re-export checkpoint types for renderer-side consumers (type-only, no main-process runtime).
export type { CheckpointTrigger, Checkpoint } from "../../memory/memory-manager.js";
// Remote A2A action status is the controller's own status record.
import type { RemoteA2AActionStatus } from "../../main/remote-a2a-action-controller.js";
export type { RemoteA2AActionStatus };

// Plugin / hook trust rows and perf stats are the host row types.
import type { PluginPerfStats } from "../../plugins/runtime/index.js";
import type { PluginContributionTrustRow } from "../../plugins/plugin-bundle-lifecycle.js";
import type { HookTrustRow } from "../../hooks/hook-trust-commands.js";
export type { PluginPerfStats, PluginContributionTrustRow, HookTrustRow };

// Usage aggregates come from the engine/IPC owners; only the renderer-side
// derived shapes (UsagePerX, UsageTrendPt, UsageConv) are declared here.
import type { UsageTotals } from "../../engine/usage-stats.js";
import type { UsageDailySummaryInput, UsageDailySummaryResult } from "../../ipc/handlers/usage.js";

// Settings: the renderer sees the host AppSettings minus the main-only
// `a2aRemote` block, expressed once by the IPC projection type.
import type { RendererSettingsSnapshot as AppSettings } from "../../ipc/domains/settings.js";
import type { HomeDocsStatus } from "../../ipc/domains/home-docs.js";
import type { MemoryCaptureMode } from "../../data/settings-store.js";
export type { AppSettings, MemoryCaptureMode };

// Approval / permission contracts are the host types themselves (the full
// ApprovalRequest crosses the IPC boundary — see approval-gate.ts IPC_APPROVAL_REQUEST).
import type { ApprovalChoice, ApprovalDecision, ApprovalRequest } from "../../permissions/approval-gate.js";
import type { PermissionRule } from "../../permissions/permission-manager.js";
import type { ParentAdjudicationBackgroundEscalation, ParentAdjudicationMaxVerdict, ParentAdjudicationModelSource } from "../../permissions/permission-settings-store.js";
export type { ApprovalChoice, ApprovalDecision, ApprovalRequest, PermissionRule, ParentAdjudicationBackgroundEscalation, ParentAdjudicationMaxVerdict, ParentAdjudicationModelSource };


export type MarketplaceItem = {
  id: string;
  name: string;
  description: string;
  packageSpec: string;
  installed: boolean;
  enabled: boolean;
  isManaged?: boolean;
  /**
   * Install policy from the catalog manifest. "admin" plugins gain system-wide
   * administrator privileges on install, so the marketplace UI gates them
   * behind an explicit consent step (#1098). Delivered by the backend via
   * `MarketplaceListItem extends PluginMarketplaceItem`.
   */
  installPolicy?: "admin" | "user";
  pluginType?: MarketplacePackageType;
  packageAsset?: MarketplacePackageAsset;
  /** Display-only compatibility result: update LVIS before installing. */
  upgradeRequired?: {
    code: "upgrade_required";
    /** Omitted only when Marketplace cannot provide a trusted exact minimum. */
    minAppVersion?: string;
    message: string;
  };
  mcpAuth?: {
    mode: "none" | "api-key" | "sso" | "oauth";
    transport?: "stdio" | "http";
  };
  networkAccess?: {
    allowedDomains: string[];
    reasoning?: string;
    allowPrivateNetworks?: boolean;
  };
};

export type PluginUiExtension = PluginUiExtensionView;
export type PluginManifestUiExtensionSummary = PluginUiExtensionView["extension"];

export type PluginConfigSchemaPropertySummary = {
  type: "string" | "number" | "integer" | "boolean" | "array";
  title?: string;
  description?: string;
  default?: unknown;
  enum?: Array<string | number | boolean>;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: "secret" | "uri" | "email" | "date-time";
  items?: { type: "string" | "number" | "integer" | "boolean"; enum?: Array<string | number | boolean> };
};

export type PluginConfigSchemaSummary = {
  $schema?: string;
  properties: Record<string, PluginConfigSchemaPropertySummary>;
  required?: string[];
  customPanel?: { entry: string; exportName: string };
};

export type PluginCardSummary = {
  id: string;
  name: string;
  description: string;
  sampleTools: string[];
  capabilities: string[];
  tools: string[];
  toolDescriptions?: Record<string, string>;
  isManaged?: boolean;
  /** Install policy from the plugin manifest: "admin" (IT-managed only) or "user" (anyone). */
  installPolicy?: "admin" | "user";
  loadStatus?: "loaded" | "preparing" | "failed" | "disabled";
  /** Whether the plugin's tools are currently exposed to the model. */
  active?: boolean;
  /** Whether an active immutable plugin generation is currently instantiated. */
  runtimeLoaded?: boolean;
  preparationStatus?: {
    phase: string;
    message: string;
    progressPct?: number;
    updatedAt: string;
  };
  /** Optional Lucide icon name declared in the plugin manifest. */
  icon?: string;
  /** Optional short text rendered in place of a Lucide icon. */
  iconText?: string;
  /** Manifest-declared sidebar UI metadata, even before the plugin is loaded. */
  uiExtensions?: PluginManifestUiExtensionSummary[];
  version?: string;
  publisher?: string;
  /** Declarative settings schema, when the manifest declares one. */
  configSchema?: PluginConfigSchemaSummary;
  /** Optional declarative auth contract for the host UI surface. */
  auth?: PluginAuthSummary;
  /** Declarative egress disclosure copied from the plugin manifest. */
  networkAccess?: {
    allowedDomains: string[];
    reasoning?: string;
    allowPrivateNetworks?: boolean;
  };
  /** Declarative first-run guidance copied unchanged from the manifest. */
  onboarding?: PluginOnboardingSpec;
  /** Structured marketplace install failure classification for Doctor UI. */
  installFailureKind?: PluginInstallFailureKind;
  /** User-visible install/load failure detail preserved for Doctor diagnostics. */
  installFailureMessage?: string;
  /** Marketplace request slugs that should collapse onto this installed plugin. */
  installAliases?: string[];
};

/**
 * One sub-agent row rebuilt from persisted metadata by a session-load handler.
 * The panel's live `agent_spawn` event stream does not survive an app restart,
 * so these rows are the only way a reopened conversation shows its agents.
 */
interface RestoredSubAgentPayload {
  spawnId: string;
  childSessionId: string;
  title: string;
  modifiedAt: string;
  taskState?: string;
  toolUseId?: string;
}

/**
 * Mirror of host-side `PluginAuthSpec` for renderer consumption — kept as a
 * separate name to make the renderer/host boundary explicit. Field shape
 * matches the host contract.
 */
export type PluginAuthSummary = {
  label?: string;
  statusTool: string;
  loginTool: string;
  logoutTool?: string;
};

/** Recommended return shape of `auth.statusTool`. Host parses defensively. */
export type PluginAuthStatusResult = {
  authenticated: boolean;
  account?: string;
};

export type LLMVendorSettingsRenderer = {
  model: string;
  baseUrl?: string;
  vertexProject?: string;
  vertexLocation?: string;
  /** Mirrors `LLMVendorSettings.presetModels` — read via `llmRouteModel`. */
  presetModels?: Record<string, string>;
  enableThinking: boolean;
  thinkingBudgetTokens: number;
};

export type IpcErrorResult = { ok: false; error: string; message?: string };
export type SettingsUpdateResult = AppSettings | IpcErrorResult;

export function isIpcErrorResult(value: unknown): value is IpcErrorResult {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { ok?: unknown }).ok === false &&
    typeof (value as { error?: unknown }).error === "string"
  );
}

export type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

export type UsagePerX = UsageTotals & { vendor: string; model: string };
export type UsageTrendPt = UsageTotals & { date: string };
export type UsageConv = UsageTotals & { sessionId: string; turns: number; firstInput?: string };

/** Token-only telemetry for authenticated subscription runtimes. */
type SubscriptionUsageTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  segments: number;
};
type SubscriptionUsagePerX = SubscriptionUsageTotals & {
  provider: SubscriptionRuntimeId;
  model: string;
};
type SubscriptionUsageTrendPt = SubscriptionUsageTotals & { date: string };
type SubscriptionUsageSummaryShape = {
  today: SubscriptionUsageTotals;
  thisWeek: SubscriptionUsageTotals;
  thisMonth: SubscriptionUsageTotals;
  perRuntime: SubscriptionUsagePerX[];
  perModel: SubscriptionUsagePerX[];
  trend: SubscriptionUsageTrendPt[];
  sources: Record<SubscriptionUsageSource, SubscriptionUsageTotals>;
};

export type UsageSummaryShape = {
  today: UsageTotals;
  thisWeek: UsageTotals;
  thisMonth: UsageTotals;
  perVendor: UsagePerX[];
  perModel: UsagePerX[];
  trend: UsageTrendPt[];
  topConversations: UsageConv[];
  /** Kept separate from API-key usage and all cost calculations. */
  subscription?: SubscriptionUsageSummaryShape;
  generatedAt: string;
};

type RemoteA2AStatusResult =
  | { ok: true; status: RemoteA2AActionStatus }
  | { ok: false; error: string };

type RemoteA2AActionCall = {
  (action: "resume", taskHandle: string, userIntent: string): Promise<RemoteA2AStatusResult>;
  (action: "cancel" | "replay", taskHandle: string): Promise<RemoteA2AStatusResult>;
};

export type ProjectQueryOptions = {
  projectRoot?: string;
  projectName?: string;
  includeUnscoped?: boolean;
};

/** Host-owned metadata attached to a managed long-term memory. */
type MemoryEntry = {
  filename: string;
  title: string;
  content: string;
  updatedAt?: string;
  projectRoot?: string;
  projectName?: string;
  id?: string;
  kind?: "preference" | "constraint" | "fact" | "goal" | "reference" | "note";
  state?: "candidate" | "active";
  source?: "user" | "assistant" | "import";
  createdAt?: string;
  confirmedAt?: string;
  expiresAt?: string;
  pinned?: boolean;
};

/** A review-only memory always has an immutable id and remains outside prompts. */
export type MemoryCandidate = MemoryEntry & { id: string; state: "candidate" };

type MemoryMutationResult =
  | { ok: true; entry?: MemoryEntry }
  | { ok: false; error: string };

type LongTermMemoryConsolidationScopeResult = {
  status: "updated" | "up-to-date" | "empty";
  sourceCount: number;
  consolidatedAt?: string;
};

type LongTermMemoryConsolidationResult =
  | { ok: true; global: LongTermMemoryConsolidationScopeResult; project?: LongTermMemoryConsolidationScopeResult }
  | { ok: false; error: string };

export type PluginMarketplaceActionResult =
  | {
      ok: true;
      pluginId: string;
      installed?: true;
      uninstalled?: true;
      rolledBackTo?: string;
      version?: string;
      /**
       * The install replaced nothing — the marketplace carries the same
       * version, receipt, and artifact already on disk. For a repair attempt
       * this is the difference between "reinstalled" and "there was nothing to
       * reinstall but the broken bundle".
       */
      unchanged?: true;
    }
  | { ok: false; error: string; message?: string };

export type PluginMarketplaceInstallOptions = {
  networkAccessAcknowledgement?: NetworkAccessAcknowledgement;
};

export type PluginMarketplaceUninstallOptions = {
  doctorCleanup?: {
    installFailureKind: PluginInstallFailureKind;
  };
};

/** ask_user_question — one FIFO request main pushes to the composer dock. */
export type AskUserQuestionRequest = {
  id: string;
  sessionId: string;
  questions: Array<{
    question: string;
    choices: string[];
    recommendedIndex?: number;
    altIndices?: number[];
    allowMultiple?: boolean;
    /** Draws a free-text field as the last answer row. */
    allowFreeText?: boolean;
    placeholder?: string;
    summaryHint?: string;
  }>;
  createdAt: number;
};

export type AskUserQuestionResponse = {
  requestId: string;
  answers?: Array<{
    choice?: string;
    /** Multi-select selections (only set when the question allowMultiple). */
    choices?: string[];
    /** Typed answer (only set when the question allowFreeText). */
    freeText?: string;
  }>;
  dismissed?: boolean;
};

/** Which surface raised an in-app toast / OS notification. */
type NotificationKind = "turn-end" | "routine" | "ask-user" | "approval" | "plugin" | "system";

/** What the notification points back at, so a click can land on its source. */
type NotificationContextRef = {
  sessionId?: string;
  routineId?: string;
  questionId?: string;
  approvalId?: string;
};

export type NotificationToastPayload = {
  kind: NotificationKind;
  title: string;
  body: string;
  contextRef?: NotificationContextRef;
};

/** An overlay trigger began running — main → renderer, before any item is shown. */
export type OverlayTriggerStartedPayload = {
  sessionId: string;
  pluginId: string;
  source: string;
  visibility: "silent" | "summary-only" | "user-visible";
  priority: "low" | "normal" | "high";
  startedAt: string;
};

export type OverlayTriggerCompletedPayload = {
  sessionId: string;
  pluginId: string;
  source: string;
  visibility: "silent" | "summary-only" | "user-visible";
  priority: "low" | "normal" | "high";
  prompt: string;
  summary: string;
  completedAt: string;
};

export type OverlayTriggerExpiredPayload = { sessionId: string; pluginId: string; source: string };

export type OverlayTriggerFailedPayload = {
  sessionId: string;
  pluginId: string;
  source: string;
  reason: "provider_error" | "tool_error" | "abort" | "unknown";
  errorId: string;
};

export type OverlayTriggerImportedPayload = {
  sessionId: string;
  source: string;
  prompt: string;
  summary: string;
  toolCallCount: number;
  importedAt: string;
  wrappedPrompt: string;
};

export type NotificationClickPayload = {
  kind: NotificationKind;
  contextRef?: NotificationContextRef;
};

export type LvisApi = {
  /**
   * Deterministic file:// URL of the bundled `plugin-preload.js`. Computed in
   * the host preload from `__dirname` (= `dist/src/`) so the plugin <webview>
   * can be mounted with a stable preload regardless of `window.location.href`.
   */
  pluginPreloadUrl: string;
  permission: LvisPermissionApi;
  approval: LvisApprovalApi;
  policy: LvisPolicyApi;
  mcp: LvisMcpApi;
  remoteA2a: {
    targets: () => Promise<
      | { ok: true; targets: Array<{ targetAgentId: number; label: string }> }
      | { ok: false; error: string }
    >;
    status: () => Promise<RemoteA2AStatusResult>;
    send: (targetAgentId: number, userIntent: string) => Promise<RemoteA2AStatusResult>;
    task: (taskHandle: string) => Promise<RemoteA2AStatusResult>;
    action: RemoteA2AActionCall;
  };
  tailnetSharing: TailnetSharingOwnerApi;
  tailnetObserver: TailnetObserverConfigApi;
  telegramConnection: TelegramConnectionOwnerApi;
  awayAuthority: AwayAuthorityOwnerApi;
  /**
   * Deterministic file:// URL of the bundled `plugin-ui-shell.html`. Same
   * stability guarantee as `pluginPreloadUrl` — read directly from the host
   * renderer instead of resolving against `window.location.href`.
   */
  pluginShellUrl: string;
  notifyPluginTheme: (payload: {
    bundleId: string;
    shell: "light" | "dark";
    tokens: Record<string, string>;
  }) => Promise<{ ok: boolean; error?: string }>;
  getSettings: () => Promise<AppSettings>;
  updateSettings: (patch: DeepPartial<AppSettings>) => Promise<SettingsUpdateResult>;
  /** Settings paths the boot environment is forcing ON; presence only, never values. */
  envForcedSettings: () => Promise<readonly string[]>;
  /** Hosts `telemetry.endpoint` may point at. Read-only: the bound, not a setting. */
  telemetryAllowedHosts: () => Promise<readonly string[]>;
  onSettingsUpdated: (handler: (settings: AppSettings) => void) => () => void;
  onSubscriptionRuntimeStatusUpdated: (
    handler: (event: SubscriptionRuntimeStatusUpdatedEvent) => void,
  ) => () => void;
  listPersonaPromptSummaries: () => Promise<{ prompts: Array<Pick<RolePreset, "id" | "name">> }>;
  listPersonaPrompts: () => Promise<{ prompts: RolePreset[] }>;
  savePersonaPrompt: (prompt: { id: string; name: string; systemPromptAdd: string }) => Promise<
    | { ok: true; prompt: RolePreset }
    | { ok: false; error: string }
  >;
  deletePersonaPrompt: (id: string) => Promise<
    | { ok: true; deleted: boolean }
    | { ok: false; error: string }
  >;
  onPersonaPromptsUpdated?: (handler: () => void) => () => void;
  setApiKey: (vendor: string, k: string) => Promise<{ ok: true }>;
  hasApiKey: (vendor?: string) => Promise<boolean>;
  deleteApiKey: (vendor: string) => Promise<{ ok: true }>;
  listLlmModels: (request: LlmModelListRequest) => Promise<LlmModelListResult>;
  codexSubscriptionStatus: () => Promise<CodexSubscriptionActionResult>;
  codexSubscriptionStartBrowserLogin: () => Promise<CodexSubscriptionActionResult>;
  codexSubscriptionStartDeviceCodeLogin: () => Promise<CodexSubscriptionDeviceCodeResult>;
  codexSubscriptionCancelLogin: () => Promise<CodexSubscriptionActionResult>;
  codexSubscriptionLogout: () => Promise<CodexSubscriptionActionResult>;
  codexSubscriptionListModels: () => Promise<CodexSubscriptionModelsResult>;
  subscriptionRuntimeStatus: (provider: SubscriptionRuntimeId) => Promise<SubscriptionRuntimeActionResult>;
  subscriptionChooseRuntime: (provider: SubscriptionRuntimeId) => Promise<SubscriptionRuntimeActionResult>;
  subscriptionForgetRuntime: (provider: SubscriptionRuntimeId) => Promise<SubscriptionRuntimeActionResult>;
  subscriptionVerifyRuntime: (provider: SubscriptionRuntimeId) => Promise<SubscriptionRuntimeActionResult>;
  subscriptionStartLogin: (provider: SubscriptionRuntimeId, method: SubscriptionLoginMethod) => Promise<SubscriptionRuntimeActionResult>;
  subscriptionOpenLoginBrowser: (provider: SubscriptionRuntimeId) => Promise<SubscriptionRuntimeActionResult>;
  subscriptionCancelLogin: (provider: SubscriptionRuntimeId) => Promise<SubscriptionRuntimeActionResult>;
  subscriptionLogout: (provider: SubscriptionRuntimeId) => Promise<SubscriptionRuntimeActionResult>;
  subscriptionListModels: (provider: SubscriptionRuntimeId) => Promise<SubscriptionRuntimeModelsResult>;
  subscriptionUseForChat: (provider: SubscriptionRuntimeId, model?: string) => Promise<SubscriptionRuntimeActionResult>;
  subscriptionUseApiForChat: () => Promise<
    | { ok: true }
    | { ok: false; error: SubscriptionRuntimeErrorCode }
  >;
  acpSubscriptionStatus: (provider: AcpSubscriptionProviderId) => Promise<AcpSubscriptionActionResult>;
  acpSubscriptionChooseRuntime: (provider: AcpSubscriptionProviderId) => Promise<AcpSubscriptionActionResult>;
  acpSubscriptionForgetRuntime: (provider: AcpSubscriptionProviderId) => Promise<AcpSubscriptionActionResult>;
  acpSubscriptionVerify: (provider: AcpSubscriptionProviderId) => Promise<AcpSubscriptionActionResult>;
  acpSubscriptionStartLogin: (provider: AcpSubscriptionProviderId) => Promise<AcpSubscriptionActionResult>;
  acpSubscriptionOpenLoginBrowser: (provider: AcpSubscriptionProviderId) => Promise<AcpSubscriptionActionResult>;
  acpSubscriptionCancelLogin: (provider: AcpSubscriptionProviderId) => Promise<AcpSubscriptionActionResult>;
  acpSubscriptionLogout: (provider: AcpSubscriptionProviderId) => Promise<AcpSubscriptionActionResult>;
  installMarketplaceProviderPreset: (
    preset: MarketplaceInstalledProviderPreset,
  ) => Promise<SettingsUpdateResult>;
  uninstallMarketplaceProviderPreset: (
    providerId: string,
  ) => Promise<SettingsUpdateResult>;
  setWebApiKey: (provider: string, k: string) => Promise<{ ok: true }>;
  hasWebApiKey: (provider: string) => Promise<boolean>;
  deleteWebApiKey: (provider: string) => Promise<{ ok: true }>;
  setMarketplaceApiKey: (k: string) => Promise<{ ok: true }>;
  hasMarketplaceApiKey: () => Promise<boolean>;
  deleteMarketplaceApiKey: () => Promise<{ ok: true }>;
  /**
   * Interactive PTY terminal (#1444, workspace rail). `spawn` is idempotent per
   * tab (a remount replays the scrollback rather than starting a fresh shell);
   * `onData` / `onExit` return unsubscribe functions (the onChatStream pattern).
   * Optional so test fixtures casting a partial object to LvisApi keep compiling
   * — production preload always defines it.
   */
  terminal?: {
    spawn: (payload: { tabId: string; cwd?: string; cols?: number; rows?: number }) => Promise<
      | { ok: true; tabId: string; replayed: boolean }
      | { ok: false; reason: string; message: string }
    >;
    input: (tabId: string, data: string) => Promise<{ ok: true } | { ok: false; error: string }>;
    resize: (
      tabId: string,
      cols: number,
      rows: number,
    ) => Promise<{ ok: true } | { ok: false; error: string }>;
    kill: (tabId: string) => Promise<{ ok: true } | { ok: false; error: string }>;
    onData: (handler: (payload: { tabId: string; chunk: string }) => void) => () => void;
    onExit: (
      handler: (payload: { tabId: string; exitCode: number; signal?: number }) => void,
    ) => () => void;
  };
  /**
   * Side chat (workspace rail) — a second, independently-streaming chat session
   * driven by a dedicated ConversationLoop in main. `onStream` / `onFallback`
   * subscribe to the DEDICATED CHANNELS.sidechat.{stream,fallback} events (never
   * the main chat.stream), so a main-chat stream frame never reaches this
   * subscriber and vice versa. Optional so test fixtures casting a partial
   * object to LvisApi keep compiling — production preload always defines it.
   */
  sideChat?: {
    send: (input: string, attachments?: unknown[]) => Promise<
      | { ok: true; result: unknown }
      | { ok: false; error: string }
    >;
    new: () => Promise<{ ok: true; sessionId: string } | { ok: false; error: string }>;
    load: (sessionId: string) => Promise<
      | { ok: true; sessionId: string; messages: SerializedHistoryMessage[] }
      | { ok: false; error: string; messages: SerializedHistoryMessage[] }
    >;
    list: () => Promise<{
      current: string | null;
      sessions: Array<{ id: string; modifiedAt: string; title: string }>;
    }>;
    abort: () => Promise<{ ok: true } | { ok: false; error: string }>;
    onStream: (handler: (event: ChatStreamEvent) => void) => () => void;
    onFallback: (handler: (payload: { from: string; to: string }) => void) => () => void;
  };
  /**
   * Tutorial-C — SpotlightTour state + broadcast bridge. The host persists
   * the tour state under `~/.lvis/onboarding/tour-state.json` (Storage
   * Namespace per Feature). `tour.start` fans out to every open window
   * so any renderer surface can launch the tour without owning tour state.
   */
  tour: {
    getState: () => Promise<
      | {
          ok: true;
          state: {
            lastSeenScenario: string | null;
            completedScenarios: string[];
            dismissedAt: string | null;
          };
        }
      | { ok: false; error: string; message: string }
    >;
    markComplete: (scenarioId: string) => Promise<
      | {
          ok: true;
          state: {
            lastSeenScenario: string | null;
            completedScenarios: string[];
            dismissedAt: string | null;
          };
        }
      | { ok: false; error: string; message: string }
    >;
    dismiss: (scenarioId: string) => Promise<
      | {
          ok: true;
          state: {
            lastSeenScenario: string | null;
            completedScenarios: string[];
            dismissedAt: string | null;
          };
        }
      | { ok: false; error: string; message: string }
    >;
    start: (scenarioId: string) => Promise<
      | { ok: true; scenarioId: string }
      | { ok: false; error: string; message: string }
    >;
    onStart: (handler: (payload: { scenarioId: string }) => void) => () => void;
  };
  /** Open an http(s) URL in the system browser. Main-side rejects any other scheme. */
  openExternalUrl: (url: string) => Promise<{
    ok: boolean;
    error?: string;
    protocol?: string;
    message?: string;
  }>;
  /** MCP catalog (filtered to plugin_type === "mcp"). */
  listMcpCatalog: () => Promise<Array<{
    id: string;
    name: string;
    description: string;
    version?: string;
    publisher?: string;
    pluginType?: MarketplacePackageType;
    installed: boolean;
    enabled: boolean;
    isManaged?: boolean;
  }>>;
  installMcpFromMarketplace: (slug: string) => Promise<
    | { ok: true; slug: string; installDir: string; connected: boolean; warning?: string; needsCredential: boolean; authMode: "none" | "api-key" | "sso" | "oauth" }
    | { ok: false; error: string; message: string }
  >;
  /** Claude Desktop config import. */
  previewClaudeDesktopMcpImport: (raw: string) => Promise<{
    entries: Array<{
      id: string;
      config: McpServerConfig;
      suspectedSecretEnvKeys: string[];
      warning?: string;
    }>;
    errors: Array<{ id: string; reason: string }>;
  }>;
  applyClaudeDesktopMcpImport: (payload: { raw: string; conflictPolicy?: "skip" | "overwrite" }) => Promise<
    | {
        ok: true;
        results: Array<{
          id: string;
          action: "added" | "skipped-conflict" | "overwritten" | "failed";
          reason?: string;
          warning?: string;
        }>;
        parseErrors: Array<{ id: string; reason: string }>;
      }
    | { ok: false; error: string }
  >;
  // Provider-auth bridge methods are plugin-owned.
  chatHasProvider: () => Promise<boolean>;
  captureUserKeyboardIntent: () => import("../../shared/chat-origin.js").UserKeyboardIntentSnapshot;
  chatSend: (
    input: string,
    attachments: import("../../engine/llm/types.js").UserContentPart[] | undefined,
    inputOrigin: ChatSendInputOrigin,
    userIntent?: import("../../shared/chat-origin.js").UserKeyboardIntentSnapshot,
    personaPromptId?: string,
    options?: { interrupt?: boolean },
  ) => Promise<unknown>;
  chatGuide: (input: string) => Promise<unknown>;
  chatNew: (opts?: { projectRoot?: string; projectName?: string }) => Promise<
    { ok: true } | { ok: false; error: string }
  >;
  chatSessions: (opts?: { kind?: "main" | "routine" | "all"; routineId?: string; projectRoot?: string; limit?: number; before?: string; beforeId?: string; after?: string }) => Promise<{ current: string; sessions: Array<{ id: string; modifiedAt: string; title: string; sessionKind: "main" | "routine"; routineId?: string; routineTitle?: string; routineFiredAt?: string; projectRoot?: string; projectName?: string; branchedFromCompactNum?: number }> }>;
  onChatStream: (h: (e: ChatStreamEvent) => void) => () => void;
  /**
   * One tiled chat group's view of the per-conversation channels.
   *
   * A tile passes this where it would otherwise pass the api, so nothing below
   * it has to know about groups — its calls already name the right
   * conversation, and its stream subscription only sees that group's frames.
   * See docs/design/tiled-chat-groups.md.
   */
  /**
   * One tile's view of the per-conversation channels. It rebinds those
   * channels only — settings, plugins and the rest are window-wide — so a
   * tile layers it over the base surface (`{ ...api, ...api.chatGroup(id) }`).
   */
  chatGroup?: (chatGroupId: string) => Partial<LvisApi>;
  /**
   * Let go of this group's conversation in main. Sent when its tile closes;
   * the primary group refuses it.
   */
  chatGroupRelease: () => Promise<{ ok: boolean; released?: boolean; error?: string }>;
  onChatFallback: (h: (payload: { from: string; to: string }) => void) => () => void;
  chatGetHistory: () => Promise<{ restoredSubAgents?: RestoredSubAgentPayload[]; sessionId: string; sessionTitle?: string; sessionKind: "main" | "routine"; routineId?: string; routineTitle?: string; projectRoot?: string; projectName?: string; projectIsDefault?: boolean; messages: SerializedHistoryMessage[] }>;
  chatMainActiveState: () => Promise<{ mainActiveSessionId: string | null; mainActiveMode: "resume" | "fresh"; updatedAt: string } | null>;
  chatSessionHistory: (sessionId: string) => Promise<{
    ok: boolean;
    restoredSubAgents?: RestoredSubAgentPayload[];
    sessionTitle?: string;
    sessionKind?: "main" | "routine";
    routineId?: string;
    routineTitle?: string;
    routineFiredAt?: string;
    projectRoot?: string;
    projectName?: string;
    messages: SerializedHistoryMessage[];
    /** Chars in the rolling summary preamble applied to this session. 0 = no preamble. */
    preambleChars?: number;
  }>;
  /**
   * Replace one user message and re-run the conversation from it. `messageId`
   * is the row's durable identity (see ChatEntry.messageId) — a position would
   * name a different row after the next compaction.
   */
  chatEditResend: (messageId: string, newText: string) => Promise<{ ok: boolean; error?: string }>;
  /**
   * Discard the conversation from this user message onward, in place. The
   * message itself goes too — the caller owns putting its text back in the
   * composer, which is what makes this a rewind rather than a delete.
   */
  chatRewindTo: (messageId: string) => Promise<
    | { ok: true; text: string; personaPromptId?: string }
    | { ok: false; error: string }
  >;
  /** Branch into a new session up to and including `messageId`; omit it to branch the whole conversation. */
  chatFork: (messageId?: string) => Promise<{ ok: boolean; sessionId: string | null; error?: string }>;
  chatContinueLastUser: (sessionId: string) => Promise<{ ok: boolean; error?: string }>;
  chatRetryEffort: (opts?: { thinkingBudgetTokens?: number; enableThinking?: boolean }) => Promise<{ ok: boolean; error?: string }>;
  /** `sessionId` targets a conversation other than the loaded one. */
  chatExport: (format: "markdown" | "json", sessionId?: string) => Promise<{ ok: boolean; filePath?: string; canceled?: boolean; error?: string }>;
  /** Row-level conversation edits. Each field is optional; omitted means unchanged. */
  chatSessionUpdate: (payload: {
    sessionId: string;
    title?: string;
    archived?: boolean;
    unread?: boolean;
  }) => Promise<{ ok: true } | { ok: false; error?: string }>;
  chatSessionDelete: (
    sessionId: string,
  ) => Promise<{ ok: true; wasLoaded: boolean } | { ok: false; error?: string; canceled?: boolean }>;
  /** Reverse of chatExport. Always creates a brand-new session (never overwrites). */
  chatImport: () => Promise<
    { ok: true; sessionId: string; messageCount: number } | { ok: false; error?: string; canceled?: boolean }
  >;
  chatCompact: () => Promise<{ compacted: boolean; compactedAt: string | null; summary: string; removedMessageCount: number }>;
  chatSessionResume: (sessionId: string) => Promise<{
    ok: boolean; compacted: boolean; compactedAt: string | null; removedMessageCount: number;
    error?: string;
    /** On `session-open-in-other-group`: the chat group whose loop holds the session. */
    holderChatGroupId?: string;
  }>;
  // Checkpoint view and explicit branch actions.
  // Note: enter/branch return discriminated unions without `ok`; exit follows the
  // standard { ok: boolean } pattern. Callers guard with `"error" in result`.
  chatEnterCheckpointView: (sessionId: string, compactNum: number) => Promise<{ messageIndexAtCreation: number } | { error: string }>;
  chatExitCheckpointView: () => Promise<{ ok: boolean }>;
  chatBranchFromCheckpoint: (sessionId: string, compactNum: number) => Promise<{
    newSessionId: string;
    lastMessageRole: "user" | "assistant" | "tool_result" | null;
    shouldAutoContinue: boolean;
  } | { error: string }>;
  chatAbort: () => Promise<{ ok: boolean }>;
  /** Lazy-load in-session verbatim content for a compacted tool_result.
   * Returns null when: session changed, toolUseId not found, verbatim
   * already flushed to disk stub, or meta.compactedAt was never set. lineCount
   * is pre-computed server-side. */
  chatGetVerbatimToolResult: (
    sessionId: string,
    toolUseId: string,
  ) => Promise<{ content: string; lineCount: number } | null>;
  /** Lazy-load the isolated child-session transcript for a sub-agent row. */
  chatGetSubAgentTranscript?: (opts: {
    originSessionId: string;
    childSessionId: string;
  }) => Promise<
    | {
        ok: true;
        childSessionId: string;
        messages: SerializedHistoryMessage[];
        title?: string;
        spawnId?: string;
        originToolUseId?: string;
      }
    | { ok: false; error?: string }
  >;
  /** Issue #749: lazy-load full write_file diff when content exceeded preview limit.
   * Returns { before, after } from ~/.lvis/diff-cache/<sessionId>/<toolUseId>.json,
   * or null when sidecar not found / session id invalid. */
  chatGetWriteDiff: (
    sessionId: string,
    toolUseId: string,
  ) => Promise<{ before: string; after: string } | null>;
  submitFeedback: (payload: { sessionId: string; messageIndex: number; rating: "up" | "down"; reason?: string }) => Promise<{ ok: boolean; error?: string }>;
  starredList: () => Promise<Array<{ id: string; sessionId: string; messageIndex: number; role: string; text: string; starredAt: string }>>;
  starredAdd: (entry: { sessionId?: string; messageIndex: number; role: string; text: string }) => Promise<{ ok: boolean; entry?: { id: string; sessionId: string; messageIndex: number; role: string; text: string; starredAt: string } }>;
  starredRemove: (opts: { id?: string; sessionId?: string; messageIndex?: number }) => Promise<{ ok: boolean }>;
  memoryListEntries: (opts?: ProjectQueryOptions) => Promise<Array<{ filename: string; title: string; content: string; updatedAt?: string; projectRoot?: string; projectName?: string }>>;
  memoryListCandidates: (opts?: ProjectQueryOptions) => Promise<MemoryCandidate[]>;
  memorySaveEntry: (t: string, c: string, opts?: ProjectQueryOptions) => Promise<unknown>;
  memoryDeleteEntry: (f: string, opts?: ProjectQueryOptions) => Promise<MemoryMutationResult>;
  memoryActivateCandidate: (id: string, opts?: ProjectQueryOptions) => Promise<MemoryMutationResult>;
  memoryDeleteCandidate: (id: string, opts?: ProjectQueryOptions) => Promise<MemoryMutationResult>;
  memorySearchEntries: (q: string, opts?: ProjectQueryOptions) => Promise<Array<{ filename?: string; title: string; content?: string; excerpt: string; updatedAt: string; projectRoot?: string; projectName?: string }>>;
  memoryGetIndex: (opts?: ProjectQueryOptions) => Promise<string>;
  memoryUpdateIndexIfUnchanged: (expectedContent: string, nextContent: string) => Promise<boolean>;
  memoryUpdateIndexSections: (sections: { urgentMemory?: string; references?: string }) => Promise<unknown>;
  memoryListSessions: (opts?: ProjectQueryOptions) => Promise<Array<{ sessionId: string; title?: string; matchedMessage: string; timestamp: string }>>;
  memorySearchSessions: (q: string, opts?: ProjectQueryOptions) => Promise<Array<{ sessionId: string; title?: string; matchedMessage: string; timestamp: string }>>;
  memoryGetAgentsMd: () => Promise<string>;
  memoryUpdateAgentsMd: (content: string) => Promise<unknown>;
  memoryGetUserPrefs: () => Promise<string>;
  memoryUpdateUserPrefs: (content: string) => Promise<unknown>;
  memoryRefreshUserPrefs: () => Promise<
    | {
        ok: true;
        content: string;
        refreshedAt?: string;
        sources?: string[];
      }
    | { ok: false; error: string }
  >;
  /** `~/.lvis` reference docs: pending packaged updates + the merge artifact. */
  homeDocsStatus: () => Promise<HomeDocsStatus>;
  homeDocsReadMarker: (markerPath: string) => Promise<
    | { ok: true; content: string; live: string }
    | { ok: false; error: string }
  >;
  homeDocsApplyPackaged: (markerPath: string) => Promise<
    | { ok: true; movedToCustom: boolean }
    | { ok: false; error: string }
  >;
  homeDocsKeepMine: (markerPath: string) => Promise<
    { ok: true } | { ok: false; error: string }
  >;
  homeDocsGetCustom: () => Promise<string>;
  homeDocsUpdateCustom: (content: string) => Promise<
    { ok: true } | { ok: false; error: string }
  >;
  homeDocsMerge: (markerPath?: string) => Promise<
    | { ok: true; content: string; mergedAt: string; sources: string[] }
    | { ok: false; error: string }
  >;
  homeDocsApplyMerged: (expectedContent: string) => Promise<
    { ok: true } | { ok: false; error: string }
  >;
  homeDocsDiscardMerged: () => Promise<{ ok: true }>;
  listMarketplacePlugins: () => Promise<MarketplaceItem[]>;
  memoryRefreshLongTerm: () => Promise<LongTermMemoryConsolidationResult>;
  listAgentProfiles: () => Promise<{ agents: AssistantAgentSummary[] }>;
  listSkills: () => Promise<{ skills: AssistantSkillSummary[] }>;
  installAgentFromMarketplace: (slug: string) => Promise<
    | { ok: true; slug: string; agentId: string; version: string }
    | { ok: false; error: string; message: string }
  >;
  uninstallAgentPackage: (slug: string) => Promise<
    | { ok: true; slug: string; agentId: string }
    | { ok: false; error: string; message: string }
  >;
  installSkillFromMarketplace: (slug: string) => Promise<
    | { ok: true; slug: string; skillId: string; version: string }
    | { ok: false; error: string; message: string }
  >;
  uninstallSkillPackage: (slug: string) => Promise<
    | { ok: true; slug: string; skillId: string }
    | { ok: false; error: string; message: string }
  >;
  listPluginUiExtensions: () => Promise<PluginUiExtension[]>;
  readPluginUiModule: (pluginId: string, viewId: string) => Promise<string>;
  callPluginMethod: (
    m: string,
    p?: unknown,
    options?: { userAction?: boolean; operationGrantToken?: string },
  ) => Promise<unknown>;
  /** LVIS_E2E-only generation/Skill/tool/Hook projection; production fails closed. */
  e2ePluginBundleSnapshot: (
    pluginId: string,
    skillLocalId: string,
    hookProbeToolName: string,
  ) => Promise<unknown>;
  /**
   * Subscribe to plugin-emitted events forwarded by the host event bridge
   * (`boot/steps/ipc-bridge.ts` → `lvis:plugin:event`). Plugin must declare
   * the type in `manifest.emittedEvents[]`. The preload layer rejects
   * subscriptions whose namespace prefix appears in `PLUGIN_PRIVATE_NAMESPACES`
   * by returning a no-op unsubscribe without wiring the IPC listener — so
   * renderer code can never observe sensitive host state (memory contents,
   * secrets, audit trails, DLP decisions) through this API. Returns an
   * unsubscribe function. Used by `usePluginAuthStatuses` for
   * `<pluginId>.auth.changed`.
   */
  onPluginEvent?: (eventType: string, handler: (data: unknown) => void) => (() => void);
  listPluginCards: () => Promise<PluginCardSummary[]>;
  listPluginContributionTrust: (pluginId?: string) => Promise<
    | { ok: true; rows: PluginContributionTrustRow[] }
    | { ok: false; error: string }
  >;
  setPluginContributionTrust: (input: {
    pluginId: string;
    localId: string;
    kind: "hook" | "mcpServer";
    approved: boolean;
  }) => Promise<
    | { ok: true; pluginId: string; localId: string; kind: "hook" | "mcpServer"; approved: boolean }
    | { ok: false; error: string; message?: string }
  >;
  /**
   * Toggle a plugin active/inactive. Disable retires and unloads the active
   * generation; re-enable re-verifies the receipt and activates a fresh one.
   */
  setPluginEnabled: (
    pluginId: string,
    enabled: boolean,
  ) => Promise<
    | { ok: true; pluginId: string; enabled: boolean }
    | { ok: false; error: string; message: string }
  >;
  // routine_schedule — persistent routine list + lifecycle
  listRoutines: () => Promise<import("../../shared/routines-types.js").RoutineRecord[]>;
  dismissRoutine: (id: string) => Promise<{ ok: boolean; error?: string }>;
  removeRoutine: (id: string) => Promise<{ ok: boolean; error?: string }>;
  triggerRoutineNow: (id: string) => Promise<{ ok: boolean; error?: string }>;
  listPendingRoutineResults: () => Promise<import("../../shared/routines-types.js").RoutineFiredPayload[]>;
  acknowledgeRoutineResult: (routineId: string, firedAt: string) => Promise<{ ok: boolean; error?: string }>;
  addRoutine: (
    input: import("../../shared/routines-types.js").AddRoutineInput,
  ) => Promise<
    | { ok: true; routine: import("../../shared/routines-types.js").RoutineRecord }
    | { ok: false; error: string }
  >;
  onRoutineFired: (
    handler: (event: import("../../shared/routines-types.js").RoutineFiredPayload) => void,
  ) => () => void;
  // Routine running indicator
  // Enriched payload includes title+firedAt so renderer can push OverlayItem immediately
  onRoutineRunningStarted: (handler: (payload: { routineId: string; firedAt: string; title: string }) => void) => () => void;
  onRoutineRunningFinished: (handler: (routineId: string) => void) => () => void;
  // failed: clears running:true stuck OverlayItem when the LLM session throws
  onRoutineFailed: (handler: (event: { routineId: string; error: string }) => void) => () => void;
  // Overlay IPC bridges
  // ─── Observability + privacy surfaces ─────────────────────────────────
  // The IPC bridge resolves these to `unknown`; each result's shape is
  // declared by its one consumer tab (AuditTab, DiagnosticsSection,
  // PrivacyTab) until it is lifted here. Parameters are the contract.
  dlp: {
    getStats: (days: number) => Promise<unknown>;
  };
  audit: {
    search: (filter: {
      dateFrom?: string;
      dateTo?: string;
      type?: string;
      textSearch?: string;
      limit?: number;
      offset?: number;
    }) => Promise<unknown>;
    getStats: (lastDays: number) => Promise<unknown>;
  };
  diagnostics: {
    /** Build a redacted diagnostics ZIP and save via native dialog. */
    export: (opts?: { dateFrom?: string; dateTo?: string; includeCrashDumps?: boolean }) => Promise<unknown>;
    /** Crash-dump metadata (filename/time/size). */
    crashList: () => Promise<unknown>;
  };
  logs: {
    /** Recent N redacted log lines, optional level filter. */
    tail: (args?: { lines?: number; level?: string }) => Promise<unknown>;
  };
  /** The same store `window.lvis.userApproval` fronts. */
  userApproval: LvisUserApprovalApi;
  // ─── Overlay trigger lifecycle ────────────────────────────────────────
  dismissTrigger: (sessionId: string) => Promise<{
  ok: boolean;
  removed?: boolean;
  error?: string;
}>;
  importTrigger: (sessionId: string) => Promise<{
  ok: boolean;
  imported?: number;
  reason?: string;
  error?: string;
}>;
  onTriggerStarted: (handler: (payload: OverlayTriggerStartedPayload) => void) => () => void;
  onTriggerCompleted: (handler: (result: OverlayTriggerCompletedPayload) => void) => () => void;
  onTriggerExpired: (handler: (payload: OverlayTriggerExpiredPayload) => void) => () => void;
  onTriggerFailed: (handler: (payload: OverlayTriggerFailedPayload) => void) => () => void;
  onTriggerImported: (handler: (payload: OverlayTriggerImportedPayload) => void) => () => void;
  onOverlayShow: (handler: (item: import("./context/OverlayContext.js").OverlayItem) => void) => () => void;
  onOverlayUpdate: (handler: (id: string, patch: Partial<import("./context/OverlayContext.js").OverlayItem>) => void) => () => void;
  onOverlayDismiss: (handler: (id: string) => void) => () => void;
  // Routine session history
  listRoutineSessions: (
    routineId: string,
    limit?: number,
  ) => Promise<Array<{ routineId: string; firedAt: string; sessionId: string; title: string; preview: string }>>;
  // ─── Work Board — personal board CRUD + lifecycle ───
  // Result envelopes are the store's discriminated `status` unions (or
  // `{ ok:false, error }` for unauthorized-frame / no-store). Shared types come
  // from the renderer-safe `shared/work-board-types.js` (no Node built-ins).
  listWorkBoard: (
    filter?: import("../../shared/work-board-types.js").WorkItemListFilter,
  ) => Promise<
    | import("../../shared/work-board-types.js").WorkItemListResult
    | { ok: false; error: string }
  >;
  getWorkBoardItem: (
    id: number,
  ) => Promise<
    | import("../../shared/work-board-types.js").WorkItemGetResult
    | { ok: false; error: string }
  >;
  addWorkBoardItem: (
    input: import("../../shared/work-board-types.js").WorkItemCreateInput,
  ) => Promise<
    | import("../../shared/work-board-types.js").WorkItemCreateResult
    | { ok: false; error: string }
  >;
  updateWorkBoardItem: (
    id: number,
    patch: import("../../shared/work-board-types.js").WorkItemUpdateInput,
  ) => Promise<
    | import("../../shared/work-board-types.js").WorkItemUpdateResult
    | { ok: false; error: string }
  >;
  transitionWorkBoardItem: (
    id: number,
    to: import("../../shared/work-board-types.js").WorkItemStatusStored,
  ) => Promise<
    | import("../../shared/work-board-types.js").WorkItemTransitionResult
    | { ok: false; error: string }
  >;
  completeWorkBoardItem: (
    id: number,
  ) => Promise<
    | import("../../shared/work-board-types.js").WorkItemCompleteResult
    | { ok: false; error: string }
  >;
  reopenWorkBoardItem: (
    id: number,
  ) => Promise<
    | import("../../shared/work-board-types.js").WorkItemReopenResult
    | { ok: false; error: string }
  >;
  removeWorkBoardItem: (
    id: number,
  ) => Promise<
    | import("../../shared/work-board-types.js").WorkItemDeleteResult
    | { ok: false; error: string }
  >;
  // Board view live refresh: emitted after any successful board mutation so the
  // renderer re-lists without polling.
  onWorkBoardItemChanged: (
    handler: (payload: import("../../shared/work-board-types.js").WorkItemChangedEventPayload) => void,
  ) => () => void;
  // Agent-orchestration run: kick off plan→approve→execute for one item. The
  // promise resolves with the terminal run result; live phase + coarse marker
  // updates flow over the on* subscriptions below. `opts.agentName` selects a
  // named agent profile (drives the child model for both phases).
  runWorkBoardItem: (
    id: number,
    opts?: { agentName?: string },
  ) => Promise<
    | import("../../shared/work-board-types.js").WorkItemRunResult
    | { ok: false; error: string }
  >;
  // Generate a daily / weekly personal work report (markdown) from the board
  // state + activity log + learned memory.
  generateWorkBoardReport?: (
    kind: "daily" | "weekly",
    input?: { date?: string; weekIso?: string; weekOffset?: number; projectRoot?: string; includeUnscoped?: boolean },
  ) => Promise<
    | import("../../shared/work-board-types.js").WorkBoardReportResult
    | { ok: false; error: string }
  >;
  // Run the daily / weekly briefing — the reports surface in the opposite
  // direction. It surveys the user's work and files what it found onto the
  // board as proposals, resolving with the ids of the cards it wrote.
  runWorkBoardBriefing?: (
    kind: import("../../shared/work-board-types.js").WorkBoardBriefingKind,
    projectRoot?: string,
  ) => Promise<
    | import("../../shared/work-board-types.js").WorkBoardBriefingResult
    | { ok: false; error: string }
  >;
  // ─── Recommended work (plugin-proposed cards) ────
  // Read-only from the renderer's side plus the two answers the user can give.
  // Plugins post and withdraw over HostApi; there is no renderer create path.
  listWorkProposals?: () => Promise<
    | import("../../shared/work-board-types.js").WorkProposalListResult
    | { ok: false; error: string }
  >;
  acceptWorkProposal?: (
    proposalId: string,
    projectRoot?: string,
  ) => Promise<
    | import("../../shared/work-board-types.js").WorkProposalAcceptResult
    | { ok: false; error: string }
  >;
  dismissWorkProposal?: (
    proposalId: string,
  ) => Promise<
    | import("../../shared/work-board-types.js").WorkProposalDismissResult
    | { ok: false; error: string }
  >;
  onWorkProposalChanged?: (
    handler: (payload: import("../../shared/work-board-types.js").WorkProposalChangedEventPayload) => void,
  ) => () => void;
  // Read a past run's persisted transcript (plan+execute conversation) for the
  // run-history view. Resolves with the ordered events (empty when absent).
  getWorkBoardRunTranscript?: (
    itemId: number,
    runId: string,
  ) => Promise<
    | { events: import("../../shared/work-board-types.js").RunTranscriptEvent[] }
    | { ok: false; error: string }
  >;
  // Live per-phase progress for an in-flight run. Payload === the engine's
  // WorkBoardRunEvent (aliased RunProgressEventPayload).
  onWorkBoardRunProgress: (
    handler: (payload: import("../../shared/work-board-types.js").RunProgressEventPayload) => void,
  ) => () => void;
  // Coarse markers so the renderer can set/clear a per-item running indicator
  // without re-listing.
  onWorkBoardRunStarted: (
    handler: (payload: { itemId: number; at: string }) => void,
  ) => () => void;
  onWorkBoardRunFinished: (
    handler: (payload: {
      itemId: number;
      status: "completed" | "denied" | "not_found" | "error" | "already_running";
      at: string;
    }) => void,
  ) => () => void;
  onWorkBoardRunFailed: (
    handler: (payload: { itemId: number; reason: string; at: string }) => void,
  ) => () => void;
  onMarketplaceUpdatesAvailable: (h: (updates: Array<{
    pluginId: string;
    pluginName?: string;
    installedVersion: string;
    latestVersion: string;
    networkAccess?: MarketplaceItem["networkAccess"];
  }>) => void) => () => void;
  /**
   * Marketplace announcement stream — the host pushes the currently-active,
   * not-yet-dismissed announcements whenever the announcement poller runs.
   * The renderer shows them in a banner and persists dismissals via
   * `updateSettings({ marketplace: { dismissedAnnouncementIds } })`.
   */
  onMarketplaceAnnouncements: (h: (announcements: MarketplaceAnnouncementPayload) => void) => () => void;
  /**
   * App auto-update state stream — emitted by the main process whenever
   * the updater state changes (available → downloading → downloaded).
   * Renderer renders a permanent badge next to the Home button based on
   * this state. Download is user-gated (badge click) — see `downloadAppUpdate`.
   *
   * Both this method and `getAppUpdateState` reference the SoT
   * `UpdateState` union from `src/shared/update-state.ts` — never inline
   * the discriminated literals here (Field-Addition Sweep rule).
   */
  onAppUpdateState: (
    handler: (state: import("../../shared/update-state.js").UpdateState) => void,
  ) => () => void;
  /** Late-mount sync: fetch the last broadcasted state. */
  getAppUpdateState: () => Promise<import("../../shared/update-state.js").UpdateState>;
  /** Trigger download. Valid only when state is "available". */
  downloadAppUpdate: () => Promise<{ ok: boolean; reason?: string }>;
  /** Quit & install after main-owned native confirmation. Valid only when state is "downloaded". */
  installAppUpdate: () => Promise<{ ok: boolean; reason?: string }>;
  /** Hide the current available/downloaded app update until a newer version appears. */
  skipAppUpdate: () => Promise<{ ok: boolean; reason?: string }>;
  onBootstrapStatus: (
    h: (status:
      | { phase: "start" }
      | { phase: "complete"; installed: string[]; failed: Array<{ id: string; error: string }>; skippedReason?: string }
      | { phase: "error"; message: string }
    ) => void,
  ) => () => void;
  retryBootstrap: () => Promise<{ ok: true } | { ok: false; error: string }>;
  onPluginInstallResult: (h: (payload: PluginInstallResultPayload) => void) => () => void;
  onPluginUninstallResult: (h: (payload: { slug: string; success: boolean; error?: string }) => void) => () => void;
  /** #1176 — plugin active/inactive toggled (this surface or another). */
  onPluginEnabledChanged?: (h: (payload: { pluginId: string; enabled: boolean }) => void) => () => void;
  /** Fires after a loaded plugin runtime is restarted/reloaded without a full app restart. */
  onPluginRuntimeUpdated?: (h: (payload: { pluginId: string }) => void) => () => void;
  onAgentInstallResult: (h: (payload: AgentInstallResultPayload) => void) => () => void;
  onAgentUninstallResult: (h: (payload: AgentInstallResultPayload) => void) => () => void;
  onSkillInstallResult: (h: (payload: SkillInstallResultPayload) => void) => () => void;
  onSkillUninstallResult: (h: (payload: SkillInstallResultPayload) => void) => () => void;
  /**
   * Dev-only: open a folder picker and install a local plugin directory.
   *
   * Return shape:
   *   - `null` — the user cancelled the folder picker. NOT an error.
   *   - `{ pluginId, installed: true }` — install succeeded.
   *   - throws — auth/dev-mode/IO error. Callers must catch + surface as a
   *     toast/alert; collapsing the error into `null` would hide failures.
   */
  installLocalPlugin: () => Promise<{ pluginId: string; installed: true } | null>;
  onPluginInstallProgress: (h: (payload:
    | { slug: string; phase: "installing" | "restarting" | "verifying" | "registering" | "preparing" }
    | { slug: string; phase: "downloading"; bytesDownloaded: number; bytesTotal: number | null }
  ) => void) => () => void;
  onAgentInstallProgress: (h: (payload:
    | { slug: string; phase: "installing" | "restarting" | "verifying" | "registering" }
    | { slug: string; phase: "downloading"; bytesDownloaded: number; bytesTotal: number | null }
  ) => void) => () => void;
  onSkillInstallProgress: (h: (payload:
    | { slug: string; phase: "installing" | "restarting" | "verifying" | "registering" }
    | { slug: string; phase: "downloading"; bytesDownloaded: number; bytesTotal: number | null }
  ) => void) => () => void;
  getRuntimeCounts: () => Promise<{ tools: number; plugins: number; mcps: number }>;
  getRuntimeEnv: () => Promise<{ platform: string; hostname: string; user: string }>;
  pingMarketplace: () => Promise<{ configured: boolean; online: boolean }>;
  pingAiProvider: () => Promise<AiProviderPingIpcResult>;



  getAppInfo: () => Promise<{
    version: string;
    electronVersion: string;
    nodeVersion: string;
    chromeVersion: string;
    v8Version: string;
    platform: NodeJS.Platform;
    arch: string;
    userDataPath: string;
  }>;
  registerPluginWebview: (payload: { webContentsId: number; pluginId: string; entryUrl: string }) => Promise<{ ok: boolean; error?: string }>;
  ensurePluginPartition: (pluginId: string) => Promise<{ ok: boolean; error?: string }>;
  onViewActivate: (h: (k: string, settingsTab?: string) => void) => () => void;
  getUsageSummary: (days?: number) => Promise<UsageSummaryShape>;
  getUsageRange: (opts: { dateFrom: string; dateTo: string }) => Promise<UsageSummaryShape>;
  getUsageDailySummary: (input: UsageDailySummaryInput) => Promise<UsageDailySummaryResult>;
  exportUsageCsv: (rows: Array<Record<string, string | number>>) => Promise<{ ok: boolean; filePath?: string; canceled?: boolean }>;
  plugins: {
    getPerfStats: () => Promise<Record<string, PluginPerfStats>>;
  };
  // Workflow tools — routines
  onAskUserQuestion: (h: (req: AskUserQuestionRequest) => void) => () => void;
  respondAskUserQuestion: (response: AskUserQuestionResponse) => Promise<{ ok: boolean; error?: string }>;
  /** Renderer is notified when the gate's 5-minute timeout fires. */
  onAskUserQuestionTimeout?: (
    h: (payload: { requestId: string }) => void,
  ) => () => void;
  listSessionTasks: (sessionId: string) => Promise<SessionTaskItem[]>;
  clearSessionTasks: (sessionId: string) => Promise<{ ok: boolean; error?: string }>;
  onSessionTasksChanged: (
    h: (payload: {
      sessionId: string;
      items: SessionTaskItem[];
    }) => void,
  ) => () => void;
  getSessionGoal: (sessionId: string) => Promise<SessionGoal | null>;
  pauseSessionGoal: (sessionId: string) => Promise<{ ok: boolean; error?: string }>;
  resumeSessionGoal: (sessionId: string) => Promise<{ ok: boolean; error?: string }>;
  clearSessionGoal: (sessionId: string) => Promise<{ ok: boolean; error?: string }>;
  onSessionGoalChanged: (
    h: (payload: { sessionId: string; goal: SessionGoal | null }) => void,
  ) => () => void;
  onAgentSpawnEvent: (
    h: (event: AgentSpawnEvent<ChatEntry>) => void,
  ) => () => void;
  onSkillLoaded: (
    h: (event: {
      name: string;
      description: string;
      sessionId: string;
    }) => void,
  ) => () => void;
  // ─── Notifications (#260) ────────────────────────
  onNotificationToast?: (h: (payload: NotificationToastPayload) => void) => () => void;
  onNotificationClicked?: (h: (payload: NotificationClickPayload) => void) => () => void;
  notifyClick?: (payload: NotificationClickPayload) => Promise<{ ok: boolean }>;

  // ─── Main-window management ─────────────────────────────────────────────
  window?: {
    resizeForMode: (mode: "chat" | "work") => Promise<{ ok: true } | { ok: false; error: string }>;
    /** Resize the chat-mode main window when the right-side work panel opens/closes. */
    resizeForSidePanel: (open: boolean) => Promise<{ ok: true } | { ok: false; error: string }>;
    openHtmlPreview: (payload: OpenHtmlPreviewWindowPayload) => Promise<OpenHtmlPreviewWindowResult>;
  };
  /**
   * Dev tools bridge — only useful in non-production NODE_ENV. Renderer
   * floating panel uses these to adjust token preflight threshold at
   * runtime. production builds reject set/get with `production-disabled`.
   */
  dev: {
    setPreflightOverride: (tokens: number | null) => Promise<
      { ok: true; value: number | null } | { ok: false; error: string }
    >;
    getPreflightStatus: () => Promise<
      | { ok: true; runtimeOverride: number | null; envOverride: number | null; effective: number; provider: string; model: string }
      | { ok: false; error: string }
    >;
  };
};

/**
 * Result of resolving a `/allow` sentence. `ok: true` carries a scope to
 * PRE-SELECT on the pending card — never a grant, and never a path. Every
 * failure is a kebab error code the renderer maps to plain localized text via
 * `COMMON_IPC_ERROR_MESSAGES`, so no outcome can read as an approval.
 */
type ApprovalSentenceSelectResult =
  | { ok: true; requestId: string; choice: ApprovalChoice }
  | { ok: false; error: string; message?: string };

  export type LvisApprovalApi = {
  onRequest: (cb: (req: ApprovalRequest) => void) => () => void;
  /**
   * One request stopped being answerable, whatever settled it host-side.
   * The queue reconciles against it: a card the surface that asked can no
   * longer take down (its tile closed, a navigation let go of it) goes here.
   */
  onSettled: (cb: (payload: { requestId: string }) => void) => () => void;
  respond: (decision: ApprovalDecision) => Promise<unknown>;
  /**
   * Requests the host is still waiting on, in the order they were asked.
   * Read once on mount: a renderer that loaded after a request went out never
   * saw it through `onRequest`.
   */
  listPending: () => Promise<ApprovalRequest[]>;
  selectSentence: (
    requestId: string,
    input: string,
  ) => Promise<ApprovalSentenceSelectResult>;
};

/** User-Approval Store API */
/**
 * Approval scope + verdict — re-uses the union literal types from the
 * shared SOT (`UserApprovalScope` / `UserApprovalVerdict`) so renderer
 * types stay in lockstep with the IPC contract. Issue #802 follow-up
 * (cross-cutting review of PRs #822-#827).
 */
import type {
  PermissionReviewSuggestionPayload,
  UserApprovalDecision,
  UserApprovalHitPayload,
  UserApprovalScope,
  UserApprovalVerdict,
} from "../../shared/permissions-events.js";

export type LvisUserApprovalApi = {
  record: (entry: {
    /** ID of the in-flight ApprovalRequest. Main process reads the
     *  authoritative trustOrigin/source/approvalCacheKey from this ID via
     *  ApprovalGate.getRequestSnapshot — renderer-supplied authority fields
     *  below are ignored (kept on the wire for legacy callers + audit). */
    requestId: string;
    toolName: string;
    args: string;
    source: string;
    decision?: UserApprovalDecision;
    scope: UserApprovalScope;
    verdictAtApproval: UserApprovalVerdict;
    nlJustification: string | null;
    /** Propagate trust origin for record/lookup key symmetry. */
    trustOrigin?: string;
    /** Propagate cache key for record/lookup key symmetry. */
    approvalCacheKey?: string;
  }) => Promise<{ ok: boolean; error?: string; message?: string }>;
  revokeByKey: (key: string) => Promise<{ ok: boolean; error?: string; message?: string }>;
  list: () => Promise<Array<{
    key: string;
    decision?: UserApprovalDecision;
    approvedAt: string;
    scope: UserApprovalScope;
    verdictAtApproval: UserApprovalVerdict;
    nlJustification: string | null;
    revokedAt: string | null;
    /** Safe display metadata. Exact input/trust/cache identity never crosses IPC. */
    toolName?: string;
    source?: string;
  }>>;
};

export type AddRuleResult =
  | { ok: true; rule: PermissionRule }
  | { ok: false; error: string; message?: string };

export type RemoveRuleResult =
  | { ok: true }
  | { ok: false; error: string; message?: string };

/** Permission policy — deferred-queue entry shape mirrored from main process. */
export interface DeferredQueueEntry {
  id: string;
  ts: string;
  toolName: string;
  source: ToolSource;
  category: ToolCategory;
  inputSummary: string;
  /** Captured policy/sandbox context for user review. */
  evaluationContext?: PermissionEvaluationContextShape;
  verdict: { level: RiskLevel; reason: string };
  /**
   * What approving this entry grants. Absent ⇒ approval is unavailable: the
   * original call is dead and this lane recorded nothing to grant forward, so
   * the UI must not offer an approve control. Mirrors `DeferredGrant`.
   */
  grant?: { kind: "directory"; path: string };
  status: "pending" | "approved" | "rejected";
  resolvedAt?: string;
  resolvedScope?: DeferredGrantScope;
  resolutionReason?: string;
}

export type PermissionReviewerMode = "disabled" | "rule" | "llm" | "strict";
export type PermissionReviewerProvider = "openai" | "anthropic" | "google" | "foundry" | "gcp-playground";
export type PermissionReviewerFallbackOnError = "deny" | "rule";
/** Issue #690 — interactive reviewer auto-approve scope. */
export type PermissionReviewerInteractiveAutoApprove = "off" | "low" | "medium";

interface PermissionReviewerParentAdjudication {
  maxVerdict: ParentAdjudicationMaxVerdict;
  timeoutMs: number;
  maxPerChildRun: number;
  /** Parent conversation turns quoted into the evidence. `0` sends none. */
  includeParentContextTurns: number;
  backgroundEscalation: ParentAdjudicationBackgroundEscalation;
  model: ParentAdjudicationModelSource;
}

export interface PermissionReviewerSettings {
  mode: PermissionReviewerMode;
  provider: PermissionReviewerProvider;
  model: string;
  fallbackOnError: PermissionReviewerFallbackOnError;
  interactive: { autoApprove: PermissionReviewerInteractiveAutoApprove };
  parentAdjudication: PermissionReviewerParentAdjudication;
}

export type PermissionReviewerDispatchResult =
  | {
      ok: true;
      verb: "show" | "mode" | "provider" | "model" | "fallback" | "interactive" | "adjudication";
      settings: PermissionReviewerSettings;
      /**
       * Runtime degrade flag — true when the persisted reviewer mode is "llm"
       * but boot wiring could not instantiate the LLM provider (no chat
       * provider/key configured) and fell back to the rule classifier. The UI
       * surfaces a banner. Undefined on legacy/main builds that do not report it.
       */
      reviewerDegradedToRule?: boolean;
    }
  | { ok: false; error: string };

export type LvisPermissionApi = {
  getMode: () => Promise<{ mode: string }>;
  setMode: (mode: string) => Promise<
    | { ok: true; mode: string }
    | { ok: false; error: string; message?: string }
  >;
  onModeChanged: (cb: (mode: string) => void) => () => void;
  /**
   * Hint event — directory config mutated. Listeners refresh state via
   * `permission.dirDispatch("list")` rather than receiving payload data
   * (slash dispatcher is the single source of truth).
   */
  onConfigChanged: (cb: () => void) => () => void;
  listRules: () => Promise<PermissionRule[]>;
  addRule: (pattern: string, action: "allow" | "deny") => Promise<AddRuleResult>;
  removeRule: (pattern: string, action: "allow" | "deny") => Promise<RemoveRuleResult>;
  /** Permission policy — list pending HIGH-risk deferred entries from reviewer. */
  deferredList: () => Promise<
    | { ok: true; pending: DeferredQueueEntry[]; total: number }
    | { ok: false; error: string }
  >;
  /** Permission policy issue #633 — list active + quarantined script hooks. */
  hookTrustList: () => Promise<
    | { ok: true; active: HookTrustRow[]; disabled: HookTrustRow[]; totalDisabled: number }
    | { ok: false; error: string }
  >;
  /** Permission policy — `/permission dir ...` slash dispatch. */
  dirDispatch: (
    rawArgs: string,
  ) => Promise<
    | { ok: true; verb: "allow"; persisted: string[]; sessionOnly: boolean; warnings: string[] }
    | { ok: true; verb: "deny"; persisted: string[] }
    | { ok: true; verb: "list"; defaults: string[]; userAdditions: string[]; effective: string[] }
    | { ok: false; error: string }
  >;
  /**
   * Permission policy — resolve a pending entry with user gesture.
   *
   * `approvalSource` records how the user gestured:
   *   - "button"           — clicked the DeferredQueuePanel button
   *   - "natural-language" — clicked the chat-surface chip after the
   *                          renderer's intent matcher detected an
   *                          approval phrase. NOT auto-applied; the
   *                          chip still requires an explicit click.
   * Required: every deferred resolution must explicitly declare
   * provenance before main writes the tamper-evident audit row.
   */
  deferredResolve: (
    id: string,
    decision: "approved" | "rejected",
    reason: string | undefined,
    approvalSource: "button" | "natural-language",
    options?: { scope?: DeferredGrantScope; acknowledgeWarnings?: boolean },
  ) => Promise<
    | { ok: true; entry: DeferredQueueEntry }
    | {
        ok: false;
        error: string;
        /** Adjacency gate — the caller must ask before retrying with ack. */
        requiresAcknowledgement?: boolean;
        warnings?: string[];
      }
  >;
  /** Permission policy — subscribe to foreground-entry deferred-pending events. */
  onDeferredPending: (cb: (summary: { pending: number }) => void) => () => void;
  /** Permission policy — subscribe to manifest-integrity violation notifications. */
  onManifestViolation: (
    handler: (payload: {
      pluginId: string;
      toolName: string;
      attempted: string;
    }) => void,
  ) => () => void;
  /**
   * Permission policy — subscribe to user-approval memory-hit
   * disclosure events. Fires when a user-approval cache entry auto-resolves
   * a tool invocation that would otherwise have prompted. Renderer is
   * expected to surface a transient toast/banner so the user sees that a
   * stored approval was applied. Returns an unsubscribe function.
   */
  onUserApprovalHit: (cb: (payload: UserApprovalHitPayload) => void) => () => void;
  /** Read-only: honest OS sandbox capability for the current platform. */
  sandboxCapability: () => Promise<SandboxCapabilityInfo>;
  /** Read-only: Windows srt-win install readiness (group + WFP + verbatim instructions). */
  sandboxWindowsStatus: () => Promise<SandboxWindowsStatusInfo>;
  /**
   * MUTATING: trigger the one-time Windows srt-win install (one self-elevating
   * UAC prompt). The ONLY user-consented privilege-escalation entry point —
   * call ONLY from an explicit "Install now" click. Resolves `{cancelled:true}`
   * on UAC dismissal (revert the toggle), else the post-install group + WFP state.
   */
  sandboxWindowsInstall: () => Promise<SandboxWindowsInstallResult>;
  /** Subscribe to default-mode repeated-approval hints for LLM permission review. */
  onReviewSuggestion?: (cb: (payload: PermissionReviewSuggestionPayload) => void) => () => void;
  /** Permission policy — `/permission reviewer ...` slash dispatch. */
  reviewerDispatch: (
    rawArgs: string,
  ) => Promise<PermissionReviewerDispatchResult>;
  /**
   * Permission policy C3 — check whether an API key (or GCP service account)
   * is stored for a given reviewer provider. Used by the settings UI to
   * determine which providers are selectable (key-driven dynamic activation).
   */
  reviewerProviderHasKey: (provider: PermissionReviewerProvider) => Promise<boolean>;
  /** Permission policy — `/permission audit show` — recent permission audit entries. */
  auditShow: (last: number) => Promise<
    | {
        ok: true;
        entries: PermissionAuditEntrySummary[];
        total: number;
        summary: { files: number; bytes: number };
      }
    | { ok: false; error: string }
  >;
  /** Permission policy — `/permission audit verify` — HMAC chain integrity check. */
  auditVerify: () => Promise<
    | {
        ok: true;
        intact: boolean;
        totalFiles: number;
        totalEntries: number;
        firstBrokenFile?: string;
        perDay: Array<{
          file: string;
          totalLines: number;
          chainOk: boolean;
          firstBrokenLineIndex?: number;
          reason?: string;
          sealMatch: boolean | null;
        }>;
      }
    | { ok: false; error: string }
  >;
};

/**
 * Permission policy — minimal audit entry shape surfaced to the renderer's
 * `AuditPanel`. The full discriminated union (with `decision` field
 * + per-decision payload) is sent verbatim — this type is just a
 * structural tag the panel uses to gate the expand/filter UI.
 */
export interface PermissionAuditEntrySummary {
  ts: string;
  auditId: string;
  decision: string;
  trustOrigin: string;
  prevHash: string;
  /** Anything else from the discriminated union — opaque to the renderer. */
  [key: string]: unknown;
}

export type LvisPolicyApi = {
  get: () => Promise<{
    version: 1;
    requireExplicitApproval: boolean;
    managed: boolean;
    updatedAt: string;
    source: "defaults" | "user" | "admin" | "merged";
    adminOverrides?: string[];
    adminPath?: string;
    /**
     * Host-derived: whether `policy.set` will be accepted. Computed by
     * `isPolicyUserEditable`, the same predicate behind `savePolicy`'s
     * blocking conditions — do NOT re-derive it in the renderer from
     * `managed`/`source`.
     */
    editable: boolean;
  }>;
  set: (patch: unknown) => Promise<{ ok: boolean; policy?: unknown; error?: string; message?: string }>;
};

export type LvisPluginConfigApi = {
  get: (pluginId: string) => Promise<
    | { ok: true; config: PluginConfigRecord }
    | { ok: false; error: string; message?: string }
  >;
  set: (pluginId: string, config: Record<string, unknown>) => Promise<
    | { ok: true; config: PluginConfigRecord }
    | { ok: false; error: string; message?: string }
  >;
  /** Fetch the manifest's declarative settings schema. */
  getSchema: (pluginId: string) => Promise<
    | { ok: true; schema: PluginConfigSchemaSummary | null }
    | { ok: false; error: string; message?: string }
  >;
  /**
   * Persist a `format: "secret"` field. The value lands in
   * the encrypted keychain (`lvis-secrets.json`) and the host strips any
   * stale cleartext mirror from `pluginConfigs`.
   */
  setSecret: (pluginId: string, key: string, value: string) => Promise<
    | { ok: true }
    | { ok: false; error: string; message?: string }
  >;



  listSecretKeys: (pluginId: string) => Promise<
    | { ok: true; keys: string[] }
    | { ok: false; error: string; message?: string }
  >;
};

export type LvisPluginsApi = {
  cards: () => Promise<PluginCardSummary[]>;
};

export type LvisHostMarketplaceApi = {
  installMarketplacePlugin: (
    id: string,
    expectedVersion?: string,
    options?: PluginMarketplaceInstallOptions,
  ) => Promise<PluginMarketplaceActionResult>;
  uninstallMarketplacePlugin: (
    id: string,
    options?: PluginMarketplaceUninstallOptions,
  ) => Promise<PluginMarketplaceActionResult>;
  rollbackMarketplacePlugin?: (id: string) => Promise<PluginMarketplaceActionResult>;
  installMarketplaceAgent?: (slug: string) => Promise<PluginMarketplaceActionResult>;
  uninstallMarketplaceAgent?: (slug: string) => Promise<PluginMarketplaceActionResult>;
  installMarketplaceSkill?: (slug: string) => Promise<PluginMarketplaceActionResult>;
  uninstallMarketplaceSkill?: (slug: string) => Promise<PluginMarketplaceActionResult>;
};

export type LvisHostApi = {
  takePluginMarketplaceApi: () => LvisHostMarketplaceApi | null;
};

export type LvisMcpApi = {
  servers: () => Promise<McpServerState[]>;
  kill: (id: string) => Promise<void>;
  getConfigs: () => Promise<McpServerConfigDto[]>;
  getConfigPath: () => Promise<string>;
  addConfig: (config: McpServerConfig) => Promise<{ connected: boolean; warning?: string }>;
  setApiKey: (id: string, apiKey: string) => Promise<{ connected: boolean; warning?: string }>;
  removeConfig: (id: string) => Promise<void>;
  /**
   * MCP Apps UI resource fetch. Returns the sandbox-proxy URL to navigate the
   * <webview> to, plus the app HTML to hand the proxy over the bridge. `csp` is
   * the server's declared policy; main sanitizes it and emits it as the proxy
   * document's CSP response header.
   */
  readUiResource: (serverId: string, uri: string, generationId?: string) => Promise<McpUiResourceBundle>;
  /**
   * MCP Apps `oncalltool` — run a tool on the card's OWN server through the host's
   * risk/consent gate. `serverId` comes from the card payload the renderer holds,
   * never from the app. Denials and tool failures come back as `{ ok: false }`.
   */
  callTool: (
    serverId: string,
    name: string,
    args: Record<string, unknown>,
    generationId?: string,
  ) => Promise<McpUiToolCallOutcome>;
  /**
   * MCP Apps `onmessage` (`ui/message`). `serverId` + `sessionId` are bound by the
   * renderer from the card (never by the app). Main decides the path: notification,
   * round-boundary guidance, or a user-gated staging card. The outcome carries NO
   * conversation content back.
   */
  /**
   * MCP server prompt (`prompts/get`). Returns the server's messages ALREADY
   * wrapped in their provenance envelope; the renderer sends that verbatim
   * under the `mcp-prompt-emitted` origin and never assembles it itself.
   */
  getPrompt: (
    serverId: string,
    name: string,
    args: Record<string, string>,
  ) => Promise<
    | { ok: true; envelope: string; truncated?: boolean; omittedBlocks?: number }
    | { ok: false; error: string }
  >;
  /**
   * Reads a DECLARED resource and returns the fenced block to attach to the user's own
   * turn. The host builds the fence; the renderer attaches it verbatim.
   */
  // OPTIONAL for the same reason `listResourceTemplates` is: the picker guards each
  // channel per row KIND, and a required type makes that guard unreachable — dead code
  // by the type, while tests and reduced harness surfaces build the API partially.
  attachResource?: (
    serverId: string,
    uri: string,
  ) => Promise<
    | {
      ok: true;
      attachment: { type: "text"; text: string };
      truncated?: boolean;
      omittedBlocks?: number;
    }
    | { ok: false; error: string }
  >;
  /**
   * The catalogue the `@` mention picker offers — `listDeclaredResources()`, the same
   * projection the model-facing tools read, so the picker cannot offer a URI the read
   * path would refuse as undeclared.
   */
  listResources: () => Promise<
    | { ok: true; servers: Array<{ serverId: string; resources: McpResourceSummary[] }> }
    | { ok: false; error: string }
  >;
  /**
   * The URI TEMPLATES half of that catalogue. A template is an OFFER, not a resource:
   * the picker renders it as a row that opens a form rather than one that attaches.
   *
   * OPTIONAL because the picker treats it as optional: a surface without it degrades to
   * resources-only rather than losing the whole catalogue. Declaring it required would
   * make that guard look like dead code and force the test that pins it to cast around
   * the type it is supposed to be checking.
   */
  listResourceTemplates?: () => Promise<
    | { ok: true; servers: Array<{ serverId: string; templates: McpResourceTemplateSummary[] }> }
    | { ok: false; error: string }
  >;
  /**
   * Fill a declared template and attach what it reads. The renderer sends the TEMPLATE
   * and the user's values; main expands and reads. `uri` comes back for the chip's
   * label. Handing it back grants nothing: `attachResource` is the only channel that
   * routes a renderer-supplied URI into the CORE-capability read, and that read is gated
   * on the listed set inside the client, which a template expansion was never in. (See
   * the handler in `ipc/domains/plugins.ts` for why this is stated so narrowly.)
   */
  attachResourceTemplate?: (
    serverId: string,
    uriTemplate: string,
    values: Record<string, string>,
  ) => Promise<
    | {
      ok: true;
      attachment: { type: "text"; text: string };
      uri: string;
      truncated?: boolean;
      omittedBlocks?: number;
    }
    | { ok: false; error: string }
  >;
  postUiMessage: (
    serverId: string,
    sessionId: string,
    params: unknown,
  ) => Promise<McpUiMessageOutcome>;
  /**
   * MCP Apps `ondownloadfile` (`ui/download-file`). `serverId` is bound by the renderer
   * from the card. Main decodes the app's INLINE bytes, bounds them, and puts the user's
   * save dialog in front of the write; it never fetches an app-supplied URI (a
   * `resource_link` is rejected). A user cancel is `{ ok: true, disposition: "cancelled" }`
   * — not an error.
   */
  downloadFile: (serverId: string, params: unknown) => Promise<McpUiDownloadOutcome>;
  /**
   * MCP Apps `onupdatemodelcontext` (`ui/update-model-context`). `serverId` + `sessionId`
   * + `cardId` are all bound by the renderer from the card. Main OVERWRITES that card's
   * one slot; the content is read at the NEXT turn's prompt build and never triggers one.
   */
  postUiModelContext: (
    serverId: string,
    sessionId: string,
    cardId: string,
    params: unknown,
  ) => Promise<McpUiModelContextOutcome>;
  /** Free a card's sandbox-proxy session token on unmount (fire-and-forget). */
  disposeUiSession: (token: string) => void;
  /** #885 b3 — subscribe to the server-disconnected broadcast; returns an unsubscribe fn. */
  onServerDisconnected: (handler: (serverId: string) => void) => () => void;
};

export type RenderHtmlPayload = {
  kind: "lvis.render_html";
  title?: string;
  height: number;
  html: string;
  warnings?: string[];
};

/**
 * Composer attachment API. Wired in `src/ipc/domains/attach.ts` (main) and
 * `src/preload.ts` (renderer bridge). Exposes file picker, image reader,
 * clipboard-image saver (writes to OS tmp), and shell-open.
 */
export interface LvisAttachApi {
  openFile: () => Promise<{
    canceled: boolean;
    files: Array<{
      path: string;
      name: string;
      ext: string;
      bytes: number;
      isImage: boolean;
      mimeType?: string;
    }>;
    rejected: string[];
  }>;
  readImage: (filePath: string) => Promise<{
    ok: boolean;
    dataUrl?: string;
    mimeType?: string;
    width?: number;
    height?: number;
    bytes?: number;
    error?: string;
  }>;
  saveClipboardImage: (base64: string) => Promise<{
    ok: boolean;
    path?: string;
    width?: number;
    height?: number;
    bytes?: number;
    mimeType?: string;
    dataUrl?: string;
    error?: string;
  }>;
  discardClipboardImage: (filePath: string) => Promise<{
    ok: boolean;
    /** The app revoked this rejected image's capability without pathname deletion. */
    retained?: true;
    error?: string;
  }>;
  openExternal: (filePath: string) => Promise<{ ok: boolean; error?: string }>;
}

/**
 * Preview file-read surface (§6.10). Reads a text file for in-panel preview,
 * gated by the SAME traversal guard as the builtin `read_file` tool — never a
 * broader read authority. `error` is a kebab-case code the renderer maps to a
 * Korean message; `message` is English dev detail.
 */
export interface LvisPreviewApi {
  readFile: (path: string) => Promise<{
    ok: boolean;
    content?: string;
    path?: string;
    bytes?: number;
    truncated?: boolean;
    error?:
      | "unauthorized"
      | "path-not-allowed"
      | "sensitive-path"
      | "not-a-file"
      | "binary-file"
      | "too-large"
      | "read-failed";
    message?: string;
  }>;
}

/**
 * Workspace file-browser surface (§6.10). Project roots are persisted to
 * `permissions.additionalDirectories` (the executor's Layer 1 allow-list SOT),
 * so a browsable folder is exactly a readable folder.
 */
export interface LvisWorkspaceApi {
  listRoots: () => Promise<{
    ok: boolean;
    defaultRoot?: string;
    roots?: Array<{ path: string; isDefault: boolean }>;
    /** Part of the settings file could not be interpreted — the roots stand. */
    settingsFault?: string;
    error?: string;
  }>;
  pickRoot: (opts?: { ackToken?: string }) => Promise<{
    ok: boolean;
    canceled?: boolean;
    added?: string;
    roots?: Array<{ path: string; isDefault: boolean }>;
    warnings?: string[];
    /** Adjacency warnings present + not persisted — renderer must confirm. */
    requiresAcknowledgement?: boolean;
    /** Picked path awaiting acknowledgement — display only. */
    pendingPath?: string;
    /** One-time token bound to the picked path — confirm by echoing it via `ackToken`. */
    ackToken?: string;
    error?: string;
  }>;
  listDir: (path: string) => Promise<{
    ok: boolean;
    path?: string;
    entries?: Array<{ name: string; path: string; type: "file" | "directory" }>;
    truncated?: boolean;
    error?: "unauthorized" | "path-not-allowed" | "sensitive-path" | "not-a-dir" | "read-failed";
    message?: string;
  }>;
  /** Remove an additional project root from the read allow-list. Never the default root. */
  removeRoot: (path: string) => Promise<{
    ok: boolean;
    removed?: string;
    roots?: Array<{ path: string; isDefault: boolean }>;
    /**
     * #1493 — count of orphaned path-scoped grants pruned because they targeted
     * a path strictly under the removed root. Non-zero counts are surfaced in
     * the removal toast so the user knows saved grants were revoked too.
     */
    prunedGrants?: number;
    error?: "unauthorized" | "invalid-path" | "not-an-additional-root" | "cannot-remove-default" | "lifecycle-failed";
    message?: string;
  }>;
  /** Reveal a scope-revalidated file/folder in the OS file manager (location only, never opens it). */
  reveal: (path: string) => Promise<{
    ok: boolean;
    error?: "unauthorized" | "path-not-allowed" | "sensitive-path" | "not-found";
    message?: string;
  }>;
  /**
   * Drag-drop add-root, step 1 (#1458). Submit a renderer-resolved dropped folder
   * path (from `window.lvisDrop.resolveDroppedPaths`) for Layer-0 hard-deny +
   * is-a-directory validation. On success returns a one-time ack token bound to
   * the now-main-owned path — confirm the add via `pickRoot({ ackToken })`.
   */
  dropPrepare: (path: string) => Promise<{
    ok: boolean;
    error?: string;
    warnings?: string[];
    /** Validated main-owned path awaiting acknowledgement — display only. */
    pendingPath?: string;
    /** One-time token bound to the path — confirm by echoing it via `pickRoot`. */
    ackToken?: string;
  }>;
}

/**
 * Drop-path resolution bridge (#1458). Exposed as its own preload world. Resolves
 * dropped `File` objects to filesystem paths via `webUtils.getPathForFile` — the
 * ONLY context that can, since a `File` cannot cross IPC. The returned paths are
 * renderer-NAMED candidates that grant no capability; the main-process
 * `workspace.dropPrepare` gate makes the read-scope decision.
 */
export interface LvisDropApi {
  resolveDroppedPaths: (files: FileList | readonly File[]) => string[];
}

export interface LvisUiApi {
  showNativeContextMenu: (
    payload: NativeContextMenuPayload,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  onNativeContextMenuAction: (
    cb: (action: NativeContextMenuAction) => void,
  ) => () => void;
  showDynamicMenu: (
    payload: DynamicNativeMenuPayload,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  onDynamicMenuAction: (
    cb: (action: DynamicNativeMenuAction) => void,
  ) => () => void;
}

/** The preload platform bridge (`window.lvisPlatform`). */
export type LvisPlatformApi = {
  isDarwin: boolean;
};

declare global {
  interface Window {
    lvisApi: LvisApi;
    lvisHost: LvisHostApi;
    /** Absent outside Electron (jsdom, Storybook) — there is no native chrome to adapt to. */
    lvisPlatform?: LvisPlatformApi;
    lvisDrop: LvisDropApi;
    lvis: {
      permission: LvisPermissionApi;
      approval: LvisApprovalApi;
      userApproval: LvisUserApprovalApi;
      policy: LvisPolicyApi;
      mcp: LvisMcpApi;
      plugins: LvisPluginsApi;
      pluginConfig: LvisPluginConfigApi;
      ui: LvisUiApi;
      attach: LvisAttachApi;
      preview: LvisPreviewApi;
      workspace: LvisWorkspaceApi;
      env: {
        isDev: boolean;
        isE2E: boolean;
        enableDevConsole: boolean;
        debugStream: boolean;
      };
    };
  }
}
