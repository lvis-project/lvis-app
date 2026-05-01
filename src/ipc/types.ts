/**
 * IPC shared types — dependency injection bag passed to every domain registrar.
 */
import type { BrowserWindow } from "electron";
import type { AppServices } from "../boot/types.js";

export type IpcDeps = AppServices & {
  getMainWindow: () => BrowserWindow | null;
};
