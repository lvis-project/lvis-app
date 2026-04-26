import electron from "electron";
import type { McpServerConfig } from "./mcp/types.js";
import type { ScheduleAgentId, ScheduleRoutineSchedule } from "./routines/schedule.js";

const { contextBridge, ipcRenderer } = electron;

type PluginActionResult =
  | { ok: true; pluginId: string; installed?: true; uninstalled?: true; version?: string }
  | { ok: false; error: string; message?: string };

function invalidPluginActionResult(): PluginActionResult {
  return {
    ok: false,
    error: "invalid-result",
    message: "플러그인 작업 결과가 올바르지 않습니다.",
  };
}

function normalizePluginActionResult(result: unknown): PluginActionResult {
  if (result && typeof result === "object" && "ok" in result && result.ok === false) {
    return result as PluginActionResult;
  }

  const payload = result && typeof result === "object"
    ? result as { pluginId?: unknown; installed?: unknown; uninstalled?: unknown; version?: unknown }
    : {};
  const pluginId = typeof payload.pluginId === "string" ? payload.pluginId.trim() : "";
  const installed = payload.installed === true;
  const uninstalled = payload.uninstalled === true;
  if (!pluginId || (!installed && !uninstalled)) {
    return invalidPluginActionResult();
  }
  const normalized: PluginActionResult = {
    ok: true,
    pluginId,
  };
  if (installed) {
    normalized.installed = true;
  }
  if (uninstalled) {
    normalized.uninstalled = true;
  }
  if (typeof payload.version === "string") {
    normalized.version = payload.version;
  }
  return normalized;
}

