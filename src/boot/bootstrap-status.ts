/**
 * First-boot bootstrap status surface.
 *
 * The managed plugin bootstrap (`ensureManagedInstalled`) runs once at boot
 * and is graceful by design: marketplace unreachable, per-plugin install
 * failures, or signature rejections never throw out of `boot()`. Pre-Phase
 * 2d those outcomes were silent — only `log.warn` lines, nothing the
 * user could see — so a first-launch with the marketplace server down or
 * misconfigured looked like the app was working but actually had zero
 * managed plugins loaded.
 *
 * This module emits a status snapshot to the renderer over a single IPC
 * channel so a small banner / toast can surface "X plugins pending,
 * retry?". Three lifecycle states are reported:
 *   - `start`       — bootstrap call enqueued (renderer can show a spinner)
 *   - `complete`    — finished; payload lists installed + failed + skipped
 *   - `error`       — bootstrap itself threw (catalog fetch failure, etc.)
 *
 * The renderer subscribes via `window.lvis.onBootstrapStatus`. There is no
 * persistence — refreshing the app re-emits the latest snapshot from the
 * cached registry state on next boot.
 */

import type { BrowserWindow } from "electron";

export interface BootstrapStatusStart {
  phase: "start";
}

export interface BootstrapStatusComplete {
  phase: "complete";
  /** Plugin IDs successfully installed during this bootstrap. */
  installed: string[];
  /** Plugins that failed (network, signature, dependency) with error detail. */
  failed: Array<{ id: string; error: string }>;
  /** Reason from `resolveManagedPluginBootstrap` when the call was skipped. */
  skippedReason?: string;
}

export interface BootstrapStatusError {
  phase: "error";
  /** Single sentence — surfaced verbatim to the renderer banner. */
  message: string;
}

export type BootstrapStatus =
  | BootstrapStatusStart
  | BootstrapStatusComplete
  | BootstrapStatusError;

/** IPC channel name. Mirrored in preload.ts and the renderer hook. */
export const BOOTSTRAP_STATUS_CHANNEL = "lvis:bootstrap:status";

/**
 * Send a bootstrap status snapshot to the renderer. Safe to call before the
 * window is ready — the send is best-effort and silent on failure (the
 * renderer hook re-syncs from `getBootstrapStatus()` on connect).
 */
export function notifyBootstrapStatus(
  mainWindow: BrowserWindow | null | undefined,
  status: BootstrapStatus,
): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send(BOOTSTRAP_STATUS_CHANNEL, status);
  } catch {
    // Best-effort: a destroyed/loading webContents shouldn't take down boot.
  }
}
