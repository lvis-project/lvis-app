// Phase 2: types extracted from src/renderer.tsx.
// Pure type declarations — no React runtime, no hook state, no side effects.

import type { PluginUiExtensionView } from "../../plugin-ui-host.js";
import type { StreamEvent } from "../../lib/chat-stream-state.js";
import type { McpServerConfig, McpServerConfigDto, McpServerState } from "../../mcp/types.js";
import type { SerializedHistoryMessage } from "../../shared/chat-history.js";
import type { PluginConfigRecord } from "../../shared/plugin-config.js";
import type { ChatSendInputOrigin } from "../../shared/chat-origin.js";
import type { ActiveRolePrompt, RolePreset } from "../../data/role-presets.js";
import type { PermissionEvaluationContext as PermissionEvaluationContextShape } from "../../permissions/evaluation-context.js";

// Re-export MCP types for renderer-side consumers (type-only, no main-process runtime)
export type { McpServerConfig, McpServerConfigDto, McpServerState };
export type { PermissionEvaluationContext } from "../../permissions/evaluation-context.js";

// Re-export checkpoint chain types for renderer-side consumers (type-only, no main-process runtime)
export type { CheckpointTrigger, Checkpoint, SessionMetadata } from "../../memory/memory-manager.js";

export type MarketplaceItem = {
  id: string;
  name: string;
  description: string;
  packageSpec: string;
  installed: boolean;
  enabled: boolean;
  isManaged?: boolean;
};

export type PluginUiExtension = PluginUiExtensionView;

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
  loadStatus?: "loaded" | "failed" | "disabled";
  version?: string;
  publisher?: string;
  /** §9.2 Track B — declarative settings schema, when the manifest declares one. */
  configSchema?: PluginConfigSchemaSummary;
  /** Optional declarative auth contract — see architecture.md §9.4a "Plugin-Owned OAuth — Host UI Surface". */
  auth?: PluginAuthSummary;
};

/**
 * Mirror of host-side `PluginAuthSpec` for renderer consumption — kept as a
 * separate name to make the renderer/host boundary explicit. Field shape
 * matches by contract (architect review §9.4a Host UI Surface).
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
  enableThinking: boolean;
  thinkingBudgetTokens: number;
};

export type AppSettings = {
  llm: {
    provider: string;
    vendors: Record<string, LLMVendorSettingsRenderer>;
    streamSmoothing: "none" | "word" | "char";
    fallbackChain: Array<{ provider: string; model: string }>;
  };
  chat: { systemPrompt: string; autoCompact: boolean };
  roles: { presets: RolePreset[] };
  webSearch: { provider: string };
  routine?: Record<string, unknown>;
  privacy?: { piiRedactEnabled: boolean };
  plugins?: Record<string, never>;
  marketplace?: {
    backend?: "real-cloud";
    realCloudBaseUrl?: string;
    realCloudAllowPrivateNetwork?: boolean;
  };
  /** UX Track 3 — visual theme preferences (v2 single bundle). */
  appearance?: {
    schemaVersion?: 2;
    bundleId?: string;
    followSystem?: boolean;
    /** User-configurable font family + size (Track A scope extension). */
    font?: {
      /** `"system"` = HOST_FONT_STACK default; otherwise a validated raw stack. */
      family?: "system" | string;
      /** Multiplier on `1rem` base. Allowed: 0.875 / 1 / 1.125 / 1.25. */
      sizeScale?: 0.875 | 1 | 1.125 | 1.25;
    };
  };
  /** §B1 — external URL viewer policy (in-app vs system browser). */
  webView?: {
    preferredFlow: "in-app" | "system-browser";
  };
  /** Experimental feature flags — all default false. */
  features?: {
    experimentalContinuousBackend?: boolean;
    idlePreferenceRefresh?: boolean;
  };
};

export type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

// ─── Plugin Performance types (Observability) ──────
export type PluginPerfStats = {
  startupMs: number;
  toolCallCount: number;
  errorCount: number;
  totalExecMs: number;
  lastCallAt: number | null;
};