const api = {
  // ─── Settings ────────────────────────────────────
  getSettings: async () => ipcRenderer.invoke("lvis:settings:get"),
  updateSettings: async (partial: unknown) => ipcRenderer.invoke("lvis:settings:update", partial),
  setApiKey: async (vendor: string, apiKey: string) => ipcRenderer.invoke("lvis:settings:set-api-key", vendor, apiKey),
  hasApiKey: async (vendor?: string) => ipcRenderer.invoke("lvis:settings:has-api-key", vendor) as Promise<boolean>,
  deleteApiKey: async (vendor: string) => ipcRenderer.invoke("lvis:settings:delete-api-key", vendor),
  setWebApiKey: async (provider: string, apiKey: string) => ipcRenderer.invoke("lvis:settings:set-web-api-key", provider, apiKey),
  hasWebApiKey: async (provider: string) => ipcRenderer.invoke("lvis:settings:has-web-api-key", provider) as Promise<boolean>,
  deleteWebApiKey: async (provider: string) => ipcRenderer.invoke("lvis:settings:delete-web-api-key", provider),

  // ─── Microsoft Graph — dual-environment login ────
  msGraphGetState: async () =>
    ipcRenderer.invoke("lvis:ms-graph:get-state") as Promise<{
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
    }>,
  msGraphSwitchEnvironment: async (env: "external" | "corporate") =>
    ipcRenderer.invoke("lvis:ms-graph:switch-environment", env) as Promise<{
      ok: boolean;
      state?: unknown;
    }>,
  msGraphSignIn: async () =>
    ipcRenderer.invoke("lvis:ms-graph:sign-in") as Promise<{
      ok: boolean;
      error?: string;
      state?: unknown;
    }>,
  msGraphSignOut: async () =>
    ipcRenderer.invoke("lvis:ms-graph:sign-out") as Promise<{
      ok: boolean;
      state?: unknown;
    }>,

  // ─── Chat (ConversationLoop) ─────────────────────
  chatHasProvider: async () => ipcRenderer.invoke("lvis:chat:has-provider") as Promise<boolean>,
  chatSend: async (input: string) => ipcRenderer.invoke("lvis:chat:send", input),
  chatGuide: async (input: string) => ipcRenderer.invoke("lvis:chat:guide", input),
  chatNew: async () => ipcRenderer.invoke("lvis:chat:new"),
  chatSessions: async () =>
    ipcRenderer.invoke("lvis:chat:sessions") as Promise<{
      current: string;
      sessions: Array<{ id: string; modifiedAt: string }>;
    }>,
  chatLoadSession: async (sessionId: string) =>
    ipcRenderer.invoke("lvis:chat:load-session", sessionId) as Promise<{
      ok: boolean;
      sessionId: string | null;
    }>,
  // Sprint 4.C — conversation UX
  chatGetHistory: async () => ipcRenderer.invoke("lvis:chat:get-history"),
  chatEditResend: async (messageIndex: number, newText: string) =>
    ipcRenderer.invoke("lvis:chat:edit-resend", messageIndex, newText),
  chatFork: async (messageIndex: number) => ipcRenderer.invoke("lvis:chat:fork", messageIndex),
  chatRetryEffort: async (opts?: { thinkingBudgetTokens?: number; enableThinking?: boolean }) =>
    ipcRenderer.invoke("lvis:chat:retry-effort", opts),
  chatExport: async (format: "markdown" | "json") => ipcRenderer.invoke("lvis:chat:export", format),
  chatCompact: async () => ipcRenderer.invoke("lvis:chat:compact"),
  chatSessionResume: async (sessionId: string) => ipcRenderer.invoke("lvis:chat:session-resume", sessionId),
  chatAbort: async () => ipcRenderer.invoke("lvis:chat:abort") as Promise<{ ok: boolean }>,
  starredList: async () => ipcRenderer.invoke("lvis:starred:list"),
  starredAdd: async (entry: { sessionId?: string; messageIndex: number; role: string; text: string }) =>
    ipcRenderer.invoke("lvis:starred:add", entry),
  starredRemove: async (opts: { id?: string; sessionId?: string; messageIndex?: number }) =>
    ipcRenderer.invoke("lvis:starred:remove", opts),
  onChatStream: (handler: (event: { type: string; text?: string; thought?: string; name?: string; error?: string; result?: string; isError?: boolean; input?: Record<string, unknown>; groupId?: string; toolUseId?: string; displayOrder?: number; roundIndex?: number; stopReason?: "end_turn" | "tool_use"; hasToolCalls?: boolean }) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on("lvis:chat:stream", listener);
    return () => ipcRenderer.removeListener("lvis:chat:stream", listener);
  },
  onChatFallback: (handler: (payload: { from: string; to: string }) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on("lvis:chat:fallback", listener);
    return () => ipcRenderer.removeListener("lvis:chat:fallback", listener);
  },

  // ─── Memory ──────────────────────────────────────
  memoryListEntries: async () => ipcRenderer.invoke("lvis:memory:entries:list"),
  memorySaveEntry: async (title: string, content: string) => ipcRenderer.invoke("lvis:memory:entries:save", title, content),
  memoryDeleteEntry: async (filename: string) => ipcRenderer.invoke("lvis:memory:entries:delete", filename),
  memorySearchEntries: async (query: string) => ipcRenderer.invoke("lvis:memory:entries:search", query),
  memoryListSessions: async () => ipcRenderer.invoke("lvis:memory:sessions:list"),
  memorySearchSessions: async (query: string) => ipcRenderer.invoke("lvis:memory:sessions:search", query),
  memoryGetLvisMd: async () => ipcRenderer.invoke("lvis:memory:lvis-md:get") as Promise<string>,
  memoryUpdateLvisMd: async (content: string) => ipcRenderer.invoke("lvis:memory:lvis-md:update", content),
  memoryGetUserPrefs: async () => ipcRenderer.invoke("lvis:memory:user-prefs:get") as Promise<string>,
  memoryUpdateUserPrefs: async (content: string) => ipcRenderer.invoke("lvis:memory:user-prefs:update", content),

  // ─── Plugins ─────────────────────────────────────
  listMarketplacePlugins: async () => ipcRenderer.invoke("lvis:plugins:marketplace:list"),
  listPluginUiExtensions: async () => ipcRenderer.invoke("lvis:plugins:ui:list"),
  readPluginUiModule: async (pluginId: string, viewId: string) =>
    ipcRenderer.invoke("lvis:plugins:ui:read-module", { pluginId, viewId }) as Promise<string>,
  listPluginCards: async () => ipcRenderer.invoke("lvis:plugins:cards"),
  callPluginMethod: async (method: string, payload?: unknown) => ipcRenderer.invoke("lvis:plugins:call", method, payload),

  // ─── Plugin Performance (Observability) ──────────
  plugins: {
    getPerfStats: async () => ipcRenderer.invoke("lvis:plugins:perf-stats"),
  },

  // ─── Tasks ───────────────────────────────────────
  addTask: async (task: unknown) => ipcRenderer.invoke("lvis:tasks:add", task),
  queryTasks: async (filter?: unknown) => ipcRenderer.invoke("lvis:tasks:query", filter),
  updateTask: async (id: string, patch: unknown) => ipcRenderer.invoke("lvis:tasks:update", id, patch),
  deleteTask: async (id: string) => ipcRenderer.invoke("lvis:tasks:delete", id),
  getTodayTasks: async () => ipcRenderer.invoke("lvis:tasks:today"),
  getOverdueTasks: async () => ipcRenderer.invoke("lvis:tasks:overdue"),

  listRoutines: async () => ipcRenderer.invoke("lvis:routines:list"),
  updateRoutine: async (
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
  ) => ipcRenderer.invoke("lvis:routines:update", routineId, patch),
  startRoutineSession: async (routineId: string) =>
    ipcRenderer.invoke("lvis:routines:start-session", routineId) as Promise<{ ok: boolean; sessionId?: string; error?: string }>,
  getLatestRoutineResult: async () =>
    ipcRenderer.invoke("lvis:routine:get-latest-result") as Promise<{
      routineId: string;
      trigger: string;
      summary: string;
      generatedAt: string;
    } | null>,
  triggerWakeupRoutineDev: async () =>
    ipcRenderer.invoke("lvis:routines:dev-trigger-wakeup") as Promise<{ ok: boolean; summary?: string; error?: string }>,
  triggerScheduleRoutineDev: async () =>
    ipcRenderer.invoke("lvis:routines:dev-trigger-schedule") as Promise<{ ok: boolean; summary?: string; error?: string }>,
  triggerShutdownRoutineDev: async () =>
    ipcRenderer.invoke("lvis:routines:dev-trigger-shutdown") as Promise<{ ok: boolean; summary?: string; error?: string }>,

  // ─── Routine started event ────────────────────────────────────────────────
  onRoutineStarted: (handler: (payload: { routineId: string; trigger: string; startedAt: string }) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on("lvis:routine:started", listener);
    return () => ipcRenderer.removeListener("lvis:routine:started", listener);
  },

  // ─── Usage Observability (Sprint 4.B) ────────────
  getUsageSummary: async (days?: number) => ipcRenderer.invoke("lvis:usage:summary", days),
  getUsageRange: async (opts: { dateFrom: string; dateTo: string }) => ipcRenderer.invoke("lvis:usage:range", opts),
  exportUsageCsv: async (rows: Array<Record<string, string | number>>) => ipcRenderer.invoke("lvis:usage:export-csv", rows),

  // ─── Routine completed event (신규: RoutineResult 전달) ──────────────────
  onRoutineCompleted: (handler: (result: { routineId: string; trigger: string; summary: string; generatedAt: string }) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on("lvis:routine:completed", listener);
    return () => ipcRenderer.removeListener("lvis:routine:completed", listener);
  },

  // ─── Brain — proactive trigger lifecycle ────────────────────────────────
  onTriggerStarted: (
    handler: (payload: {
      sessionId: string;
      pluginId: string;
      source: string;
      visibility: "silent" | "summary-only" | "user-visible";
      priority: "low" | "normal" | "high";
      startedAt: string;
    }) => void,
  ) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on("lvis:trigger:started", listener);
    return () => ipcRenderer.removeListener("lvis:trigger:started", listener);
  },
  onTriggerCompleted: (
    handler: (result: {
      sessionId: string;
      pluginId: string;
      source: string;
      visibility: "silent" | "summary-only" | "user-visible";
      priority: "low" | "normal" | "high";
      prompt: string;
      summary: string;
      completedAt: string;
    }) => void,
  ) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on("lvis:trigger:completed", listener);
    return () => ipcRenderer.removeListener("lvis:trigger:completed", listener);
  },
  onTriggerFailed: (
    handler: (payload: {
      sessionId: string;
      pluginId: string;
      source: string;
      reason: "provider_error" | "tool_error" | "abort" | "unknown";
      errorId: string;
    }) => void,
  ) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on("lvis:trigger:failed", listener);
    return () => ipcRenderer.removeListener("lvis:trigger:failed", listener);
  },
  onTriggerExpired: (
    handler: (payload: { sessionId: string; pluginId: string; source: string }) => void,
  ) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on("lvis:trigger:expired", listener);
    return () => ipcRenderer.removeListener("lvis:trigger:expired", listener);
  },
  onTriggerImported: (
    handler: (payload: {
      sessionId: string;
      source: string;
      prompt: string;
      summary: string;
      toolCallCount: number;
      importedAt: string;
      wrappedPrompt: string;
    }) => void,
  ) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on("lvis:trigger:imported", listener);
    return () => ipcRenderer.removeListener("lvis:trigger:imported", listener);
  },
  dismissTrigger: async (sessionId: string) =>
    ipcRenderer.invoke("lvis:trigger:dismiss", sessionId) as Promise<{
      ok: boolean;
      removed?: boolean;
      error?: string;
    }>,
  importTrigger: async (sessionId: string) =>
    ipcRenderer.invoke("lvis:trigger:import", sessionId) as Promise<{
      ok: boolean;
      imported?: number;
      reason?: string;
      error?: string;
    }>,

  // ─── Marketplace update notifications (S8) ───────
  onMarketplaceUpdatesAvailable: (handler: (updates: Array<{ pluginId: string; installedVersion: string; latestVersion: string }>) => void) => {
    const listener = (_event: unknown, updates: Parameters<typeof handler>[0]) => handler(updates);
    ipcRenderer.on("marketplace:updates-available", listener);
    return () => ipcRenderer.removeListener("marketplace:updates-available", listener);
  },

  // ─── lvis:// deep-link install lifecycle ─────────
  // Fires when a marketplace install triggered via lvis://install/{slug} has
  // finished installing + restartAll() in the main process. Renderer uses
  // this to refresh its plugin UI list so newly-installed sidebar views
  // appear without requiring an app restart.
  onPluginInstallResult: (handler: (payload: { slug: string; success: boolean; error?: string }) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on("lvis:plugins:install-result", listener);
    return () => ipcRenderer.removeListener("lvis:plugins:install-result", listener);
  },

  // Sibling of onPluginInstallResult — fires after PluginConfigTab or any
  // other surface drives uninstall through the IPC handler. Renderer uses
  // this to drop the removed plugin's sidebar tab + marketplace card.
  onPluginUninstallResult: (handler: (payload: { slug: string; success: boolean; error?: string }) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on("lvis:plugins:uninstall-result", listener);
    return () => ipcRenderer.removeListener("lvis:plugins:uninstall-result", listener);
  },

  // Phase progress for in-flight installs — `installing` (download + verify
  // + extract + registry write) followed by `restarting` (runtime reload).
  // The result event clears the in-flight state. Renderer renders a
  // skeleton card / sidebar placeholder driven by these phases.
  onPluginInstallProgress: (handler: (payload: { slug: string; phase: "installing" | "restarting" }) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on("lvis:plugins:install-progress", listener);
    return () => ipcRenderer.removeListener("lvis:plugins:install-progress", listener);
  },

  // Status bar — aggregated runtime counters (tools / plugins / mcps).
  getRuntimeCounts: async () =>
    ipcRenderer.invoke("lvis:runtime:counts") as Promise<{
      tools: number;
      plugins: number;
      mcps: number;
    }>,
  // Status bar — static environment info (platform / hostname / user).
  // Static enough to fetch once on mount; values don't change while the
  // process is alive. Cwd is intentionally NOT exposed — least-privilege
  // for plugin UI panels that share this contextBridge.
  getRuntimeEnv: async () =>
    ipcRenderer.invoke("lvis:runtime:env") as Promise<{
      platform: string;
      hostname: string;
      user: string;
    }>,
  // Status bar — marketplace reachability probe. Returns `configured: false`
  // when the user is on the mock backend (nothing to ping).
  pingMarketplace: async () =>
    ipcRenderer.invoke("lvis:marketplace:ping") as Promise<{
      configured: boolean;
      online: boolean;
    }>,

  // ─── Plugin Events (§35 real-time streaming) ─────
  onPluginEvent: (
    eventType: string,
    handler: (data: unknown) => void,
  ): (() => void) => {
    const listener = (_event: unknown, type: string, data: unknown) => {
      if (type === eventType) handler(data);
    };
    ipcRenderer.on("lvis:plugin:event", listener);
    return () => ipcRenderer.removeListener("lvis:plugin:event", listener);
  },

  // ─── MCP ─────────────────────────────────────────
  mcp: {
    servers: async () => ipcRenderer.invoke("lvis:mcp:servers"),
    kill: async (id: string) => ipcRenderer.invoke("lvis:mcp:kill", id),
    getConfigs: async () => ipcRenderer.invoke("lvis:mcp:config:get"),
    getConfigPath: async () => ipcRenderer.invoke("lvis:mcp:config:path"),
    addConfig: async (config: McpServerConfig) => ipcRenderer.invoke("lvis:mcp:config:add", config),
    removeConfig: async (id: string) => ipcRenderer.invoke("lvis:mcp:config:remove", id),
    readUiResource: async (serverId: string, uri: string) => ipcRenderer.invoke("lvis:mcp:ui-resource", serverId, uri) as Promise<string>,
  },

  // ─── Permission ───────────────────────────────────
  permission: {
    getMode: async () => ipcRenderer.invoke("lvis:permission:get-mode"),
    setMode: async (mode: string) => ipcRenderer.invoke("lvis:permission:set-mode", mode),
    listRules: async () => ipcRenderer.invoke("lvis:permission:list-rules"),
    addRule: async (pattern: string, action: string) =>
      ipcRenderer.invoke("lvis:permission:add-rule", pattern, action),
    removeRule: async (pattern: string, action: string) =>
      ipcRenderer.invoke("lvis:permission:remove-rule", pattern, action),
  },

  // ─── Policy (Governance) ─────────────────────────
  policy: {
    get: async () => ipcRenderer.invoke("lvis:policy:get"),
    set: async (patch: unknown) => ipcRenderer.invoke("lvis:policy:set", patch),
  },

  // ─── Approval Gate (§6.3 Layer 3 + §8) ─────────
  approval: {
    /** main→renderer 단방향 이벤트 구독 */
    onRequest: (cb: (req: unknown) => void) => {
      const listener = (_event: unknown, req: unknown) => cb(req);
      ipcRenderer.on("lvis:approval:request", listener);
      return () => ipcRenderer.removeListener("lvis:approval:request", listener);
    },
    /** 사용자 결정을 main으로 전송 */
    respond: async (decision: unknown) =>
      ipcRenderer.invoke("lvis:approval:respond", decision),
  },

  // ─── DLP Hit Statistics (Observability) ─────────
  dlp: {
    getStats: async (days: number) => ipcRenderer.invoke("lvis:dlp:stats", days),
  },

  // ─── Audit Log Search (Observability) ────────────
  audit: {
    search: async (filter: {
      dateFrom?: string;
      dateTo?: string;
      type?: string;
      textSearch?: string;
      limit?: number;
      offset?: number;
    }) => ipcRenderer.invoke("lvis:audit:search", filter),
    getStats: async (lastDays: number) => ipcRenderer.invoke("lvis:audit:stats", lastDays),
  },

  // ─── D6 — Message feedback ───────────────────────
  submitFeedback: async (payload: { sessionId: string; messageIndex: number; rating: "up" | "down"; reason?: string }) =>
    ipcRenderer.invoke("lvis:feedback:submit", payload) as Promise<{ ok: boolean; error?: string }>,

  // ─── D7 — PageIndex drag & drop ──────────────────
  pageindexScanPaths: async (paths: string[]) =>
    ipcRenderer.invoke("lvis:pageindex:scan-paths", { paths }) as Promise<{ ok: boolean; indexed?: number; failed?: number; jobId?: string; error?: string }>,

  // ─── View Events ─────────────────────────────────
  onViewActivate: (handler: (viewKey: string) => void) => {
    const listener = (_event: unknown, payload: { viewKey?: string }) => handler(payload?.viewKey ?? "home");
    ipcRenderer.on("lvis:view:activate", listener);
    return () => ipcRenderer.removeListener("lvis:view:activate", listener);
  },
};

