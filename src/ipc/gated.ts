/**
 * gated() — validateSender + auditUnauthorized primitives, extracted from
 * ipc-bridge.ts so domain modules can import them without circular deps.
 *
 * `validateSender`, `UNAUTHORIZED_FRAME`, and `auditUnauthorized` are still
 * re-exported from `../ipc-bridge.js` for backwards compatibility with
 * external callers (window-manager.ts, tests, etc.).
 */
import type { IpcMainInvokeEvent } from "electron";
import type { AuditLogger } from "../audit/audit-logger.js";
import { redactFsPath } from "../audit/dlp-filter.js";
import { isPluginShellFrameUrl } from "../shared/plugin-shell-frame.js";

// ─── Sender validation ────────────────────────────────────────────────────────

/**
 * IPC sender validation. Accepts file:// (packaged renderer) and
 * http://localhost / http://127.0.0.1 (dev server). Anything else is rejected.
 *
 * Fails CLOSED on a missing frame. Electron nulls `senderFrame` once the
 * sending frame is destroyed or navigated away between `invoke` and handler
 * execution, so an absent frame is an unprovable sender, not a trusted one.
 *
 * This is the protocol allow-list only: it admits plugin-ui-shell frames,
 * which are also `file://`. Host IPC handlers must therefore call
 * {@link validateHostRendererSender}, which layers the shell rejection on top;
 * the plugin bridge calls {@link validatePluginFrame}, which admits only the
 * shell. Nothing else should gate on this directly — "the sender is one of our
 * own origins" does not answer "which of our own trust domains is it".
 */
export function validateSender(event: IpcMainInvokeEvent | null | undefined): boolean {
  const frame = event?.senderFrame;
  if (!frame) return false;
  const rawUrl = frame.url ?? "";
  try {
    const url = new URL(rawUrl);
    if (url.protocol === "file:") return true;
    if (url.protocol === "http:" && url.hostname === "localhost") return true;
    if (url.protocol === "http:" && url.hostname === "127.0.0.1") return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Host renderer validation for host IPC. Plugin UI shells are also file://
 * frames but intentionally receive only `window.lvisPlugin`, not host-wide
 * `window.lvisApi`; reject them explicitly.
 *
 * The narrow preload is not the boundary — it only shapes what plugin AUTHORS
 * can call. A compromised plugin renderer process reaches `ipcRenderer` itself
 * and can invoke any channel name it likes, so the frame check in main is the
 * only thing that actually holds. Every host channel gets it, read-only ones
 * included: a read still discloses host state to the plugin domain.
 */
export function validateHostRendererSender(event: IpcMainInvokeEvent | null | undefined): boolean {
  // `validateSender` already applied the accepted-protocol allow-list, already
  // rejected a missing frame, and already rejected an unparseable URL. The one
  // thing this adds is the plugin-shell rejection; the empty-URL guard below is
  // kept as a belt-and-braces restatement of the same fail-closed rule.
  if (!validateSender(event)) return false;
  const rawUrl = event?.senderFrame?.url ?? "";
  if (!rawUrl) return false;
  return !isPluginShellFrameUrl(rawUrl);
}

export const UNAUTHORIZED_FRAME = { ok: false, error: "unauthorized-frame" as const };

/**
 * Emit a warn-level audit entry for rejected IPC calls.
 *
 * `frameUrl` is run through `redactFsPath` so the username from
 * `file:///Users/<name>/...` paths doesn't leak into the audit log. This
 * function is the single shared call site for ~50 IPC handlers, so the
 * redact lands everywhere a frame URL is captured (issue #471).
 */
export function auditUnauthorized(
  auditLogger: AuditLogger,
  channel: string,
  event: IpcMainInvokeEvent,
): void {
  auditLogger.log({
    timestamp: new Date().toISOString(),
    sessionId: "ipc-guard",
    type: "warn",
    input: JSON.stringify({
      channel,
      frameUrl: redactFsPath(event?.senderFrame?.url ?? ""),
    }),
  });
}

// ─── Plugin frame validation ──────────────────────────────────────────────────

/**
 * #237 Option B — Plugin webview sender validation.
 * Plugin frames are file:// and must have loaded plugin-ui-shell.html.
 *
 * Fails CLOSED on a missing frame for the same reason `validateSender` does:
 * a destroyed or navigated-away frame cannot prove it was the plugin shell.
 */
export function validatePluginFrame(event: IpcMainInvokeEvent | null | undefined): boolean {
  const frame = event?.senderFrame;
  if (!frame) return false;
  return isPluginShellFrameUrl(frame.url ?? "");
}
