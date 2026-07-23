import type { BrowserWindow } from "electron";
import { CHANNELS } from "../contract/app-contract.js";

/**
 * Attach maximize/fullscreen state broadcasts to one native window.
 *
 * This is a leaf module shared by native window constructors and the IPC
 * compatibility facade. Keeping it outside an IPC domain prevents native
 * window creation from importing the entire handler graph.
 */
export function registerWindowEventListeners(win: BrowserWindow): void {
  const broadcastMaximized = (maximized: boolean) => {
    try {
      win.webContents.send(CHANNELS.window.maximizedChanged, maximized);
    } catch {
      // webContents may already be destroyed during native-window teardown.
    }
  };
  win.on("maximize", () => broadcastMaximized(true));
  win.on("unmaximize", () => broadcastMaximized(false));
  win.on("enter-full-screen", () => {
    try { win.webContents.send(CHANNELS.window.fullscreenChanged, true); } catch { /* destroyed */ }
  });
  win.on("leave-full-screen", () => {
    try { win.webContents.send(CHANNELS.window.fullscreenChanged, false); } catch { /* destroyed */ }
  });
}