// ─── Usage types (Sprint 4.B) ───────────────────────
export type UsageTotals = { inputTokens: number; outputTokens: number; totalTokens: number; cost: number };
export type UsagePerX = UsageTotals & { vendor: string; model: string };
export type UsageTrendPt = UsageTotals & { date: string };
export type UsageConv = UsageTotals & { sessionId: string; turns: number; firstInput?: string };
export type UsageSummaryShape = {
  today: UsageTotals;
  thisWeek: UsageTotals;
  thisMonth: UsageTotals;
  perVendor: UsagePerX[];
  perModel: UsagePerX[];
  trend: UsageTrendPt[];
  topConversations: UsageConv[];
  generatedAt: string;
};


export type PluginMarketplaceActionResult =
  | { ok: true; pluginId: string; installed?: true; uninstalled?: true; version?: string }
  | { ok: false; error: string; message?: string };

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
  attach: LvisAttachApi;
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
  fileScanPaths: (paths: string[]) => Promise<{ ok: boolean; indexed?: number; failed?: number; jobId?: string; error?: string }>;
  getSettings: () => Promise<AppSettings>;
  updateSettings: (patch: DeepPartial<AppSettings>) => Promise<AppSettings>;
  onSettingsUpdated: (handler: (settings: AppSettings) => void) => () => void;
  setApiKey: (vendor: string, k: string) => Promise<{ ok: true }>;
  hasApiKey: (vendor?: string) => Promise<boolean>;
  deleteApiKey: (vendor: string) => Promise<{ ok: true }>;
  setWebApiKey: (provider: string, k: string) => Promise<{ ok: true }>;
  hasWebApiKey: (provider: string) => Promise<boolean>;
  deleteWebApiKey: (provider: string) => Promise<{ ok: true }>;
  setMarketplaceApiKey: (k: string) => Promise<{ ok: true }>;
  hasMarketplaceApiKey: () => Promise<boolean>;
  deleteMarketplaceApiKey: () => Promise<{ ok: true }>;
  openSettingsWindow: (initialTab?: string) => Promise<{ ok: true; windowId: number } | { ok: false; error: string }>;
  notifySettingsWindowSaved: () => Promise<{ ok: true } | { ok: false; error: string }>;
  onSettingsWindowSaved: (handler: () => void) => () => void;
  onSettingsWindowTab: (handler: (initialTab: string) => void) => () => void;
  /** Open an http(s) URL in the system browser. Main-side rejects any other scheme. */
  openExternalUrl: (url: string) => Promise<{
    ok: boolean;
    error?: string;
    protocol?: string;
    message?: string;
  }>;
  /** #FU259 — MCP catalog (filtered to plugin_type === "mcp"). */
  listMcpCatalog: () => Promise<Array<{
    id: string;
    name: string;
    description: string;
    version?: string;
    publisher?: string;
    pluginType?: "plugin" | "mcp";
    installed: boolean;
    enabled: boolean;
    isManaged?: boolean;
  }>>;
  installMcpFromMarketplace: (slug: string) => Promise<
    | { ok: true; slug: string; installDir: string; connected: boolean; warning?: string; needsCredential: boolean; authMode: "none" | "api-key" | "sso" }
    | { ok: false; error: string; message: string }
  >;
  /** #FU262 — Claude Desktop config import. */
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
    rolePrompt?: ActiveRolePrompt,
  ) => Promise<unknown>;
  chatGuide: (input: string) => Promise<unknown>;
  chatNew: () => Promise<{ ok: true }>;
  chatSessions: (opts?: { limit?: number; before?: string; beforeId?: string; after?: string }) => Promise<{ current: string; sessions: Array<{ id: string; modifiedAt: string; title: string; parentSessionId?: string; branchedFromCompactNum?: number }> }>;
  chatLoadSession: (sessionId: string) => Promise<{ ok: boolean; sessionId: string | null }>;
  onChatStream: (h: (e: StreamEvent) => void) => () => void;
  onChatFallback: (h: (payload: { from: string; to: string }) => void) => () => void;
  chatGetHistory: () => Promise<{ sessionId: string; messages: SerializedHistoryMessage[]; estimatedInputTokens?: number }>;
  chatSessionHistory: (sessionId: string) => Promise<{
    ok: boolean;
    messages: SerializedHistoryMessage[];
    estimatedInputTokens?: number;
    /** §457 PR-A: chars in the rolling summary preamble inherited from parent. 0 = no preamble. */
    preambleChars?: number;
    /** §457 PR-A: parent session id when this session is a rotation child. */
    parentSessionId?: string;
  }>;
  chatEditResend: (messageIndex: number, newText: string) => Promise<{ ok: boolean; error?: string }>;
  chatFork: (messageIndex: number) => Promise<{ ok: boolean; sessionId: string | null }>;
  chatRetryEffort: (opts?: { thinkingBudgetTokens?: number; enableThinking?: boolean }) => Promise<{ ok: boolean; error?: string }>;
  chatExport: (format: "markdown" | "json") => Promise<{ ok: boolean; filePath?: string; canceled?: boolean; error?: string }>;
  chatCompact: () => Promise<{ compacted: boolean; compactedAt: string | null; summary: string; removedMessageCount: number }>;
  chatSessionResume: (sessionId: string) => Promise<{ ok: boolean; compacted: boolean; compactedAt: string | null; removedMessageCount: number }>;
  // §PR-5: Layer 3 View-Mode + Branch
  // Note: enter/branch return discriminated unions without `ok`; exit follows the
  // standard { ok: boolean } pattern. Callers guard with `"error" in result`.
  chatEnterCheckpointView: (sessionId: string, compactNum: number) => Promise<{ messageIndexAtCreation: number } | { error: string }>;
  chatExitCheckpointView: () => Promise<{ ok: boolean }>;
  chatBranchFromCheckpoint: (sessionId: string, compactNum: number) => Promise<{ newSessionId: string } | { error: string }>;
  chatAbort: () => Promise<{ ok: boolean }>;
  /** PR-4: lazy-load in-session verbatim content for a compacted tool_result.
   * Returns null when: session has rotated, toolUseId not found, verbatim
   * already flushed to disk stub, or meta.compactedAt was never set. lineCount
   * is pre-computed server-side. */
  chatGetVerbatimToolResult: (
    sessionId: string,
    toolUseId: string,
  ) => Promise<{ content: string; lineCount: number } | null>;
  submitFeedback: (payload: { sessionId: string; messageIndex: number; rating: "up" | "down"; reason?: string }) => Promise<{ ok: boolean; error?: string }>;
  starredList: () => Promise<Array<{ id: string; sessionId: string; messageIndex: number; role: string; text: string; starredAt: string }>>;
  starredAdd: (entry: { sessionId?: string; messageIndex: number; role: string; text: string }) => Promise<{ ok: boolean; entry?: { id: string; sessionId: string; messageIndex: number; role: string; text: string; starredAt: string } }>;
  starredRemove: (opts: { id?: string; sessionId?: string; messageIndex?: number }) => Promise<{ ok: boolean }>;
  memoryListEntries: () => Promise<Array<{ filename: string; title: string; content: string; updatedAt?: string }>>;
  memorySaveEntry: (t: string, c: string) => Promise<unknown>;
  memoryDeleteEntry: (f: string) => Promise<void>;
  memorySearchEntries: (q: string) => Promise<Array<{ filename?: string; title: string; content?: string; excerpt: string; updatedAt: string }>>;
  memoryGetIndex: () => Promise<string>;
  memoryUpdateIndexIfUnchanged: (expectedContent: string, nextContent: string) => Promise<boolean>;
  memoryUpdateIndexSections: (sections: { urgentMemory?: string; references?: string }) => Promise<unknown>;
  memoryListSessions: () => Promise<Array<{ sessionId: string; matchedMessage: string; timestamp: string }>>;
  memorySearchSessions: (q: string) => Promise<Array<{ sessionId: string; matchedMessage: string; timestamp: string }>>;
  memoryGetAgentsMd: () => Promise<string>;
  memoryUpdateAgentsMd: (content: string) => Promise<unknown>;
  memoryGetLvisMd: () => Promise<string>;
  memoryUpdateLvisMd: (content: string) => Promise<unknown>;
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
  listMarketplacePlugins: () => Promise<MarketplaceItem[]>;
  listPluginUiExtensions: () => Promise<PluginUiExtension[]>;
  readPluginUiModule: (pluginId: string, viewId: string) => Promise<string>;
  callPluginMethod: (m: string, p?: unknown) => Promise<unknown>;
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
  // schedule_routine v2 — persistent routine list + lifecycle
  listRoutinesV2: () => Promise<import("../../shared/routines-types.js").RoutineRecord[]>;
  dismissRoutineV2: (id: string) => Promise<{ ok: boolean; error?: string }>;
  removeRoutineV2: (id: string) => Promise<{ ok: boolean; error?: string }>;
  triggerRoutineNowV2: (id: string) => Promise<{ ok: boolean; error?: string }>;
  listPendingRoutineResultsV2: () => Promise<import("../../shared/routines-types.js").RoutineFiredPayload[]>;
  acknowledgeRoutineResultV2: (routineId: string, firedAt: string) => Promise<{ ok: boolean; error?: string }>;
  addRoutineV2: (
    input: import("../../shared/routines-types.js").AddRoutineInput,
  ) => Promise<
    | { ok: true; routine: import("../../shared/routines-types.js").RoutineRecord }
    | { ok: false; error: string }
  >;
  onRoutineFiredV2: (
    handler: (event: import("../../shared/routines-types.js").RoutineFiredPayload) => void,
  ) => () => void;
  // Routine running indicator
  // C1: enriched payload includes title+firedAt so renderer can push OverlayItem immediately
  onRoutineRunningStarted: (handler: (payload: { routineId: string; firedAt: string; title: string }) => void) => () => void;
  onRoutineRunningFinished: (handler: (routineId: string) => void) => () => void;
  // failed: clears running:true stuck OverlayItem when the LLM session throws
  onRoutineFailedV2: (handler: (event: { routineId: string; error: string }) => void) => () => void;
  // Overlay IPC bridges
  onOverlayShow: (handler: (item: import("./context/OverlayContext.js").OverlayItem) => void) => () => void;
  onOverlayUpdate: (handler: (id: string, patch: Partial<import("./context/OverlayContext.js").OverlayItem>) => void) => () => void;
  onOverlayDismiss: (handler: (id: string) => void) => () => void;
  notifyOverlayPrimary: (pluginId: string, eventId: string) => Promise<void>;
  // Routine session history
  listRoutineSessionsV2: (
    routineId: string,
    limit?: number,
  ) => Promise<Array<{ routineId: string; firedAt: string; jsonlPath: string }>>;
  readRoutineSessionV2: (jsonlPath: string) => Promise<string>;
  onMarketplaceUpdatesAvailable: (h: (updates: Array<{ pluginId: string; installedVersion: string; latestVersion: string }>) => void) => () => void;
  onBootstrapStatus: (
    h: (status:
      | { phase: "start" }
      | { phase: "complete"; installed: string[]; failed: Array<{ id: string; error: string }>; skippedReason?: string }
      | { phase: "error"; message: string }
    ) => void,
  ) => () => void;
  retryBootstrap: () => Promise<{ ok: true } | { ok: false; error: string }>;
  onPluginInstallResult: (h: (payload: { slug: string; success: boolean; error?: string }) => void) => () => void;
  onPluginUninstallResult: (h: (payload: { slug: string; success: boolean; error?: string }) => void) => () => void;
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
    | { slug: string; phase: "installing" | "restarting" | "verifying" | "registering" }
    | { slug: string; phase: "downloading"; bytesDownloaded: number; bytesTotal: number | null }
  ) => void) => () => void;
  getRuntimeCounts: () => Promise<{ tools: number; plugins: number; mcps: number }>;
  getRuntimeEnv: () => Promise<{ platform: string; hostname: string; user: string }>;
  pingMarketplace: () => Promise<{ configured: boolean; online: boolean }>;
  registerPluginWebview: (payload: { webContentsId: number; pluginId: string; entryUrl: string }) => Promise<{ ok: boolean; error?: string }>;
  onViewActivate: (h: (k: string) => void) => () => void;
  getUsageSummary: (days?: number) => Promise<UsageSummaryShape>;
  getUsageRange: (opts: { dateFrom: string; dateTo: string }) => Promise<UsageSummaryShape>;
  exportUsageCsv: (rows: Array<Record<string, string | number>>) => Promise<{ ok: boolean; filePath?: string; canceled?: boolean }>;
  plugins: {
    getPerfStats: () => Promise<Record<string, PluginPerfStats>>;
  };
  // Workflow tools — routines v2
  onAskUserQuestion: (
    h: (req: {
      id: string;
      questions: Array<{
        question: string;
        choices?: string[];
        allowFreeText: boolean;
        suggestedAnswers?: string[];
      }>;
      createdAt: number;
    }) => void,
  ) => () => void;
  respondAskUserQuestion: (response: {
    requestId: string;
    answers?: Array<{ choice?: string; freeText?: string }>;
    dismissed?: boolean;
  }) => Promise<{ ok: boolean; error?: string }>;
  /** Renderer is notified when the gate's 5-minute timeout fires. */
  onAskUserQuestionTimeout?: (
    h: (payload: { requestId: string }) => void,
  ) => () => void;
  listSessionTodos: (sessionId?: string) => Promise<
    Array<{ id: string; content: string; status: string }>
  >;
  onSessionTodoChanged: (
    h: (payload: {
      sessionId: string;
      items: Array<{ id: string; content: string; status: string }>;
    }) => void,
  ) => () => void;
  onAgentSpawnEvent: (
    h: (event: {
      spawnId: string;
      type: "start" | "turn" | "done" | "error";
      title?: string;
      turn?: number;
      text?: string;
      summary?: string;
      toolCallCount?: number;
      message?: string;
      toolUseId?: string;
    }) => void,
  ) => () => void;
  onSkillLoaded: (
    h: (event: {
      name: string;
      description: string;
      source: "user" | "builtin";
    }) => void,
  ) => () => void;
  // ─── Notifications (#260) ────────────────────────
  onNotificationToast?: (
    h: (payload: {
      kind: "turn-end" | "routine" | "ask-user" | "approval";
      title: string;
      body: string;
      contextRef?: {
        sessionId?: string;
        routineId?: string;
        questionId?: string;
        approvalId?: string;
      };
    }) => void,
  ) => () => void;
  onNotificationClicked?: (
    h: (payload: {
      kind: "turn-end" | "routine" | "ask-user" | "approval";
      contextRef?: {
        sessionId?: string;
        routineId?: string;
        questionId?: string;
        approvalId?: string;
      };
    }) => void,
  ) => () => void;
  notifyClick?: (payload: {
    kind: "turn-end" | "routine" | "ask-user" | "approval";
    contextRef?: {
      sessionId?: string;
      routineId?: string;
      questionId?: string;
      approvalId?: string;
    };
  }) => Promise<{ ok: boolean }>;

  // ─── Window management (tab detach + magnetic snap) ─────────────────────
  window?: {
    openDetached: (viewKey: string) => Promise<{ ok: true; windowId: number } | { ok: false; error: string }>;
    closeDetached: () => Promise<{ ok: true } | { ok: false; error: string }>;
    listDetached: () => Promise<Array<{ windowId: number; viewKey: string; snapped: boolean }>>;
    loadSessionInMain: (sessionId: string) => Promise<{ ok: true } | { ok: false; error: string }>;
    onSnapEdge: (handler: (edge: "n" | "s" | "e" | "w" | null) => void) => () => void;
    /** Subscribe to in-place navigation (single-instance shell content swap). */
    onDetachedNavigate: (handler: (viewKey: string) => void) => () => void;
    onLoadSessionInMain: (handler: (sessionId: string) => void) => () => void;
  };
};

