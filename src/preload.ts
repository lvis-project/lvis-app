import electron from "electron";

const { contextBridge, ipcRenderer } = electron;

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

  // ─── Chat (ConversationLoop) ─────────────────────
  chatHasProvider: async () => ipcRenderer.invoke("lvis:chat:has-provider") as Promise<boolean>,
  chatSend: async (input: string) => ipcRenderer.invoke("lvis:chat:send", input),
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
  memoryListNotes: async () => ipcRenderer.invoke("lvis:memory:notes:list"),
  memorySaveNote: async (title: string, content: string) => ipcRenderer.invoke("lvis:memory:notes:save", title, content),
  memoryDeleteNote: async (filename: string) => ipcRenderer.invoke("lvis:memory:notes:delete", filename),
  memorySearchNotes: async (query: string) => ipcRenderer.invoke("lvis:memory:notes:search", query),
  memorySearchSessions: async (query: string) => ipcRenderer.invoke("lvis:memory:sessions:search", query),
  memoryGetLvisMd: async () => ipcRenderer.invoke("lvis:memory:lvis-md:get") as Promise<string>,
  memoryUpdateLvisMd: async (content: string) => ipcRenderer.invoke("lvis:memory:lvis-md:update", content),
  memoryGetUserPrefs: async () => ipcRenderer.invoke("lvis:memory:user-prefs:get") as Promise<string>,
  memoryUpdateUserPrefs: async (content: string) => ipcRenderer.invoke("lvis:memory:user-prefs:update", content),

  // ─── Plugins ─────────────────────────────────────
  listMarketplacePlugins: async () => ipcRenderer.invoke("lvis:plugins:marketplace:list"),
  installMarketplacePlugin: async (pluginId: string) => ipcRenderer.invoke("lvis:plugins:install", pluginId),
  uninstallMarketplacePlugin: async (pluginId: string) => ipcRenderer.invoke("lvis:plugins:uninstall", pluginId),
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

  // ─── Daily Briefing ──────────────────────────────
  getBriefing: async () => ipcRenderer.invoke("lvis:briefing:get"),

  // ─── Usage Observability (Sprint 4.B) ────────────
  getUsageSummary: async (days?: number) => ipcRenderer.invoke("lvis:usage:summary", days),
  getUsageRange: async (opts: { dateFrom: string; dateTo: string }) => ipcRenderer.invoke("lvis:usage:range", opts),
  exportUsageCsv: async (rows: Array<Record<string, string | number>>) => ipcRenderer.invoke("lvis:usage:export-csv", rows),

  // ─── Proactive (Sprint 3-A: briefing card + snooze/dismiss) ───
  onProactiveBriefing: (handler: (briefing: { generatedAt: string; items: Array<{ category: string; priority: string; title: string; detail?: string }>; summary?: string }) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on("lvis:proactive:briefing", listener);
    return () => ipcRenderer.removeListener("lvis:proactive:briefing", listener);
  },
  dismissBriefing: async (feedback?: { reason: string; details?: string }) =>
    ipcRenderer.invoke("lvis:proactive:dismiss-briefing", feedback) as Promise<{ ok: boolean; debounced?: boolean }>,
  snoozeBriefing: async () => ipcRenderer.invoke("lvis:proactive:snooze-briefing") as Promise<{ ok: boolean; lastDismissedAt?: string }>,

  // ─── Marketplace update notifications (S8) ───────
  onMarketplaceUpdatesAvailable: (handler: (updates: Array<{ pluginId: string; installedVersion: string; latestVersion: string }>) => void) => {
    const listener = (_event: unknown, updates: Parameters<typeof handler>[0]) => handler(updates);
    ipcRenderer.on("marketplace:updates-available", listener);
    return () => ipcRenderer.removeListener("marketplace:updates-available", listener);
  },

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
    addConfig: async (config: unknown) => ipcRenderer.invoke("lvis:mcp:config:add", config),
    removeConfig: async (id: string) => ipcRenderer.invoke("lvis:mcp:config:remove", id),
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

// ─── lvis 네임스페이스 (B1: Approval Gate + Permission) ──
// renderer에서 window.lvis.approval / window.lvis.permission으로 접근
contextBridge.exposeInMainWorld("lvis", {
  permission: api.permission,
  approval: api.approval,
  policy: api.policy,
  mcp: api.mcp,
});
