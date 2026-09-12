import type { BrowserWindow } from "electron";
import { sendToWindow } from "../ipc/safe-send.js";
import { PERMISSIONS } from "../shared/ipc-channels.js";

export function broadcastPermissionConfigChangedFromHost(windows: readonly BrowserWindow[]): void {
  for (const window of windows) sendToWindow(window, PERMISSIONS.configChanged, {});
}
