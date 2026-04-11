/**
 * LVIS App — Electron Main Process Entry
 *
 * 슬림 엔트리. 모든 로직은 boot.ts와 ipc-bridge.ts로 위임.
 * §4.1 Client Architecture 준수.
 */
import { Menu, app, BrowserWindow, type MenuItemConstructorOptions } from "electron";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrap, type AppServices } from "./boot.js";
import { registerIpcHandlers } from "./ipc-bridge.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const distRoot = resolve(__dirname, "..");
const projectRoot = resolve(distRoot, "..");

// WSL 환경 대응
if (process.platform === "linux" && process.env.WSL_DISTRO_NAME) {
  app.commandLine.appendSwitch("enable-features", "UseOzonePlatform");
  if (process.env.WAYLAND_DISPLAY) {
    app.commandLine.appendSwitch("ozone-platform-hint", "wayland");
  } else if (process.env.DISPLAY) {
    app.commandLine.appendSwitch("ozone-platform-hint", "x11");
  }
}
// app.disableHardwareAcceleration();

let mainWindow: BrowserWindow | null = null;
let services: AppServices | null = null;

function activateView(viewKey: string) {
  mainWindow?.webContents.send("lvis:view:activate", { viewKey });
}

function createViewMenu() {
  if (!services) return { label: "플러그인", submenu: [] as MenuItemConstructorOptions[] };
  const pluginViews = services.pluginRuntime
    .listUiExtensions()
    .filter((item) => item.extension.slot === "sidebar")
    .map((item) => ({
      key: `plugin:${item.pluginId}:${item.extension.id}`,
      label: item.extension.displayName?.trim() || item.extension.title || item.pluginId,
    }));
  return {
    label: "플러그인",
    submenu: [
      { label: "홈", click: () => activateView("home") },
      ...pluginViews.map((item) => ({
        label: item.label,
        click: () => activateView(item.key),
      })),
    ],
  };
}

function refreshApplicationMenu() {
  const template: MenuItemConstructorOptions[] =
    process.platform === "darwin"
      ? [
          { label: app.name, submenu: [{ role: "about" }, { type: "separator" }, { role: "quit" }] },
          createViewMenu(),
          { label: "편집", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }] },
          { label: "보기", submenu: [{ role: "reload" }, { role: "toggleDevTools" }] },
        ]
      : [createViewMenu()];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    show: true, // 즉시 표시
    autoHideMenuBar: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: resolve(__dirname, "preload.cjs"),
    },
  });

  const win = mainWindow;
  
  // 디버깅을 위해 DevTools를 자동으로 엽니다.
  win.webContents.openDevTools();

  win.once("ready-to-show", () => {
    console.log("[lvis] window ready-to-show");
    win.show();
    win.focus();
  });
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });
  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    console.error("[lvis] window failed to load", { code, desc, url });
  });
  void win.loadFile(resolve(__dirname, "index.html")).catch((err) => {
    console.error("[lvis] failed to load index.html", err);
  });
}

async function main() {
  // §4.2 Boot Sequence
  services = await bootstrap(projectRoot);

  // §4.1 IPC Bridge
  registerIpcHandlers(services, () => mainWindow);

  // §4.2 Step 8: UI 렌더링
  createWindow();
  refreshApplicationMenu();
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", async () => {
  if (services) {
    await services.pluginRuntime.stopAll();
    services.taskService.close();
  }
});

app.whenReady().then(() => {
  void main().catch((error) => {
    console.error("[lvis] bootstrap failed", error);
    app.quit();
  });
});
