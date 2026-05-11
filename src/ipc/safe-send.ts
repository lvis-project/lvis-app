import type { BrowserWindow, WebContents } from "electron";

export interface SafeSendLogger {
  warn: (obj: Record<string, unknown>, message: string) => void;
}

export function sendToWebContents(
  webContents: WebContents | null | undefined,
  channel: string,
  payload: unknown,
  logger?: SafeSendLogger,
): boolean {
  if (!webContents) return false;
  try {
    const destroyed = typeof webContents.isDestroyed === "function" && webContents.isDestroyed();
    if (destroyed) return false;
    webContents.send(channel, payload);
    return true;
  } catch (err) {
    logger?.warn({
      channel,
      error: err instanceof Error ? err.message : String(err),
    }, "renderer IPC send skipped");
    return false;
  }
}

export function sendToWindow(
  win: BrowserWindow | null | undefined,
  channel: string,
  payload: unknown,
  logger?: SafeSendLogger,
): boolean {
  if (!win || win.isDestroyed()) return false;
  return sendToWebContents(win.webContents, channel, payload, logger);
}
