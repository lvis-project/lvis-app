/**
 * IPC Bridge — §4.1 Main ↔ Renderer ↔ Native
 *
 * 모든 IPC 핸들러를 등록하는 모듈.
 * main.ts에서 인라인으로 30개 핸들러를 두지 않고 여기에 집중.
 */
import { ipcMain, type BrowserWindow } from "electron";
import type { AppServices } from "./boot.js";

export function registerIpcHandlers(
  services: AppServices,
  getMainWindow: () => BrowserWindow | null,
): void {
  const {
    pluginRuntime,
    pluginMarketplace,
    taskService,
    settingsService,
    memoryManager,
    conversationLoop,
  } = services;

  // ─── Settings (벤더별 API 키) ────────────────────
  ipcMain.handle("lvis:settings:get", () => settingsService.getAll());
  ipcMain.handle("lvis:settings:update", (_e, partial) => {
    const result = settingsService.patch(partial);
    conversationLoop.refreshProvider();
    return result;
  });
  ipcMain.handle("lvis:settings:set-api-key", (_e, vendor: string, apiKey: string) => {
    settingsService.setSecret(`llm.apiKey.${vendor}`, apiKey);
    conversationLoop.refreshProvider();
    return { ok: true };
  });
  ipcMain.handle("lvis:settings:has-api-key", (_e, vendor?: string) => {
    const v = vendor ?? settingsService.get("llm").provider;
    return settingsService.getSecret(`llm.apiKey.${v}`) !== null;
  });
  ipcMain.handle("lvis:settings:delete-api-key", (_e, vendor: string) => {
    settingsService.deleteSecret(`llm.apiKey.${vendor}`);
    conversationLoop.refreshProvider();
    return { ok: true };
  });

  // ─── Web Search Keys ───────────────────────────
  ipcMain.handle("lvis:settings:set-web-api-key", (_e, provider: string, apiKey: string) => {
    settingsService.setSecret(`web.apiKey.${provider}`, apiKey);
    return { ok: true };
  });
  ipcMain.handle("lvis:settings:has-web-api-key", (_e, provider: string) => {
    return settingsService.getSecret(`web.apiKey.${provider}`) !== null;
  });
  ipcMain.handle("lvis:settings:delete-web-api-key", (_e, provider: string) => {
    settingsService.deleteSecret(`web.apiKey.${provider}`);
    return { ok: true };
  });

  // ─── Chat (ConversationLoop) ────────────────────
  ipcMain.handle("lvis:chat:has-provider", () => conversationLoop.hasProvider());

  ipcMain.handle("lvis:chat:send", async (_e, input: string) => {
    const win = getMainWindow();
    const result = await conversationLoop.runTurn(input, {
      onTextDelta: (text) => {
        win?.webContents.send("lvis:chat:stream", { type: "text_delta", text });
      },
      onToolStart: (name, toolInput) => {
        win?.webContents.send("lvis:chat:stream", { type: "tool_start", name, input: toolInput });
      },
      onToolEnd: (name, toolResult, isError) => {
        win?.webContents.send("lvis:chat:stream", { type: "tool_end", name, result: toolResult, isError });
      },
      onError: (error) => {
        win?.webContents.send("lvis:chat:stream", { type: "error", error });
      },
    });
    win?.webContents.send("lvis:chat:stream", { type: "done" });
    return result;
  });

  ipcMain.handle("lvis:chat:new", () => {
    conversationLoop.newConversation();
    return { ok: true };
  });

  ipcMain.handle("lvis:chat:sessions", () => ({
    current: conversationLoop.getSessionId(),
    sessions: conversationLoop.listSessions().slice(0, 20).map((s) => ({
      id: s.id,
      modifiedAt: s.modifiedAt.toISOString(),
    })),
  }));

  ipcMain.handle("lvis:chat:load-session", (_e, sessionId: string) => {
    const loaded = conversationLoop.loadSession(sessionId);
    return { ok: loaded, sessionId: loaded ? sessionId : null };
  });

  // ─── Memory ─────────────────────────────────────
  ipcMain.handle("lvis:memory:notes:list", () => memoryManager.listNotes());
  ipcMain.handle("lvis:memory:notes:save", (_e, title: string, content: string) =>
    memoryManager.saveNote(title, content),
  );
  ipcMain.handle("lvis:memory:notes:delete", (_e, filename: string) =>
    memoryManager.deleteNote(filename),
  );
  ipcMain.handle("lvis:memory:notes:search", (_e, query: string) =>
    memoryManager.searchNotes(query),
  );
  ipcMain.handle("lvis:memory:lvis-md:get", () => memoryManager.getLvisMd());
  ipcMain.handle("lvis:memory:lvis-md:update", (_e, content: string) =>
    memoryManager.updateLvisMd(content),
  );
  ipcMain.handle("lvis:memory:user-prefs:get", () => memoryManager.getUserPreferences());
  ipcMain.handle("lvis:memory:user-prefs:update", (_e, content: string) =>
    memoryManager.updateUserPreferences(content),
  );

  // ─── Plugin Methods (proxy) ─────────────────────
  ipcMain.handle("lvis:index:scan", () => pluginRuntime.call("index.scan"));
  ipcMain.handle("lvis:index:documents", () => pluginRuntime.call("index.documents"));
  ipcMain.handle("lvis:chat:preview", (_e, question: string) =>
    pluginRuntime.call("chat.preview", { question }),
  );
  ipcMain.handle("lvis:meeting:start", (_e, sessionId: string, context?: unknown) =>
    pluginRuntime.call("meeting.start", { sessionId, context }),
  );
  ipcMain.handle("lvis:meeting:push-chunk", (_e, sessionId: string, chunk: unknown) =>
    pluginRuntime.call("meeting.pushChunk", { sessionId, chunk }),
  );
  ipcMain.handle("lvis:meeting:stop", (_e, sessionId: string) =>
    pluginRuntime.call("meeting.stop", { sessionId }),
  );
  ipcMain.handle("lvis:meeting:transcript", (_e, sessionId: string) =>
    pluginRuntime.call("meeting.transcript", { sessionId }),
  );

  // ─── Marketplace ────────────────────────────────
  ipcMain.handle("lvis:plugins:marketplace:list", () => pluginMarketplace.list());
  ipcMain.handle("lvis:plugins:install", async (_e, pluginId: string) => {
    const result = await pluginMarketplace.install(pluginId);
    await pluginRuntime.restartAll();
    return result;
  });
  ipcMain.handle("lvis:plugins:uninstall", async (_e, pluginId: string) => {
    const result = await pluginMarketplace.uninstall(pluginId);
    await pluginRuntime.restartAll();
    return result;
  });
  ipcMain.handle("lvis:plugins:ui:list", () => pluginRuntime.listUiExtensions());
  ipcMain.handle("lvis:plugins:call", (_e, method: string, payload?: unknown) =>
    pluginRuntime.call(method, payload),
  );

  // ─── Tasks ──────────────────────────────────────
  ipcMain.handle("lvis:tasks:add", (_e, task) => taskService.add(task));
  ipcMain.handle("lvis:tasks:update", (_e, id: string, patch) => taskService.update(id, patch));
  ipcMain.handle("lvis:tasks:get", (_e, id: string) => taskService.get(id));
  ipcMain.handle("lvis:tasks:delete", (_e, id: string) => taskService.delete(id));
  ipcMain.handle("lvis:tasks:query", (_e, filter) => taskService.query(filter));
  ipcMain.handle("lvis:tasks:pending", () => taskService.getPendingByPriority());
  ipcMain.handle("lvis:tasks:overdue", () => taskService.getOverdue());
  ipcMain.handle("lvis:tasks:today", () => taskService.getDueToday());
}
