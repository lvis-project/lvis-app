/**
 * Audit domain IPC handlers.
 * Covers: lvis:audit:*, lvis:dlp:*
 */
import { ipcMain } from "electron";
import { validateSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import { isDemoEnabled } from "../../main/demo-credentials.js";
import type { IpcDeps } from "../types.js";

/**
 * Live Auto-play (proposal §8) — `[demo-autoplay]` audit prefix is enforced
 * here so a buggy renderer can't slip a non-prefixed entry through. All
 * fields are coerced to strings and length-capped to keep audit lines bounded.
 *
 * Security gate: handler is registered ONLY when main captured demo
 * credentials at boot. Production builds without captured activation never
 * expose this channel — a malicious renderer can't spam fake demo audit
 * lines because `ipcMain.handle` was never called.
 */
const DEMO_AUDIT_PREFIX = "[demo-autoplay]";
const DEMO_AUDIT_MAX_FIELD_LEN = 256;
const DEMO_AUDIT_RATE_LIMIT_PER_SECOND = 30;

function clampPrefix(value: unknown): string {
  const raw = typeof value === "string" ? value : "";
  const trimmed = raw.slice(0, DEMO_AUDIT_MAX_FIELD_LEN);
  // Force prefix even if the renderer forgot or tried to bypass it.
  if (trimmed.startsWith(DEMO_AUDIT_PREFIX)) return trimmed;
  return `${DEMO_AUDIT_PREFIX} ${trimmed}`;
}

export function registerAuditHandlers(deps: IpcDeps): void {
  const { auditLogger, conversationLoop } = deps;

  // read-only, sender guard optional
  ipcMain.handle("lvis:audit:search", async (_e, filter: Parameters<typeof auditLogger.search>[0]) => {
    return auditLogger.search(filter);
  });

  // read-only, sender guard optional
  ipcMain.handle("lvis:audit:stats", async (_e, lastDays: number) => {
    return auditLogger.getStats(typeof lastDays === "number" ? lastDays : 7);
  });

  // read-only, sender guard optional
  ipcMain.handle("lvis:dlp:stats", async (_e, days: number) => {
    const { getDlpStats } = await import("../../audit/dlp-stats.js");
    return getDlpStats(typeof days === "number" ? days : 7);
  });

  // Live Auto-play — renderer-side demo events. The handler is the SOLE
  // entry point for `[demo-autoplay]` audit lines: it enforces the prefix
  // (so search filters work) and forces `type: "info"` so demo entries
  // never pollute the `turn` / `tool_call` / `approval` analytics channels.
  //
  // Activation gate (security): only register when main captured demo
  // credentials at boot. Packaged builds scrub `LVIS_DEMO_*` before preload
  // inherits env, so this must use the host-owned captured state.
  if (!isDemoEnabled()) {
    return;
  }

  // Lightweight rate limiter — defends the audit log against a buggy or
  // hostile renderer that loops on the IPC. The engine emits ~5-15 events
  // per scripted turn, so 30/s is generous for legitimate playback.
  let windowStart = Date.now();
  let windowCount = 0;
  function admit(): boolean {
    const now = Date.now();
    if (now - windowStart >= 1000) {
      windowStart = now;
      windowCount = 0;
    }
    windowCount += 1;
    return windowCount <= DEMO_AUDIT_RATE_LIMIT_PER_SECOND;
  }

  ipcMain.handle(
    "lvis:audit:log-demo-autoplay",
    async (
      e,
      payload: { scriptId?: unknown; phase?: unknown; detail?: unknown },
    ): Promise<{ ok: true } | { ok: false; error: string; message: string }> => {
      if (!validateSender(e)) {
        auditUnauthorized(auditLogger, "lvis:audit:log-demo-autoplay", e);
        return { ok: false, error: UNAUTHORIZED_FRAME.error, message: "unauthorized frame" };
      }
      if (!admit()) {
        return { ok: false, error: "rate-limited", message: "demo audit rate limit exceeded" };
      }
      const scriptId = clampPrefix(payload?.scriptId);
      const phase = clampPrefix(payload?.phase);
      const detail = typeof payload?.detail === "string" ? payload.detail.slice(0, DEMO_AUDIT_MAX_FIELD_LEN) : "";
      auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: conversationLoop.getSessionId(),
        type: "info",
        input: `${scriptId}`,
        output: detail ? `${phase} ${detail}` : phase,
        route: "demo-autoplay",
      });
      return { ok: true };
    },
  );
}
