/**
 * Native settings BrowserWindow — creation, navigation policy, and the two
 * IPC handlers (`lvis:settings-window:open` / `:saved`) that drive it.
 *
 * The window instance lives in `app-state.ts`; the pending-tab handoff (a tab
 * requested while the renderer is still loading) is a private detail of this
 * module.
 */
import { BrowserWindow, ipcMain, shell, type IpcMainInvokeEvent } from "electron";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { t } from "../i18n/index.js";
import { createLogger } from "../lib/logger.js";
import { mainDir } from "./main-paths.js";
import { getCommonChromeOptions } from "./window-chrome.js";
import { resolveAppIconPath } from "./app-icon.js";
import { normalizeSettingsTab } from "../shared/settings-tabs.js";
import {
  auditUnauthorized,
  registerWindowEventListeners,
  UNAUTHORIZED_FRAME,
  validateSender,
} from "../ipc-bridge.js";
import type { AppServices } from "../boot.js";
import { getSettingsWindow, setSettingsWindow } from "./app-state.js";
import { getAppWindows, initialThemeArgs, rendererIndexUrl } from "./main-window.js";
import { activateInlineSettings } from "./app-menu.js";

const log = createLogger("lvis");

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const SETTINGS_WINDOW_WIDTH = 1040;
const SETTINGS_WINDOW_HEIGHT = 760;
const SETTINGS_WINDOW_MIN_WIDTH = 820;
const SETTINGS_WINDOW_MIN_HEIGHT = 560;

// Holds the most-recently requested tab while the settings window's renderer
// is still loading. Flushed once on `did-finish-load`; any later tab requests
// after the renderer is ready are sent immediately via IPC. See the rapid
// second-invoke race the renderer review surfaced.
let settingsWindowPendingTab: string | null = null;

function settingsWindowUrl(initialTab: string): string {
  return `${rendererIndexUrl()}#settings/${encodeURIComponent(initialTab)}`;
}

function isSettingsWindowUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const expected = new URL(rendererIndexUrl());
    return (
      parsed.protocol === "file:" &&
      parsed.origin === expected.origin &&
      parsed.pathname === expected.pathname &&
      parsed.hash.startsWith("#settings/")
    );
  } catch {
    return false;
  }
}

/**
 * @deprecated UNREACHABLE as of the settings-inline-overhaul (R4). Every
 * settings-open path now routes to the inline panel via `activateInlineSettings`
 * (app-menu.ts); no caller invokes this and the `lvis:settings-window:open` IPC
 * redirects inline. The detached-window machinery (this function,
 * `settingsWindowUrl`/`isSettingsWindowUrl`, the `settingsWindowPendingTab`
 * handoff, and the `SettingsWindow.tsx` renderer entry) is intentionally left
 * in place — a follow-up removes it once `getAppWindows`/save-broadcast fan-out
 * and `get/setSettingsWindow` app-state can be simplified together. It creates a
 * `new BrowserWindow`, so it MUST stay uncalled.
 */
