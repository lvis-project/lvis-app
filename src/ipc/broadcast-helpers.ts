/**
 * IPC fan-out helper — single source of truth for the
 * "send one channel to every open app window" broadcast pattern.
 *
 * Before this helper, every one-way main → renderer fan-out site
 * (`tour.ts` tour-start, settings updates, …)
 * re-derived the same loop:
 *
 *   const targets = deps.getAppWindows?.() ?? [deps.getMainWindow()];
 *   for (const win of targets) {
 *     if (!win || win.isDestroyed?.()) continue;
 *     try { win.webContents.send(channel, payload); }
 *     catch (err) { log.warn(..., "broadcast failed for one window"); }
 *   }
 *
 * This helper composes ON TOP of {@link sendToWindow} from `safe-send.ts`
 * rather than duplicating its destroyed-check + try/catch — `sendToWindow`
 * already owns the per-window "is this WebContents still alive, swallow a
 * send race" contract. `fanOutToAllWindows` adds only the fan-out concern:
 * iterate every window, count successes, and emit a single audit row.
 *
 * The per-window error path is preserved: a `logger`/`SafeSendLogger`
 * forwarded to `sendToWindow` logs each skipped send (matching the prior
 * `log.warn(..., "broadcast failed for one window")` behaviour), and one
 * window's failure never blocks the others.
 */
import type { BrowserWindow } from "electron";
import { sendToWindow, type SafeSendLogger } from "./safe-send.js";

/** Minimal audit sink — the subset of `AuditLogger.log` this helper needs. */
export interface BroadcastAuditLogger {
  log: (entry: {
    timestamp: string;
    sessionId: string;
    type: "info";
    input: string;
  }) => void;
}

export interface FanOutOptions {
  /** Forwarded to `sendToWindow` for per-window send-race logging. */
  logger?: SafeSendLogger;
  /**
   * When provided, emit a single `info` audit row recording the channel +
   * how many windows received the payload. `sessionId` defaults to `"ipc"`.
   * Audit failures never break the broadcast.
   */
  auditLogger?: BroadcastAuditLogger;
  /** Audit row `sessionId`. Defaults to `"ipc"`. */
  auditSessionId?: string;
}

/**
 * Fan a one-way IPC `payload` out to every window in `windows`.
 *
 * Each send goes through {@link sendToWindow}, which returns `false` for a
 * null / destroyed window or a swallowed send race. Returns the number of
 * windows that actually received the payload.
 */
export function fanOutToAllWindows(
  windows: Array<BrowserWindow | null | undefined>,
  channel: string,
  payload: unknown,
  options: FanOutOptions = {},
): number {
  let delivered = 0;
  for (const win of windows) {
    if (sendToWindow(win, channel, payload, options.logger)) {
      delivered += 1;
    }
  }
  if (options.auditLogger) {
    try {
      options.auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: options.auditSessionId ?? "ipc",
        type: "info",
        input: `[broadcast] channel=${channel} delivered=${delivered}/${windows.length}`,
      });
    } catch {
      /* audit must not break IPC fan-out */
    }
  }
  return delivered;
}
