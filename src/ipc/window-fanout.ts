/**
 * Window fan-out — `fanOutToAllWindows`: send one channel to every window in a
 * list, and count the deliveries.
 *
 * It composes ON TOP of {@link sendToWindow} from `safe-send.ts` rather than
 * duplicating its destroyed-check + try/catch — `sendToWindow` already owns the
 * per-window "is this WebContents still alive, swallow a send race" contract,
 * so a send that fails on one window returns `false` there and the loop carries
 * on. This module adds only the fan-out concern: iterate, count, and — when the
 * caller passes an `auditLogger` — emit one audit row for the whole fan-out.
 *
 * It is not the only fan-out in `src/ipc`, and nothing here makes it so. Other
 * domains resolve the same window list and then either call in here or walk it
 * themselves; `grep -rnF 'getAppWindows?.()' src/ipc` lists both kinds.
 */
import type { BrowserWindow } from "electron";
import { sendToWindow, type SafeSendLogger } from "./safe-send.js";

/** Minimal audit sink — the subset of `AuditLogger.log` this module needs. */
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
