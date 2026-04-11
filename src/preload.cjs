const { contextBridge, ipcRenderer } = require("electron");

const api = {
  // Settings
  getSettings: async () => ipcRenderer.invoke("lvis:settings:get"),
  updateSettings: async (partial) => ipcRenderer.invoke("lvis:settings:update", partial),
  setApiKey: async (vendor, apiKey) => ipcRenderer.invoke("lvis:settings:set-api-key", vendor, apiKey),
  hasApiKey: async (vendor) => ipcRenderer.invoke("lvis:settings:has-api-key", vendor),
  deleteApiKey: async (vendor) => ipcRenderer.invoke("lvis:settings:delete-api-key", vendor),
  setWebApiKey: async (provider, apiKey) => ipcRenderer.invoke("lvis:settings:set-web-api-key", provider, apiKey),
  hasWebApiKey: async (provider) => ipcRenderer.invoke("lvis:settings:has-web-api-key", provider),
  deleteWebApiKey: async (provider) => ipcRenderer.invoke("lvis:settings:delete-web-api-key", provider),

  // Chat (ConversationLoop)
  chatHasProvider: async () => ipcRenderer.invoke("lvis:chat:has-provider"),
  chatSend: async (input) => ipcRenderer.invoke("lvis:chat:send", input),
  chatNew: async () => ipcRenderer.invoke("lvis:chat:new"),
  onChatStream: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("lvis:chat:stream", listener);
    return () => ipcRenderer.removeListener("lvis:chat:stream", listener);
  },

  // Memory
  memoryListNotes: async () => ipcRenderer.invoke("lvis:memory:notes:list"),
  memorySaveNote: async (title, content) => ipcRenderer.invoke("lvis:memory:notes:save", title, content),
  memoryDeleteNote: async (filename) => ipcRenderer.invoke("lvis:memory:notes:delete", filename),
  memorySearchNotes: async (query) => ipcRenderer.invoke("lvis:memory:notes:search", query),
  memoryGetLvisMd: async () => ipcRenderer.invoke("lvis:memory:lvis-md:get"),
  memoryUpdateLvisMd: async (content) => ipcRenderer.invoke("lvis:memory:lvis-md:update", content),
  memoryGetUserPrefs: async () => ipcRenderer.invoke("lvis:memory:user-prefs:get"),
  memoryUpdateUserPrefs: async (content) => ipcRenderer.invoke("lvis:memory:user-prefs:update", content),

  // Plugins
  listMarketplacePlugins: async () => ipcRenderer.invoke("lvis:plugins:marketplace:list"),
  installMarketplacePlugin: async (pluginId) => ipcRenderer.invoke("lvis:plugins:install", pluginId),
  uninstallMarketplacePlugin: async (pluginId) => ipcRenderer.invoke("lvis:plugins:uninstall", pluginId),
  listPluginUiExtensions: async () => ipcRenderer.invoke("lvis:plugins:ui:list"),
  callPluginMethod: async (method, payload) => ipcRenderer.invoke("lvis:plugins:call", method, payload),

  // Tasks
  addTask: async (task) => ipcRenderer.invoke("lvis:tasks:add", task),
  queryTasks: async (filter) => ipcRenderer.invoke("lvis:tasks:query", filter),
  updateTask: async (id, patch) => ipcRenderer.invoke("lvis:tasks:update", id, patch),
  deleteTask: async (id) => ipcRenderer.invoke("lvis:tasks:delete", id),
  getTodayTasks: async () => ipcRenderer.invoke("lvis:tasks:today"),
  getOverdueTasks: async () => ipcRenderer.invoke("lvis:tasks:overdue"),

  // View Events
  onViewActivate: (handler) => {
    const listener = (_event, payload) => handler(payload?.viewKey ?? "home");
    ipcRenderer.on("lvis:view:activate", listener);
    return () => ipcRenderer.removeListener("lvis:view:activate", listener);
  },
};

contextBridge.exposeInMainWorld("lvisApi", api);
