/**
 * Application menu — the native menu bar template and its per-item builders.
 *
 * Menu items reflect live state (the always-on-top checkbox, the plugin
 * sidebar views), so every builder reads through `app-state.ts` / the plugin
 * runtime at call-time and the whole template is rebuilt via
 * `refreshApplicationMenu()` whenever that state changes.
 */
import { app, Menu, type MenuItemConstructorOptions } from "electron";
import { t } from "../i18n/index.js";
import { type DetachedWindowOptions } from "./window-manager.js";
import { getMainWindow, getServices } from "./app-state.js";
import { openSettingsWindow } from "./settings-window.js";
import { refreshTrayMenu } from "./app-tray.js";

function activateView(viewKey: string) {
  getMainWindow()?.webContents.send("lvis:view:activate", { viewKey });
}

function createViewMenu() {
  const services = getServices();
  if (!services) return { label: t("be_main.menuPlugins"), submenu: [] as MenuItemConstructorOptions[] };
  const pluginViews = services.pluginRuntime
    .listUiExtensions()
    .filter((item) => item.extension.slot === "sidebar")
    .map((item) => ({
      key: `plugin:${item.pluginId}:${item.extension.id}`,
      label: item.extension.displayName?.trim() || item.extension.title || item.pluginId,
    }));
  return {
    label: t("be_main.menuPlugins"),
    submenu: [
      { label: t("be_main.menuHome"), click: () => activateView("home") },
      ...pluginViews.map((item) => ({
        label: item.label,
        click: () => activateView(item.key),
      })),
    ],
  };
}

export function detachedWindowOptionsForViewKey(viewKey: string): DetachedWindowOptions | undefined {
  const services = getServices();
  if (!services || !viewKey.startsWith("plugin:")) return undefined;
  const [, pluginId, extensionId, extra] = viewKey.split(":");
  if (!pluginId || !extensionId || extra !== undefined) return undefined;
  const view = services.pluginRuntime
    .listUiExtensions()
    .find((item) => item.pluginId === pluginId && item.extension.id === extensionId);
  return view?.extension.window;
}

export function createSettingsMenuItem(): MenuItemConstructorOptions {
  return {
    label: t("be_main.menuSettings"),
    accelerator: "CommandOrControl+,",
    click: () => {
      openSettingsWindow("llm");
    },
  };
}

function isMainWindowAlwaysOnTop(): boolean {
  const mainWindow = getMainWindow();
  return mainWindow !== null && !mainWindow.isDestroyed() && mainWindow.isAlwaysOnTop();
}

export function createAlwaysOnTopMenuItem(): MenuItemConstructorOptions {
  return {
    label: t("be_main.menuAlwaysOnTop"),
    type: "checkbox",
    checked: isMainWindowAlwaysOnTop(),
    click: () => {
      const mainWindow = getMainWindow();
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.setAlwaysOnTop(!isMainWindowAlwaysOnTop());
      refreshApplicationMenu();
      refreshTrayMenu();
    },
  };
}

function createDisplayMenu(): MenuItemConstructorOptions {
  return {
    label: t("be_main.menuView"),
    submenu: [
      { role: "reload" },
      { type: "separator" },
      createAlwaysOnTopMenuItem(),
    ],
  };
}

function createHelpMenu(): MenuItemConstructorOptions {
  return {
    label: t("be_main.menuHelp"),
    role: "help",
    submenu: [],
  };
}

function createEditMenu(): MenuItemConstructorOptions {
  return {
    label: t("be_main.menuEdit"),
    submenu: [
      { role: "undo", label: t("be_main.menuUndo") },
      { role: "redo", label: t("be_main.menuRedo") },
      { type: "separator" },
      { role: "cut", label: t("be_main.menuCut") },
      { role: "copy", label: t("be_main.menuCopy") },
      { role: "paste", label: t("be_main.menuPaste") },
      { role: "pasteAndMatchStyle", label: t("be_main.menuPasteAndMatchStyle") },
      { role: "delete", label: t("be_main.menuDelete") },
      { type: "separator" },
      { role: "selectAll", label: t("be_main.menuSelectAll") },
    ],
  };
}

export function refreshApplicationMenu() {
  const settingsMenuItem = createSettingsMenuItem();
  const editMenu = createEditMenu();
  const displayMenu = createDisplayMenu();
  const helpMenu = createHelpMenu();
  const template: MenuItemConstructorOptions[] =
    process.platform === "darwin"
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              createAlwaysOnTopMenuItem(),
              settingsMenuItem,
              { type: "separator" },
              { role: "quit" },
            ],
          },
          editMenu,
          createViewMenu(),
          displayMenu,
          helpMenu,
        ]
      : [
          { label: t("be_main.menuApp"), submenu: [createAlwaysOnTopMenuItem(), settingsMenuItem, { type: "separator" }, { role: "quit" }] },
          editMenu,
          createViewMenu(),
          displayMenu,
          helpMenu,
        ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