contextBridge.exposeInMainWorld("lvisApi", api);

let hostMarketplaceApiClaimed = false;
contextBridge.exposeInMainWorld("lvisHost", {
  takePluginMarketplaceApi: () => {
    if (hostMarketplaceApiClaimed) return null;
    hostMarketplaceApiClaimed = true;
    return {
      installMarketplacePlugin: async (pluginId: string) =>
        normalizePluginActionResult(await ipcRenderer.invoke("lvis:plugins:install", pluginId)),
      uninstallMarketplacePlugin: async (pluginId: string) =>
        normalizePluginActionResult(await ipcRenderer.invoke("lvis:plugins:uninstall", pluginId)),
    };
  },
});

// ─── lvis 네임스페이스 (B1: Approval Gate + Permission) ──
// renderer에서 window.lvis.approval / window.lvis.permission으로 접근
contextBridge.exposeInMainWorld("lvis", {
  permission: api.permission,
  approval: api.approval,
  policy: api.policy,
  mcp: api.mcp,
  plugins: {
    cards: () => ipcRenderer.invoke("lvis:plugins:cards"),
  },
  pluginConfig: {
    get: (pluginId: string) => ipcRenderer.invoke("lvis:plugins:config:get", pluginId),
    set: (pluginId: string, config: Record<string, unknown>) => ipcRenderer.invoke("lvis:plugins:config:set", pluginId, config),
  },
  env: {
    isDev: process.env.LVIS_DEV === "1",
    enableDevConsole: process.env.LVIS_ENABLE_DEV_CONSOLE === "1",
  },
});
