const { contextBridge, ipcRenderer } = require("electron");

const api = {
  scanIndex: async () => ipcRenderer.invoke("lvis:index:scan"),
  listDocuments: async () => ipcRenderer.invoke("lvis:index:documents"),
  chatPreview: async (question) => ipcRenderer.invoke("lvis:chat:preview", question),
  startMeeting: async (sessionId, context) => ipcRenderer.invoke("lvis:meeting:start", sessionId, context),
  pushMeetingChunk: async (sessionId, chunk) => ipcRenderer.invoke("lvis:meeting:push-chunk", sessionId, chunk),
  stopMeeting: async (sessionId) => ipcRenderer.invoke("lvis:meeting:stop", sessionId),
  getMeetingTranscript: async (sessionId) => ipcRenderer.invoke("lvis:meeting:transcript", sessionId),
  listMarketplacePlugins: async () => ipcRenderer.invoke("lvis:plugins:marketplace:list"),
  installMarketplacePlugin: async (pluginId) => ipcRenderer.invoke("lvis:plugins:install", pluginId),
  uninstallMarketplacePlugin: async (pluginId) => ipcRenderer.invoke("lvis:plugins:uninstall", pluginId),
  listPluginUiExtensions: async () => ipcRenderer.invoke("lvis:plugins:ui:list"),
  callPluginMethod: async (method, payload) => ipcRenderer.invoke("lvis:plugins:call", method, payload),
  addTask: async (task) => ipcRenderer.invoke("lvis:tasks:add", task),
  queryTasks: async (filter) => ipcRenderer.invoke("lvis:tasks:query", filter),
  updateTask: async (id, patch) => ipcRenderer.invoke("lvis:tasks:update", id, patch),
  deleteTask: async (id) => ipcRenderer.invoke("lvis:tasks:delete", id),
  getTodayTasks: async () => ipcRenderer.invoke("lvis:tasks:today"),
  getOverdueTasks: async () => ipcRenderer.invoke("lvis:tasks:overdue"),
  onViewActivate: (handler) => {
    const listener = (_event, payload) => handler(payload?.viewKey ?? "home");
    ipcRenderer.on("lvis:view:activate", listener);
    return () => ipcRenderer.removeListener("lvis:view:activate", listener);
  },
};

contextBridge.exposeInMainWorld("lvisApi", api);
