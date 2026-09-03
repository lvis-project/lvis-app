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
 * The renderer subscribes via `window.lvis.onBootstrapStatus`, but on a cold
 * boot the whole sequence is already over before the renderer exists:
 * `main.ts` awaits `bootstrap()` while the window still shows the splash
 * document, so every send lands on a webContents with no listener. Each
 * snapshot is therefore also recorded in module state and served over
 * `CHANNELS.bootstrap.statusGet`, which the renderer hook pulls once on
 * mount — a live event that arrives first always wins over the pull, so the
 * older snapshot can never overwrite a newer event. The record is
 * process-lifetime only: nothing is written to disk, and the next boot
 * re-emits from the cached registry state.
 */

import type { BrowserWindow } from "electron";
import type { AppBootstrapStatus } from "../shared/bootstrap-status.js";

/** IPC channel name. Mirrored in preload.ts and the renderer hook. */
export const BOOTSTRAP_STATUS_CHANNEL = "lvis:bootstrap:status";

/**
 * The last snapshot passed to `notifyBootstrapStatus`, or `null` before the
 * first one. Process-lifetime only.
 */
let recordedStatus: AppBootstrapStatus | null = null;

/**
 * The last bootstrap status this process reported. `CHANNELS.bootstrap.statusGet`
 * serves it so a renderer that mounted after boot still sees the outcome.
 */
export function latestBootstrapStatus(): AppBootstrapStatus | null {
  return recordedStatus;
}

/**
 * Record a bootstrap status snapshot and send it to the renderer. Safe to
 * call before the window is ready — the send is best-effort and silent on
 * failure, and the record is what a late-mounting renderer reads back over
 * `CHANNELS.bootstrap.statusGet`.
 */
export function notifyBootstrapStatus(
  mainWindow: BrowserWindow | null | undefined,
  status: AppBootstrapStatus,
): void {
  // Recorded before the send gate: a cold boot has no listener yet, and that
  // is precisely the case the pull exists to cover.
  recordedStatus = status;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send(BOOTSTRAP_STATUS_CHANNEL, status);
  } catch {
    // Best-effort: a destroyed/loading webContents shouldn't take down boot.
  }
}