// ─── Approval types (mirrored from approval-gate.ts — no node import in renderer) ─
export type ApprovalChoice = "allow-once" | "allow-always" | "deny-once" | "deny-always";

/**
 * Permission policy — discriminated approval kinds. Renderer routes on this to
 * pick the right card. Default `"tool"` is the standard §6.3 dialog.
 */
export type ApprovalKind = "tool" | "out-of-allowed-dir";

export type ApprovalRequest = {
  id: string;
  category: "tool";
  /** Permission policy — discriminator (defaults to "tool" when absent). */
  kind?: ApprovalKind;
  toolName: string;
  /** Permission policy category for the invocation shown in the UI. */
  toolCategory?: "read" | "write" | "shell" | "network" | "meta";
  /** Layer 5 reviewer verdict when the ask came from auto-review. */
  reviewerVerdict?: { level: "low" | "medium" | "high"; reason: string };
  /** Captured policy/sandbox context for user review. */
  evaluationContext?: PermissionEvaluationContextShape;
  args: unknown;
  reason: string;
  source?: "builtin" | "plugin" | "mcp";
  createdAt: number;
  requireExplicit: boolean;
  target?: { filePath?: string };
  isReadOnly?: boolean;
  mode?: "default" | "ask_all" | "plan" | "full_auto";
  /** §D2: nonce issued by the main process; renderer echoes verbatim. */
  nonce?: string;
  /** §D2: HMAC over (id, nonce, toolName, args) — echoed verbatim. */
  hmac?: string;
  /**
   * Permission policy — present when `kind === "out-of-allowed-dir"`. Carries
   * the auto-suggest payload so the renderer can render the directory-
   * confirm card without re-running validation.
   */
  outOfAllowedDir?: {
    candidatePath: string;
    suggestedParent: string | null;
    currentAllowed: readonly string[];
    adjacencyWarnings: readonly string[];
  };
  /** Permission policy §9 — trust-origin classification, e.g. "user" / "agent". */
  trustOrigin?: string;
};
export type ApprovalDecision = {
  requestId: string;
  choice: ApprovalChoice;
  rememberPattern?: string;
  /** §D2: echoed nonce from the matching ApprovalRequest. */
  nonce?: string;
  /** §D2: echoed HMAC from the matching ApprovalRequest. */
  hmac?: string;
};

  export type LvisApprovalApi = {
  onRequest: (cb: (req: ApprovalRequest) => void) => () => void;
  respond: (decision: ApprovalDecision) => Promise<unknown>;
};

