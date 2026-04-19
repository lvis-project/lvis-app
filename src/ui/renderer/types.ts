// Phase 2: types extracted from src/renderer.tsx.
// Pure type declarations — no React runtime, no hook state, no side effects.

import type { PluginUiExtensionView } from "../../plugin-ui-host.js";
import type { StreamEvent } from "../../lib/chat-stream-state.js";

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
  };
  chat: { systemPrompt: string; autoCompact: boolean };
  webSearch: { provider: string };
  proactive?: { enableDailyBriefing: boolean; lastBriefingAt?: string; lastDismissedAt?: string };
  privacy?: { piiRedactEnabled: boolean };
};

export type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

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

export type BriefingPayload = {
  generatedAt: string;
  items: Array<{ category: string; priority: string; title: string; detail?: string }>;
  summary?: string;
};

export type LvisApi = {
  getSettings: () => Promise<AppSettings>;
  updateSettings: (patch: DeepPartial<AppSettings>) => Promise<AppSettings>;
  setApiKey: (vendor: string, k: string) => Promise<{ ok: true }>;
  hasApiKey: (vendor?: string) => Promise<boolean>;
  deleteApiKey: (vendor: string) => Promise<{ ok: true }>;
  setWebApiKey: (provider: string, k: string) => Promise<{ ok: true }>;
  hasWebApiKey: (provider: string) => Promise<boolean>;
  deleteWebApiKey: (provider: string) => Promise<{ ok: true }>;
  chatHasProvider: () => Promise<boolean>;
  chatSend: (input: string) => Promise<unknown>;
  chatNew: () => Promise<{ ok: true }>;
  chatSessions: () => Promise<{ current: string; sessions: Array<{ id: string; modifiedAt: string }> }>;
  chatLoadSession: (sessionId: string) => Promise<{ ok: boolean; sessionId: string | null }>;
  onChatStream: (h: (e: StreamEvent) => void) => () => void;
  chatGetHistory: () => Promise<{ sessionId: string; messages: Array<{ index: number; role: string; content: string; toolName?: string; isError?: boolean }> }>;
  chatEditResend: (messageIndex: number, newText: string) => Promise<{ ok: boolean; error?: string }>;
  chatFork: (messageIndex: number) => Promise<{ ok: boolean; sessionId: string | null }>;
  chatRetryEffort: (opts?: { thinkingBudgetTokens?: number; enableThinking?: boolean }) => Promise<{ ok: boolean; error?: string }>;
  chatExport: (format: "markdown" | "json") => Promise<{ ok: boolean; filePath?: string; canceled?: boolean; error?: string }>;
  starredList: () => Promise<Array<{ id: string; sessionId: string; messageIndex: number; role: string; text: string; starredAt: string }>>;
  starredAdd: (entry: { sessionId?: string; messageIndex: number; role: string; text: string }) => Promise<{ ok: boolean; entry?: { id: string; sessionId: string; messageIndex: number; role: string; text: string; starredAt: string } }>;
  starredRemove: (opts: { id?: string; sessionId?: string; messageIndex?: number }) => Promise<{ ok: boolean }>;
  memoryListNotes: () => Promise<Array<{ filename: string; title: string; content: string }>>;
  memorySaveNote: (t: string, c: string) => Promise<unknown>;
  memoryDeleteNote: (f: string) => Promise<void>;
  listMarketplacePlugins: () => Promise<MarketplaceItem[]>;
  installMarketplacePlugin: (id: string) => Promise<unknown>;
  uninstallMarketplacePlugin: (id: string) => Promise<unknown>;
  listPluginUiExtensions: () => Promise<PluginUiExtension[]>;
  callPluginMethod: (m: string, p?: unknown) => Promise<unknown>;
  listPluginCards: () => Promise<PluginCardSummary[]>;
  addTask: (t: unknown) => Promise<Task>;
  queryTasks: (f?: unknown) => Promise<Task[]>;
  updateTask: (id: string, p: unknown) => Promise<Task>;
  deleteTask: (id: string) => Promise<void>;
  getTodayTasks: () => Promise<Task[]>;
  getOverdueTasks: () => Promise<Task[]>;
  getBriefing: () => Promise<string | null>;
  onProactiveBriefing: (h: (b: BriefingPayload) => void) => () => void;
  dismissBriefing: (feedback?: { reason: string; details?: string }) => Promise<{ ok: boolean; debounced?: boolean }>;
  snoozeBriefing: () => Promise<{ ok: boolean; lastDismissedAt?: string }>;
  onMarketplaceUpdatesAvailable: (h: (updates: Array<{ pluginId: string; installedVersion: string; latestVersion: string }>) => void) => () => void;
  onViewActivate: (h: (k: string) => void) => () => void;
  getUsageSummary: (days?: number) => Promise<UsageSummaryShape>;
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
};
export type ApprovalDecision = {
  requestId: string;
  choice: ApprovalChoice;
  rememberPattern?: string;
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
    lvis: {
      permission: LvisPermissionApi;
      approval: LvisApprovalApi;
      policy: LvisPolicyApi;
    };
  }
}
