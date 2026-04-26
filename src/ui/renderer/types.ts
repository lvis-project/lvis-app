// Phase 2: types extracted from src/renderer.tsx.
// Pure type declarations — no React runtime, no hook state, no side effects.

import type { PluginUiExtensionView } from "../../plugin-ui-host.js";
import type { StreamEvent } from "../../lib/chat-stream-state.js";
import type { McpServerConfig, McpServerConfigDto, McpServerState } from "../../mcp/types.js";
import type { ScheduleAgentId, ScheduleRoutineEntry, ScheduleRoutineSchedule } from "../../routines/schedule.js";
import type { PluginConfigRecord } from "../../shared/plugin-config.js";

// Re-export MCP types for renderer-side consumers (type-only, no main-process runtime)
export type { McpServerConfig, McpServerConfigDto, McpServerState };

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

export type Task = {
  id: string;
  title: string;
  description?: string;
  source: string;
  priority: "high" | "medium" | "low";
  status: "pending" | "done" | "snoozed";
  dueAt?: string;
  createdAt: string;
  updatedAt: string;
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
  loadStatus?: "loaded" | "failed" | "disabled";
  version?: string;
  publisher?: string;
};

export type AppSettings = {
  llm: {
    provider: string;
    model: string;
    enableThinking?: boolean;
    thinkingBudgetTokens?: number;
    baseUrls?: Record<string, string>;
    vertexProject?: string;
    vertexLocation?: string;
    temperature?: number;
    maxOutputTokens?: number;
    seed?: number;
    responseFormat?: "text" | "json";
    stopSequences?: string[];
    streamSmoothing?: "none" | "word" | "char";
    fallbackChain?: Array<{ provider: string; model: string }>;
  };
  chat: { systemPrompt: string; autoCompact: boolean };
  webSearch: { provider: string };
  routine?: {
    enableWakeupRoutine: boolean;
    lastWakeupRoutineAt?: string;
    lastDismissedAt?: string;
    scheduleTimeKst?: string;
    wakeupRoutinePrompt?: string;
    enableScheduleRoutine?: boolean;
    scheduleEntries?: ScheduleRoutineEntry[];
    enableShutdownRoutine?: boolean;
    shutdownPrompt?: string;
  };
  privacy?: { piiRedactEnabled: boolean };
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

export type RoutineSessionSummary = {
  id: string;
  modifiedAt: string;
  title: string;
};

export type RoutineRecord = {
  id: string;
  title: string;
  description: string;
  trigger: "wakeup" | "schedule" | "shutdown";
  enabled: boolean;
  scheduleTimeKst?: string;
  contextPrompt?: string;
  scheduleEntries?: Array<ScheduleRoutineEntry & { cron: string }>;
  sessionCount: number;
  sessions: RoutineSessionSummary[];
};

export type PluginMarketplaceActionResult =
  | { ok: true; pluginId: string; installed?: true; uninstalled?: true; version?: string }
  | { ok: false; error: string; message?: string };

export type LvisApi = {
  getSettings: () => Promise<AppSettings>;
  updateSettings: (patch: DeepPartial<AppSettings>) => Promise<AppSettings>;
  setApiKey: (vendor: string, k: string) => Promise<{ ok: true }>;
  hasApiKey: (vendor?: string) => Promise<boolean>;
  deleteApiKey: (vendor: string) => Promise<{ ok: true }>;
  setWebApiKey: (provider: string, k: string) => Promise<{ ok: true }>;
  hasWebApiKey: (provider: string) => Promise<boolean>;
  deleteWebApiKey: (provider: string) => Promise<{ ok: true }>;
  msGraphGetState: () => Promise<{
    environment: "external" | "corporate";
    isAuthenticated: boolean;
    account: string | null;
    configured: boolean;
    label: string;
    environments: Array<{
      id: "external" | "corporate";
      label: string;
      description: string;
      configured: boolean;
    }>;
  }>;
  msGraphSwitchEnvironment: (env: "external" | "corporate") => Promise<{ ok: boolean; state?: unknown }>;
  msGraphSignIn: () => Promise<{ ok: boolean; error?: string; state?: unknown }>;
  msGraphSignOut: () => Promise<{ ok: boolean; state?: unknown }>;
  chatHasProvider: () => Promise<boolean>;
  chatSend: (input: string) => Promise<unknown>;
  chatGuide: (input: string) => Promise<unknown>;
  chatNew: () => Promise<{ ok: true }>;
  chatSessions: () => Promise<{ current: string; sessions: Array<{ id: string; modifiedAt: string; title: string }> }>;
  chatLoadSession: (sessionId: string) => Promise<{ ok: boolean; sessionId: string | null }>;
  onChatStream: (h: (e: StreamEvent) => void) => () => void;
  onChatFallback: (h: (payload: { from: string; to: string }) => void) => () => void;
  chatGetHistory: () => Promise<{ sessionId: string; messages: Array<{ index: number; role: string; content: string; toolName?: string; isError?: boolean }> }>;
  chatEditResend: (messageIndex: number, newText: string) => Promise<{ ok: boolean; error?: string }>;
  chatFork: (messageIndex: number) => Promise<{ ok: boolean; sessionId: string | null }>;
  chatRetryEffort: (opts?: { thinkingBudgetTokens?: number; enableThinking?: boolean }) => Promise<{ ok: boolean; error?: string }>;
  chatExport: (format: "markdown" | "json") => Promise<{ ok: boolean; filePath?: string; canceled?: boolean; error?: string }>;
  chatCompact: () => Promise<{ compacted: boolean; compactedAt: string | null; summary: string; removedMessageCount: number }>;
  chatSessionResume: (sessionId: string) => Promise<{ ok: boolean; compacted: boolean; compactedAt: string | null; removedMessageCount: number }>;
  chatAbort: () => Promise<{ ok: boolean }>;
  submitFeedback: (payload: { sessionId: string; messageIndex: number; rating: "up" | "down"; reason?: string }) => Promise<{ ok: boolean; error?: string }>;
  starredList: () => Promise<Array<{ id: string; sessionId: string; messageIndex: number; role: string; text: string; starredAt: string }>>;
  starredAdd: (entry: { sessionId?: string; messageIndex: number; role: string; text: string }) => Promise<{ ok: boolean; entry?: { id: string; sessionId: string; messageIndex: number; role: string; text: string; starredAt: string } }>;
  starredRemove: (opts: { id?: string; sessionId?: string; messageIndex?: number }) => Promise<{ ok: boolean }>;
  memoryListEntries: () => Promise<Array<{ filename: string; title: string; content: string; updatedAt?: string }>>;
  memorySaveEntry: (t: string, c: string) => Promise<unknown>;
  memoryDeleteEntry: (f: string) => Promise<void>;
  memorySearchEntries: (q: string) => Promise<Array<{ filename?: string; title: string; content?: string; excerpt: string; updatedAt: string }>>;
  memoryListSessions: () => Promise<Array<{ sessionId: string; matchedMessage: string; timestamp: string }>>;
  memorySearchSessions: (q: string) => Promise<Array<{ sessionId: string; matchedMessage: string; timestamp: string }>>;
  listMarketplacePlugins: () => Promise<MarketplaceItem[]>;
  listPluginUiExtensions: () => Promise<PluginUiExtension[]>;
  readPluginUiModule: (pluginId: string, viewId: string) => Promise<string>;
  callPluginMethod: (m: string, p?: unknown) => Promise<unknown>;
  listPluginCards: () => Promise<PluginCardSummary[]>;
  addTask: (t: unknown) => Promise<Task>;
  queryTasks: (f?: unknown) => Promise<Task[]>;
  updateTask: (id: string, p: unknown) => Promise<Task>;
  deleteTask: (id: string) => Promise<void>;
  getTodayTasks: () => Promise<Task[]>;
  getOverdueTasks: () => Promise<Task[]>;
  listRoutines: () => Promise<RoutineRecord[]>;
  updateRoutine: (
    routineId: string,
    patch: {
      enabled?: boolean;
      scheduleTimeKst?: string;
      contextPrompt?: string;
      scheduleEntries?: Array<{
        id: string;
        enabled: boolean;
        agentId: ScheduleAgentId;
        schedule: ScheduleRoutineSchedule;
        prompt: string;
      }>;
    },
  ) => Promise<{ ok: boolean; error?: string }>;
  startRoutineSession: (routineId: string) => Promise<{ ok: boolean; sessionId?: string; error?: string }>;
  getLatestRoutineResult: () => Promise<{ routineId: string; trigger: string; summary: string; generatedAt: string } | null>;
  triggerWakeupRoutineDev: () => Promise<{ ok: boolean; summary?: string; error?: string }>;
  triggerScheduleRoutineDev: () => Promise<{ ok: boolean; summary?: string; error?: string }>;
  triggerShutdownRoutineDev: () => Promise<{ ok: boolean; summary?: string; error?: string }>;
  onRoutineStarted: (h: (payload: { routineId: string; trigger: string; startedAt: string }) => void) => () => void;
  onRoutineCompleted: (h: (result: { routineId: string; trigger: string; summary: string; generatedAt: string }) => void) => () => void;
  // Brain — proactive trigger lifecycle
  onTriggerStarted: (
    h: (payload: {
      sessionId: string;
      source: string;
      visibility: "silent" | "summary-only" | "user-visible";
      priority: "low" | "normal" | "high";
      startedAt: string;
    }) => void,
  ) => () => void;
  onTriggerCompleted: (
    h: (result: {
      sessionId: string;
      source: string;
      visibility: "silent" | "summary-only" | "user-visible";
      priority: "low" | "normal" | "high";
      prompt: string;
      summary: string;
      completedAt: string;
    }) => void,
  ) => () => void;
  onTriggerFailed: (
    h: (payload: { sessionId: string; source: string; error: string }) => void,
  ) => () => void;
  dismissTrigger: (sessionId: string) => Promise<{ ok: boolean; removed?: boolean; error?: string }>;
  importTrigger: (sessionId: string) => Promise<{ ok: boolean; imported?: number; reason?: string; error?: string }>;
  onMarketplaceUpdatesAvailable: (h: (updates: Array<{ pluginId: string; installedVersion: string; latestVersion: string }>) => void) => () => void;
  onPluginInstallResult: (h: (payload: { slug: string; success: boolean; error?: string }) => void) => () => void;
  onViewActivate: (h: (k: string) => void) => () => void;
  getUsageSummary: (days?: number) => Promise<UsageSummaryShape>;
  getUsageRange: (opts: { dateFrom: string; dateTo: string }) => Promise<UsageSummaryShape>;
  exportUsageCsv: (rows: Array<Record<string, string | number>>) => Promise<{ ok: boolean; filePath?: string; canceled?: boolean }>;
  plugins: {
    getPerfStats: () => Promise<Record<string, PluginPerfStats>>;
  };
};

// ─── Approval types (mirrored from approval-gate.ts — no node import in renderer) ─
export type ApprovalChoice = "allow-once" | "allow-always" | "deny-once" | "deny-always";
export type ApprovalRequest = {
  id: string;
  category: "tool";
  toolName: string;
  args: unknown;
  reason: string;
  source?: "builtin" | "plugin" | "mcp";
  createdAt: number;
  requireExplicit: boolean;
  target?: { filePath?: string };
  isReadOnly?: boolean;
  mode?: "default" | "plan" | "full_auto";
  /** §D2: nonce issued by the main process; renderer echoes verbatim. */
  nonce?: string;
  /** §D2: HMAC over (id, nonce, toolName, args) — echoed verbatim. */
  hmac?: string;
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

export type LvisPermissionApi = {
  getMode: () => Promise<{ mode: string }>;
  setMode: (mode: string) => Promise<{ ok: boolean; mode: string }>;
  listRules: () => Promise<PermissionRule[]>;
  addRule: (pattern: string, action: "allow" | "deny") => Promise<AddRuleResult>;
  removeRule: (pattern: string, action: "allow" | "deny") => Promise<RemoveRuleResult>;
};

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

export type ExecMode = "default" | "strict" | "auto";

export type RenderHtmlPayload = {
  kind: "lvis.render_html";
  title?: string;
  height: number;
  html: string;
  warnings?: string[];
};

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
      env: {
        isDev: boolean;
        enableDevConsole: boolean;
      };
    };
  }
}
