/**
 * Window domain IPC handlers.
 * Covers: window:minimize, window:toggleMaximize, window:close,
 *         window:syncTitleBarTheme
 * Also exports registerWindowEventListeners (re-used by main.ts).
 */
import { BrowserWindow, ipcMain, type BrowserWindow as ElectronBrowserWindow, type IpcMainInvokeEvent } from "electron";
import { t } from "../../i18n/index.js";
import { resolveAppIconPath } from "../../main/app-icon.js";
import {
  buildRenderHtmlPreviewShell,
  normalizeOpenHtmlPreviewWindowPayload,
  RENDER_HTML_PARTITION,
  type OpenHtmlPreviewWindowResult,
} from "../../shared/render-html-preview.js";
import { validateSender, auditUnauthorized, UNAUTHORIZED_FRAME } from "../gated.js";
import { CHANNELS } from "../../contract/app-contract.js";
import type { IpcDeps } from "../types.js";
import { isWindowControlOwned } from "../window-control-registry.js";

/**
 * Attach maximize / fullscreen state-broadcast listeners to a BrowserWindow.
 * Must be called every time a new BrowserWindow is created.
 */
export function registerWindowEventListeners(win: ElectronBrowserWindow): void {
  const broadcastMaximized = (maximized: boolean) => {
    try {
      win.webContents.send("window:maximizedChanged", maximized);
    } catch {
      // webContents may be destroyed
    }
  };
  win.on("maximize", () => broadcastMaximized(true));
  win.on("unmaximize", () => broadcastMaximized(false));
  win.on("enter-full-screen", () => {
    try { win.webContents.send("window:fullscreenChanged", true); } catch { /* destroyed */ }
  });
  win.on("leave-full-screen", () => {
    try { win.webContents.send("window:fullscreenChanged", false); } catch { /* destroyed */ }
  });
}

export function registerWindowHandlers(deps: IpcDeps): void {
  const { auditLogger, getMainWindow } = deps;
  const getSenderWindow = (e: IpcMainInvokeEvent): ElectronBrowserWindow | null =>
    BrowserWindow.fromWebContents(e.sender);
  const getSenderWindowOrMain = (e: IpcMainInvokeEvent): ElectronBrowserWindow | null =>
    getSenderWindow(e) ?? getMainWindow();
  const canUseWindowControl = (e: IpcMainInvokeEvent): boolean =>
    validateSender(e) || isWindowControlOwned(e.sender);

  ipcMain.handle("window:minimize", (e) => {
    if (!canUseWindowControl(e)) { auditUnauthorized(auditLogger, "window:minimize", e); return; }
    getSenderWindowOrMain(e)?.minimize();
  });

  ipcMain.handle("window:toggleMaximize", (e) => {
    if (!canUseWindowControl(e)) { auditUnauthorized(auditLogger, "window:toggleMaximize", e); return; }
    const win = getSenderWindowOrMain(e);
    if (!win) return;
    win.isMaximized() ? win.unmaximize() : win.maximize();
  });

  ipcMain.handle("window:close", (e) => {
    if (!canUseWindowControl(e)) { auditUnauthorized(auditLogger, "window:close", e); return; }
    getSenderWindow(e)?.close();
  });

  ipcMain.handle("window:syncTitleBarTheme", (e, payload: { color: string; symbolColor: string }) => {
    if (!canUseWindowControl(e)) { auditUnauthorized(auditLogger, "window:syncTitleBarTheme", e); return; }
    if (process.platform === "darwin") return;
    const win = getSenderWindowOrMain(e);
    if (!win || typeof win.setTitleBarOverlay !== "function") return;
    if (typeof payload?.color !== "string" || typeof payload?.symbolColor !== "string") {
      throw new Error("[lvis] window:syncTitleBarTheme: invalid payload");
    }
    try {
      win.setTitleBarOverlay({ color: payload.color, symbolColor: payload.symbolColor, height: 36 });
    } catch (err) {
      if ((err as Error).message.includes("Titlebar overlay is not enabled")) return;
      throw err;
    }
  });

  ipcMain.handle(CHANNELS.window.openHtmlPreview, async (e, payload): Promise<OpenHtmlPreviewWindowResult> => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.window.openHtmlPreview, e);
      return { ok: false, error: UNAUTHORIZED_FRAME.error };
    }

    const normalized = normalizeOpenHtmlPreviewWindowPayload(payload);
    if ((normalized as { ok?: false }).ok === false) {
      return { ok: false, error: (normalized as { error: string }).error };
    }
    const previewPayload = normalized as Exclude<typeof normalized, { ok: false; error: string }>;

    const parent = getSenderWindow(e) ?? getMainWindow() ?? undefined;
    const title = previewPayload.title ?? t("be_windowDomain.htmlPreviewDefaultTitle");
    const documentHtml = buildRenderHtmlPreviewShell({
      html: previewPayload.html,
      title,
      allowScripts: previewPayload.allowScripts === true,
      requiresScripts: previewPayload.requiresScripts === true,
      warnings: previewPayload.warnings,
      themeTokens: previewPayload.themeTokens,
    });
    const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(documentHtml)}`;
    const win = new BrowserWindow({
      parent,
      width: previewPayload.width,
      height: previewPayload.height,
      title,
      icon: resolveAppIconPath(),
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
        // JavaScript stays enabled for the host-owned toolbar shell. The
        // untrusted render_html document is isolated in a sandboxed iframe,
        // and the in-window toggle only changes that iframe's script sandbox.
        javascript: true,
        partition: RENDER_HTML_PARTITION,
      },
    });

    if (typeof win.setMenu === "function") win.setMenu(null);
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-attach-webview", (event) => {
      event.preventDefault();
    });
    win.webContents.on("will-navigate", (event, url) => {
      if (url !== dataUrl) event.preventDefault();
    });

    try {
      await win.loadURL(dataUrl);
      if (!win.isDestroyed()) win.show();
      return { ok: true, windowId: win.id };
    } catch (err) {
      if (!win.isDestroyed()) win.close();
      return {
        ok: false,
        error: err instanceof Error ? err.message : "html-preview-load-failed",
      };
    }
  });
}
