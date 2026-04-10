import { Menu, app, BrowserWindow, ipcMain, type MenuItemConstructorOptions } from "electron";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PluginRuntime } from "./plugin-runtime/runtime.js";
import { PluginMarketplaceService } from "./plugin-runtime/marketplace.js";
import { TaskService } from "./taskService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const distRoot = resolve(__dirname, "..");
const projectRoot = resolve(distRoot, "..");

if (process.platform === "linux" && process.env.WSL_DISTRO_NAME) {
  app.commandLine.appendSwitch("enable-features", "UseOzonePlatform");
  if (process.env.WAYLAND_DISPLAY) {
    app.commandLine.appendSwitch("ozone-platform-hint", "wayland");
  } else if (process.env.DISPLAY) {
    app.commandLine.appendSwitch("ozone-platform-hint", "x11");
  }
}
app.disableHardwareAcceleration();

let mainWindow: BrowserWindow | null = null;

const pluginRuntime = new PluginRuntime({
  hostRoot: projectRoot,
  registryPath: resolve(projectRoot, "plugins/registry.json"),
});
const pluginMarketplace = new PluginMarketplaceService(projectRoot);
const taskService = new TaskService({
  dbPath: resolve(app.getPath("userData"), "lvis-tasks.db"),
});

function activateView(viewKey: string) {
  mainWindow?.webContents.send("lvis:view:activate", { viewKey });
}

function createViewMenu() {
  const pluginViews = pluginRuntime
    .listUiExtensions()
    .filter((item) => item.extension.slot === "sidebar")
    .map((item) => ({
      key: `plugin:${item.pluginId}:${item.extension.id}`,
      label: item.extension.displayName?.trim() || item.extension.title || item.pluginId,
    }));
  const submenu = [
    {
      label: "홈",
      click: () => activateView("home"),
    },
    ...pluginViews.map((item) => ({
      label: item.label,
      click: () => activateView(item.key),
    })),
  ];
  return { label: "플러그인", submenu };
}

function refreshApplicationMenu() {
  const template: MenuItemConstructorOptions[] =
    process.platform === "darwin"
      ? [
          {
            label: app.name,
            submenu: [{ role: "about" }, { type: "separator" }, { role: "quit" }],
          },
          createViewMenu(),
          {
            label: "편집",
            submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }],
          },
          { label: "보기", submenu: [{ role: "reload" }, { role: "toggleDevTools" }] },
        ]
      : [createViewMenu()];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  const preloadPath = resolve(__dirname, "preload.cjs");
  const indexHtmlPath = resolve(__dirname, "index.html");
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    show: false,
    autoHideMenuBar: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath,
    },
  });
  const windowToShow = mainWindow;
  const showFallbackTimer = setTimeout(() => {
    if (!windowToShow.isDestroyed() && !windowToShow.isVisible()) {
      windowToShow.show();
      windowToShow.focus();
    }
  }, 3000);
  windowToShow.once("ready-to-show", () => {
    clearTimeout(showFallbackTimer);
    windowToShow.show();
    windowToShow.focus();
  });
  windowToShow.on("closed", () => {
    clearTimeout(showFallbackTimer);
    if (mainWindow === windowToShow) {
      mainWindow = null;
    }
  });
  windowToShow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl) => {
    console.error("[lvis-app] main window failed to load", { errorCode, errorDescription, validatedUrl });
  });
  void windowToShow.loadFile(indexHtmlPath).catch((error) => {
    console.error("[lvis-app] failed to load index.html", error);
  });
}

async function bootstrap() {
  await pluginRuntime.startAll();
  console.log("[lvis-app] loaded plugin methods:", pluginRuntime.listMethods());

  ipcMain.handle("lvis:index:scan", async () => {
    return pluginRuntime.call("index.scan");
  });
  ipcMain.handle("lvis:index:documents", async () => {
    return pluginRuntime.call("index.documents");
  });
  ipcMain.handle("lvis:chat:preview", async (_event, question: string) => {
    return pluginRuntime.call("chat.preview", { question });
  });
  ipcMain.handle("lvis:meeting:start", async (_event, sessionId: string, context?: { locale?: string; contextHint?: string; participants?: string[] }) => {
    return pluginRuntime.call("meeting.start", { sessionId, context });
  });
  ipcMain.handle(
    "lvis:meeting:push-chunk",
    async (
      _event,
      sessionId: string,
      chunk: { pcm16leMono: number[]; sampleRate: number; startSec: number; endSec: number },
    ) => {
      return pluginRuntime.call("meeting.pushChunk", { sessionId, chunk });
    },
  );
  ipcMain.handle("lvis:meeting:stop", async (_event, sessionId: string) => {
    return pluginRuntime.call("meeting.stop", { sessionId });
  });
  ipcMain.handle("lvis:meeting:transcript", async (_event, sessionId: string) => {
    return pluginRuntime.call("meeting.transcript", { sessionId });
  });
  ipcMain.handle("lvis:plugins:marketplace:list", async () => {
    return pluginMarketplace.list();
  });
  ipcMain.handle("lvis:plugins:install", async (_event, pluginId: string) => {
    const result = await pluginMarketplace.install(pluginId);
    await pluginRuntime.restartAll();
    refreshApplicationMenu();
    return result;
  });
  ipcMain.handle("lvis:plugins:uninstall", async (_event, pluginId: string) => {
    const result = await pluginMarketplace.uninstall(pluginId);
    await pluginRuntime.restartAll();
    refreshApplicationMenu();
    return result;
  });
  ipcMain.handle("lvis:plugins:ui:list", async () => {
    return pluginRuntime.listUiExtensions();
  });
  ipcMain.handle("lvis:plugins:call", async (_event, method: string, payload?: unknown) => {
    return pluginRuntime.call(method, payload);
  });

  // TaskService IPC
  ipcMain.handle("lvis:tasks:add", (_event, task) => taskService.add(task));
  ipcMain.handle("lvis:tasks:update", (_event, id: string, patch) => taskService.update(id, patch));
  ipcMain.handle("lvis:tasks:get", (_event, id: string) => taskService.get(id));
  ipcMain.handle("lvis:tasks:delete", (_event, id: string) => taskService.delete(id));
  ipcMain.handle("lvis:tasks:query", (_event, filter) => taskService.query(filter));
  ipcMain.handle("lvis:tasks:pending", () => taskService.getPendingByPriority());
  ipcMain.handle("lvis:tasks:overdue", () => taskService.getOverdue());
  ipcMain.handle("lvis:tasks:today", () => taskService.getDueToday());

  createWindow();
  refreshApplicationMenu();
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", async () => {
  await pluginRuntime.stopAll();
  taskService.close();
});

app.whenReady().then(() => {
  void bootstrap().catch((error) => {
    console.error("[lvis-app] bootstrap failed", error);
    app.quit();
  });
});
