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

// ─── Sender validation ────────────────────────────────────────────────────────

/**
 * M3 — IPC sender validation. Accepts file:// (packaged renderer) and
 * http://localhost / http://127.0.0.1 (dev server). Anything else is rejected.
 * Tests may pass null/undefined events — those are treated as trusted.
 */
export function validateSender(event: IpcMainInvokeEvent | null | undefined): boolean {
  const frame = event?.senderFrame;
  if (!frame) return true;
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
 */
export function validatePluginFrame(event: IpcMainInvokeEvent | null | undefined): boolean {
  const frame = event?.senderFrame;
  if (!frame) return true;
  const rawUrl = frame.url ?? "";
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "file:") return false;
    const pathname = url.pathname.toLowerCase();
    return pathname.endsWith("/plugin-ui-shell.html");
  } catch {
    return false;
  }
}
