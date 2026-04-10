import { contextBridge, ipcRenderer } from "electron";

const api = {
  scanIndex: async () => ipcRenderer.invoke("lvis:index:scan") as Promise<{ scanned: number; indexed: number }>,
  listDocuments: async () =>
    ipcRenderer.invoke("lvis:index:documents") as Promise<
      Array<{ id: string; doc_name: string; type: string; path: string; line_count?: number; page_count?: number }>
    >,
  chatPreview: async (question: string) =>
    ipcRenderer.invoke("lvis:chat:preview", question) as Promise<{
      question: string;
      documentCount: number;
      documentName?: string;
      preview: string;
    }>,
  startMeeting: async (
    sessionId: string,
    context?: { locale?: string; contextHint?: string; participants?: string[] },
  ) => ipcRenderer.invoke("lvis:meeting:start", sessionId, context) as Promise<{ sessionId: string; started: true }>,
  pushMeetingChunk: async (
    sessionId: string,
    chunk: { pcm16leMono: number[]; sampleRate: number; startSec: number; endSec: number },
  ) =>
    ipcRenderer.invoke("lvis:meeting:push-chunk", sessionId, chunk) as Promise<{ sessionId: string; added: number }>,
  stopMeeting: async (sessionId: string) =>
    ipcRenderer.invoke("lvis:meeting:stop", sessionId) as Promise<{
      title: string;
      summary: string;
      highlights: string[];
      actionItems: string[];
      createdAt: string;
    }>,
  getMeetingTranscript: async (sessionId: string) =>
    ipcRenderer.invoke("lvis:meeting:transcript", sessionId) as Promise<
      Array<{
        id: string;
        speaker: string;
        original: string;
        startSec: number;
        endSec: number;
        isFinal: boolean;
      }>
    >,
  listMarketplacePlugins: async () =>
    ipcRenderer.invoke("lvis:plugins:marketplace:list") as Promise<
      Array<{
        id: string;
        name: string;
        description: string;
        packageSpec: string;
        installed: boolean;
        enabled: boolean;
      }>
    >,
  installMarketplacePlugin: async (pluginId: string) =>
    ipcRenderer.invoke("lvis:plugins:install", pluginId) as Promise<{ pluginId: string; installed: true }>,
  uninstallMarketplacePlugin: async (pluginId: string) =>
    ipcRenderer.invoke("lvis:plugins:uninstall", pluginId) as Promise<{ pluginId: string; uninstalled: true }>,
  listPluginUiExtensions: async () =>
    ipcRenderer.invoke("lvis:plugins:ui:list") as Promise<
      Array<{
        pluginId: string;
        extension: {
          id: string;
          slot: "sidebar";
          kind: "embedded-module" | "embedded-page" | "info-card";
          displayName?: string;
          title: string;
          description?: string;
          defaults?: Record<string, unknown>;
          entry?: string;
          exportName?: string;
          page?: string;
        };
        entryUrl?: string;
      }>
    >,
  callPluginMethod: async (method: string, payload?: unknown) =>
    ipcRenderer.invoke("lvis:plugins:call", method, payload) as Promise<unknown>,
  addTask: async (task: unknown) => ipcRenderer.invoke("lvis:tasks:add", task),
  queryTasks: async (filter?: unknown) => ipcRenderer.invoke("lvis:tasks:query", filter),
  updateTask: async (id: string, patch: unknown) => ipcRenderer.invoke("lvis:tasks:update", id, patch),
  deleteTask: async (id: string) => ipcRenderer.invoke("lvis:tasks:delete", id),
  getTodayTasks: async () => ipcRenderer.invoke("lvis:tasks:today"),
  getOverdueTasks: async () => ipcRenderer.invoke("lvis:tasks:overdue"),
  onViewActivate: (handler: (viewKey: string) => void) => {
    const listener = (_event: unknown, payload: { viewKey?: string }) => {
      handler(payload?.viewKey ?? "home");
    };
    ipcRenderer.on("lvis:view:activate", listener);
    return () => ipcRenderer.removeListener("lvis:view:activate", listener);
  },
};

contextBridge.exposeInMainWorld("lvisApi", api);
