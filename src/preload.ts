import { contextBridge, ipcRenderer } from "electron";

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
  onChatStream: (handler: (event: { type: string; text?: string; name?: string; error?: string; result?: string; isError?: boolean }) => void) => {
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

  // ─── MCP ─────────────────────────────────────────
  mcp: {
    servers: async () => ipcRenderer.invoke("lvis:mcp:servers"),
    kill: async (id: string) => ipcRenderer.invoke("lvis:mcp:kill", id),
  },

  // ─── Permission ───────────────────────────────────
  permission: {
    getMode: async () => ipcRenderer.invoke("lvis:permission:get-mode"),
    setMode: async (mode: string) => ipcRenderer.invoke("lvis:permission:set-mode", mode),
  },

  // ─── View Events ─────────────────────────────────
  onViewActivate: (handler: (viewKey: string) => void) => {
    const listener = (_event: unknown, payload: { viewKey?: string }) => handler(payload?.viewKey ?? "home");
    ipcRenderer.on("lvis:view:activate", listener);
    return () => ipcRenderer.removeListener("lvis:view:activate", listener);
  },
};

contextBridge.exposeInMainWorld("lvisApi", api);