export function openSettingsWindow(initialTabInput: unknown = "llm"): BrowserWindow {
  const initialTab = normalizeSettingsTab(initialTabInput);
  const preloadPath = resolve(mainDir, "..", "preload.cjs");
  if (!existsSync(preloadPath)) {
    throw new Error(`[lvis] preload.cjs not found at ${preloadPath} — run 'npm run build:preload' first`);
  }

  const existing = getSettingsWindow();
  if (existing && !existing.isDestroyed()) {
    // If the renderer is still loading, the IPC listener isn't attached yet
    // and `webContents.send` would be lost. Park the tab so the existing
    // `did-finish-load` flusher can deliver it; otherwise send immediately.
    if (existing.webContents.isLoading()) {
      settingsWindowPendingTab = initialTab;
    } else {
      existing.webContents.send("lvis:settings-window:tab", { initialTab });
    }
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    return existing;
  }

  const win = new BrowserWindow({
    width: SETTINGS_WINDOW_WIDTH,
    height: SETTINGS_WINDOW_HEIGHT,
    minWidth: SETTINGS_WINDOW_MIN_WIDTH,
    minHeight: SETTINGS_WINDOW_MIN_HEIGHT,
    show: false,
    title: t("be_main.settingsWindowTitle"),
    icon: resolveAppIconPath(),
    autoHideMenuBar: true,
    // Chrome unification — spread from the shared helper so settings,
    // main, link, and auth windows all stay byte-identical.
    ...getCommonChromeOptions(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: false,
      preload: preloadPath,
      // Settings window must paint its first frame against the active bundle
      // tokens — without this the dialog flashes the default-bundle palette
      // until ThemeProvider's async hydrate lands. Same mechanism as main
      // and detached windows (architecture.md §6.7.1 "race window = 0").
      additionalArguments: initialThemeArgs(),
    },
  });
  setSettingsWindow(win);
  // Keep the hidden application menu attached so standard Edit-role
  // accelerators (Cmd/Ctrl+C/V/X/A/Z) continue to work in settings inputs.
  // `autoHideMenuBar` preserves the chrome-free settings-window appearance.

  registerWindowEventListeners(win);

  win.once("ready-to-show", () => {
    win.show();
    win.focus();
  });
  win.on("closed", () => {
    if (getSettingsWindow() === win) setSettingsWindow(null);
    settingsWindowPendingTab = null;
  });
  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    log.error({ code, desc, url }, "settings window failed to load");
  });
  // Drain any tab requests queued while the renderer was loading. The initial
  // URL fragment already lands us on the right tab for the FIRST open; this
  // covers a rapid second `openSettingsWindow(differentTab)` invocation before
  // the renderer's IPC listener has attached.
  win.webContents.once("did-finish-load", () => {
    if (settingsWindowPendingTab && !win.isDestroyed()) {
      win.webContents.send("lvis:settings-window:tab", { initialTab: settingsWindowPendingTab });
      settingsWindowPendingTab = null;
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsedUrl = new URL(url);
      if (parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:") {
        void shell.openExternal(parsedUrl.toString()).catch((err) => {
          log.error({ url: parsedUrl.toString(), err }, "failed to open external URL from settings window");
        });
      }
    } catch (err) {
      log.warn({ url, err }, "blocked invalid settings window URL");
    }
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (details) => {
    const url = details.url;
    if (isSettingsWindowUrl(url)) return;
    details.preventDefault();
    try {
      const parsedUrl = new URL(url);
      if (parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:") {
        void shell.openExternal(parsedUrl.toString()).catch((err) => {
          log.error({ url: parsedUrl.toString(), err }, "failed to open external URL from settings window navigation");
        });
        return;
      }
      log.warn({ url }, "blocked settings window navigation");
    } catch (err) {
      log.warn({ url, err }, "blocked invalid settings window navigation");
    }
  });

  void win.loadURL(settingsWindowUrl(initialTab));
  return win;
}

export function registerSettingsWindowHandlers(auditLogger: AppServices["auditLogger"]): void {
  ipcMain.handle("lvis:settings-window:open", (event: IpcMainInvokeEvent, initialTab: unknown) => {
    if (!validateSender(event)) {
      auditUnauthorized(auditLogger, "lvis:settings-window:open", event);
      return UNAUTHORIZED_FRAME;
    }
    try {
      // Defence-in-depth: settings never detaches to its own BrowserWindow
      // anymore (settings-inline-overhaul). Any remaining caller of this IPC is
      // redirected to the INLINE settings panel — no `new BrowserWindow` path.
      activateInlineSettings(initialTab);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  });

  ipcMain.handle("lvis:settings-window:saved", (event: IpcMainInvokeEvent) => {
    if (!validateSender(event)) {
      auditUnauthorized(auditLogger, "lvis:settings-window:saved", event);
      return UNAUTHORIZED_FRAME;
    }
    // Broadcast to every app-owned window (main + detached) so any consumer
    // — not just the main window — can react to a settings save. Same scope
    // as the SETTINGS.updated state broadcast; this `saved` signal is the
    // discrete "save committed, you may close" event vs. the state diff.
    for (const win of getAppWindows()) {
      if (win === getSettingsWindow()) continue; // sender skip — settings window initiated and closes itself
      win.webContents.send("lvis:settings-window:saved");
    }
    return { ok: true };
  });
}