export type PermissionRule = { pattern: string; action: "allow" | "deny"; source?: string };

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
  source: "builtin" | "plugin" | "mcp";
  category: "read" | "write" | "shell" | "network" | "meta";
  inputSummary: string;
  /** Captured policy/sandbox context for user review. */
  evaluationContext?: PermissionEvaluationContextShape;
  verdict: { level: "low" | "medium" | "high"; reason: string };
  status: "pending" | "approved" | "rejected";
  resolvedAt?: string;
  resolutionReason?: string;
}

export interface HookTrustRow {
  fileName: string;
  hookType: "pre" | "post" | "perm";
  sha256: string;
  state: "trusted" | "new" | "changed" | "removed" | "disabled";
  previousSha256?: string;
}

export type PermissionReviewerMode = "disabled" | "rule" | "llm";
export type PermissionReviewerProvider = "openai" | "anthropic" | "google";
export type PermissionReviewerFallbackOnError = "deny" | "rule";
/** Issue #690 — interactive reviewer auto-approve scope. */
export type PermissionReviewerInteractiveAutoApprove = "off" | "low";

export interface PermissionReviewerSettings {
  mode: PermissionReviewerMode;
  provider: PermissionReviewerProvider;
  model: string;
  fallbackOnError: PermissionReviewerFallbackOnError;
  interactive: { autoApprove: PermissionReviewerInteractiveAutoApprove };
}

