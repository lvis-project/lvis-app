/**
 * Window domain IPC handlers.
 * Covers: window:minimize, window:toggleMaximize, window:close,
 *         window:syncTitleBarTheme
 * Also exports registerWindowEventListeners (re-used by main.ts).
 */
import { BrowserWindow, ipcMain, type BrowserWindow as ElectronBrowserWindow, type IpcMainInvokeEvent } from "electron";
import { validateSender, auditUnauthorized } from "../gated.js";
import type { IpcDeps } from "../types.js";

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

  ipcMain.handle("window:minimize", (e) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "window:minimize", e); return; }
    getSenderWindowOrMain(e)?.minimize();
  });

  ipcMain.handle("window:toggleMaximize", (e) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "window:toggleMaximize", e); return; }
    const win = getSenderWindowOrMain(e);
    if (!win) return;
    win.isMaximized() ? win.unmaximize() : win.maximize();
  });

  ipcMain.handle("window:close", (e) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "window:close", e); return; }
    getSenderWindow(e)?.close();
  });

  ipcMain.handle("window:syncTitleBarTheme", (e, payload: { color: string; symbolColor: string }) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, "window:syncTitleBarTheme", e); return; }
    if (process.platform === "darwin") return;
    const win = getSenderWindowOrMain(e);
    if (!win || typeof win.setTitleBarOverlay !== "function") return;
    if (typeof payload?.color !== "string" || typeof payload?.symbolColor !== "string") {
      throw new Error("[lvis] window:syncTitleBarTheme: invalid payload");
    }
    win.setTitleBarOverlay({ color: payload.color, symbolColor: payload.symbolColor, height: 36 });
  });
}
