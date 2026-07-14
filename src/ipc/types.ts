/**
 * IPC shared types — dependency injection bag passed to every domain registrar.
 */
import type { BrowserWindow } from "electron";
import type { AppServices } from "../boot/types.js";
import type { PermissionDirectoryLifecycle } from "../permissions/permission-slash.js";

export type IpcDeps = AppServices & {
  getMainWindow: () => BrowserWindow | null;
  getAppWindows?: () => Array<BrowserWindow | null | undefined>;
  /**
   * Main-process-owned workspace registry lifecycle. Workspace handlers wire
   * this once during IPC registration; permission IPC resolves it lazily when
   * a mutating command runs so Settings cannot fall back to settings-only
   * allow/deny writes.
   */
  workspaceRootLifecycle?: PermissionDirectoryLifecycle;
};
