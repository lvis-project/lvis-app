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
  chatClearSessions: async () => ipcRenderer.invoke("lvis:chat:clear-sessions") as Promise<{ ok: true }>,
  chatSessions: async () => ipcRenderer.invoke("lvis:chat:sessions") as Promise<{
    current: string;
    sessions: Array<{
      id: string;
      modifiedAt: string;
      category: string;
      title: string;
      preview: string;
      messageCount: number;
    }>;
  }>,
  chatLoadSession: async (sessionId: string) => ipcRenderer.invoke("lvis:chat:load-session", sessionId) as Promise<{
    ok: boolean;
    sessionId: string | null;
    messages: Array<{
      role: "user" | "assistant" | "tool_result";
      content?: string;
      thought?: string;
      toolCalls?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
      toolUseId?: string;
      toolName?: string;
      isError?: boolean;
    }>;
  }>,
  chatLoadCategory: async (category: string) => ipcRenderer.invoke("lvis:chat:load-category", category) as Promise<{
    ok: boolean;
    category: string;
    sessionId: string | null;
    messages: Array<{
      role: "user" | "assistant" | "tool_result";
      content?: string;
      thought?: string;
      toolCalls?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
      toolUseId?: string;
      toolName?: string;
      isError?: boolean;
    }>;
  }>,
  onChatStream: (handler: (event: { type: string; text?: string; thought?: string; name?: string; error?: string; result?: string; isError?: boolean; input?: Record<string, unknown>; groupId?: string; toolUseId?: string; displayOrder?: number; roundIndex?: number; stopReason?: "end_turn" | "tool_use"; hasToolCalls?: boolean }) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on("lvis:chat:stream", listener);
    return () => ipcRenderer.removeListener("lvis:chat:stream", listener);
  },

  // ─── Memory ──────────────────────────────────────
  memoryListNotes: async () => ipcRenderer.invoke("lvis:memory:notes:list"),
  memorySaveNote: async (title: string, content: string) => ipcRenderer.invoke("lvis:memory:notes:save", title, content),
  memoryDeleteNote: async (filename: string) => ipcRenderer.invoke("lvis:memory:notes:delete", filename),
  memorySearchNotes: async (query: string) => ipcRenderer.invoke("lvis:memory:notes:search", query),
  memoryGetLvisMd: async () => ipcRenderer.invoke("lvis:memory:lvis-md:get") as Promise<string>,
  memoryUpdateLvisMd: async (content: string) => ipcRenderer.invoke("lvis:memory:lvis-md:update", content),
  memoryGetUserPrefs: async () => ipcRenderer.invoke("lvis:memory:user-prefs:get") as Promise<string>,
  memoryUpdateUserPrefs: async (content: string) => ipcRenderer.invoke("lvis:memory:user-prefs:update", content),

  // ─── Plugins ─────────────────────────────────────
  listMarketplacePlugins: async () => ipcRenderer.invoke("lvis:plugins:marketplace:list"),
  installMarketplacePlugin: async (pluginId: string) => ipcRenderer.invoke("lvis:plugins:install", pluginId),
  uninstallMarketplacePlugin: async (pluginId: string) => ipcRenderer.invoke("lvis:plugins:uninstall", pluginId),
  listPluginUiExtensions: async () => ipcRenderer.invoke("lvis:plugins:ui:list"),
  callPluginMethod: async (method: string, payload?: unknown) => ipcRenderer.invoke("lvis:plugins:call", method, payload),

  // ─── Tasks ───────────────────────────────────────
  addTask: async (task: unknown) => ipcRenderer.invoke("lvis:tasks:add", task),
  queryTasks: async (filter?: unknown) => ipcRenderer.invoke("lvis:tasks:query", filter),
  updateTask: async (id: string, patch: unknown) => ipcRenderer.invoke("lvis:tasks:update", id, patch),
  deleteTask: async (id: string) => ipcRenderer.invoke("lvis:tasks:delete", id),
  getTodayTasks: async () => ipcRenderer.invoke("lvis:tasks:today"),
  getOverdueTasks: async () => ipcRenderer.invoke("lvis:tasks:overdue"),

  // ─── Daily Briefing ──────────────────────────────
  getBriefing: async () => ipcRenderer.invoke("lvis:briefing:get"),

  // ─── MCP ─────────────────────────────────────────
  mcp: {
    servers: async () => ipcRenderer.invoke("lvis:mcp:servers"),
    kill: async (id: string) => ipcRenderer.invoke("lvis:mcp:kill", id),
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
});