export type PermissionReviewerDispatchResult =
  | {
      ok: true;
      verb: "show" | "mode" | "provider" | "model" | "fallback" | "interactive";
      settings: PermissionReviewerSettings;
    }
  | { ok: false; error: string };

export type LvisPermissionApi = {
  getMode: () => Promise<{ mode: string }>;
  setMode: (mode: string) => Promise<
    | { ok: true; mode: string }
    | { ok: false; error: string; message?: string }
  >;
  onModeChanged: (cb: (mode: string) => void) => () => void;
  listRules: () => Promise<PermissionRule[]>;
  addRule: (pattern: string, action: "allow" | "deny") => Promise<AddRuleResult>;
  removeRule: (pattern: string, action: "allow" | "deny") => Promise<RemoveRuleResult>;
  /** Permission policy — list pending HIGH-risk deferred entries (Layer 5 reviewer). */
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
   * `approvalSource` (issue #690 P4) records how the user gestured:
   *   - "button"           — clicked the DeferredQueuePanel button
   *   - "natural-language" — clicked the chat-surface chip after the
   *                          renderer's intent matcher detected an
   *                          approval phrase. NOT auto-applied; the
   *                          chip still requires an explicit click.
   * Optional for backward compatibility; main treats `undefined` as
   * "button".
   */
  deferredResolve: (
    id: string,
    decision: "approved" | "rejected",
    reason?: string,
    approvalSource?: "button" | "natural-language",
  ) => Promise<
    | { ok: true; entry: DeferredQueueEntry }
    | { ok: false; error: string }
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
  /** Permission policy — `/permission reviewer ...` slash dispatch. */
  reviewerDispatch: (
    rawArgs: string,
  ) => Promise<PermissionReviewerDispatchResult>;
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
  /** §9.2 Track B — fetch the manifest's declarative settings schema. */
  getSchema: (pluginId: string) => Promise<
    | { ok: true; schema: PluginConfigSchemaSummary | null }
    | { ok: false; error: string; message?: string }
  >;
  /**
   * §9.2 Track B — persist a `format: "secret"` field. The value lands in
   * the encrypted keychain (`lvis-secrets.json`) and the host strips any
   * stale cleartext mirror from `pluginConfigs`.
   */
  setSecret: (pluginId: string, key: string, value: string) => Promise<
    | { ok: true }
    | { ok: false; error: string; message?: string }
  >;
  /**
   * US-3c.1 — batch secret-presence query. Returns the list of
   * `format:"secret"` keys from the plugin's configSchema for which the
   * keychain currently holds a value. Use this to populate `secretsPresent`
   * in PluginConfigSchemaForm so the masked "**** (저장됨)" placeholder
   * appears correctly. Fewer IPC round-trips than per-key checks.
   */
  listSecretKeys: (pluginId: string) => Promise<
    | { ok: true; keys: string[] }
    | { ok: false; error: string; message?: string }
  >;
};

export type LvisPluginsApi = {
  cards: () => Promise<PluginCardSummary[]>;
};

export type LvisHostMarketplaceApi = {
  installMarketplacePlugin: (id: string) => Promise<PluginMarketplaceActionResult>;
  uninstallMarketplacePlugin: (id: string) => Promise<PluginMarketplaceActionResult>;
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
  removeConfig: (id: string) => Promise<void>;
  /** MCP Apps spec §3.3 — fetch a ui:// resource from the MCP server. */
  readUiResource: (serverId: string, uri: string) => Promise<string>;
};

export type ExecMode = "default" | "strict" | "auto" | "allow";

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
  openExternal: (filePath: string) => Promise<{ ok: boolean; error?: string }>;
}

declare global {
  interface Window {
    lvisApi: LvisApi;
    lvisHost: LvisHostApi;
    lvis: {
      permission: LvisPermissionApi;
      approval: LvisApprovalApi;
      policy: LvisPolicyApi;
      mcp: LvisMcpApi;
      plugins: LvisPluginsApi;
      pluginConfig: LvisPluginConfigApi;
      attach: LvisAttachApi;
      env: {
        isDev: boolean;
        enableDevConsole: boolean;
        debugStream: boolean;
      };
    };
  }
}
