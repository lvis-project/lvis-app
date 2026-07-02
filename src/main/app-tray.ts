/**
 * System tray icon + context menu, and the "show or re-create the main
 * window" entry point the tray, menu, and macOS `activate` handler share.
 *
 * The tray instance lives in `app-state.ts`; this module owns its creation,
 * menu template, and click wiring.
 */
import { Menu, nativeImage, Tray } from "electron";
import { t } from "../i18n/index.js";
import { createLvisTrayIcon } from "./tray-icon.js";
import { getMainWindow, getTray, isRendererReloadReady, setTray } from "./app-state.js";
import {
  createWindow,
  loadMainInterface,
  registerMainWindowPluginEventBridge,
  showMainWindow,
} from "./main-window.js";
import { createAlwaysOnTopMenuItem, createSettingsMenuItem, refreshApplicationMenu } from "./app-menu.js";

export function showOrCreateMainWindow(reason: string): void {
  const existing = getMainWindow();
  if (existing && !existing.isDestroyed()) {
    showMainWindow(existing);
    refreshApplicationMenu();
    refreshTrayMenu();
    return;
  }
  createWindow({ showBootstrapSplash: false });
  const mainWindow = getMainWindow();
  if (mainWindow) registerMainWindowPluginEventBridge(mainWindow);
  if (mainWindow && isRendererReloadReady()) {
    void loadMainInterface(mainWindow, reason).finally(() => {
      refreshApplicationMenu();
      refreshTrayMenu();
    });
  }
  refreshApplicationMenu();
  refreshTrayMenu();
}

export function refreshTrayMenu(): void {
  const tray = getTray();
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: t("be_main.menuOpenLvis"),
      click: () => showOrCreateMainWindow("tray-open"),
    },
    { type: "separator" },
    createAlwaysOnTopMenuItem(),
    createSettingsMenuItem(),
    { type: "separator" },
    { label: t("be_main.menuQuit"), role: "quit" },
  ]));
}

function createTrayIcon() {
  return createLvisTrayIcon({ nativeImage });
}

export function ensureTray(): void {
  if (getTray()) return;
  const tray = new Tray(createTrayIcon());
  setTray(tray);
  tray.setToolTip("LVIS");
  tray.on("click", () => showOrCreateMainWindow("tray-click"));
  tray.on("double-click", () => showOrCreateMainWindow("tray-double-click"));
  refreshTrayMenu();
}
