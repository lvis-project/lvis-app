/**
 * NotificationService — Issue #260 system-level notify_user integration.
 *
 * Auto-fires desktop notifications at 4 lifecycle points:
 *   1. Turn end (ConversationLoop.runTurn resolves)
 *   2. Routine fired (RoutineEngine result delivered)
 *   3. Agent asks question (AskUserQuestionGate.requestAndWait entry)
 *   4. Confirmation needed (ApprovalGate.requestAndWait entry)
 *
 * notify_user is NOT an LLM tool. The LLM never invokes it directly. It's a
 * passive system service constructed in boot.ts AFTER the main window exists
 * and injected into AppServices so all 4 trigger sites can call
 * `services.notificationService.fire(...)`.
 *
 * Routing:
 *   - Window focused & not minimized → in-app toast via
 *     `lvis:notification:toast` IPC (renderer status bar slot).
 *   - Otherwise → OS Notification (silent: !urgent).
 *
 * Audit (only title — body may contain PII):
 *   { event: "notification.fired", kind, gate: "os" | "in-app", title, timestamp }
 *
 * Test-mode hard-guard: NODE_ENV === "test" or !app.isReady() → no-op.
 */
import type { BrowserWindow } from "electron";
import type { AuditLogger } from "../audit/audit-logger.js";
import { createLogger } from "../lib/logger.js";
import { stripMarkdown } from "../shared/strip-markdown.js";
const log = createLogger("lvis");

export type NotificationKind = "turn-end" | "routine" | "ask-user" | "approval" | "plugin";

/**
 * Closed enumeration of valid `NotificationKind` values. Exported so IPC
 * handlers can validate untrusted renderer payloads without re-listing the
 * kinds inline. `plugin` was added in #841 when manifest-driven plugin
 * notifications were routed through this service to inherit cooldown,
 * truncation, sanitization, click-restore, and structured audit.
 */
export const NOTIFICATION_KINDS: ReadonlySet<NotificationKind> = new Set([
  "turn-end",
  "routine",
  "ask-user",
  "approval",
  "plugin",
]);

export interface NotificationContextRef {
  sessionId?: string;
  routineId?: string;
  questionId?: string;
  approvalId?: string;
}

export interface FireOptions {
  kind: NotificationKind;
  title: string;
  /** Raw text — service caps at 80 chars + ellipsis. */
  body: string;
  contextRef?: NotificationContextRef;
  /** Approval defaults true; rest default false. */
  urgent?: boolean;
  /**
   * #843 — opt out of the focus-suppression gate. When true, the OS
   * notification fires regardless of focus state (critical surfaces like
   * `meeting.starting-soon` / `approval.deadline-imminent` / `incident.page`).
   * Defaults false. Routed through from `plugin.json` manifest's
   * `notificationEvents[i].bypassFocusGate`. Independent of `urgent` —
   * a critical notification can be focus-bypassed without being marked urgent
   * (silent: !urgent still applies).
   */
  bypassFocusGate?: boolean;
}

/**
 * IPC channel — main process → renderer; payload sent via window.lvisApi.
 * NEVER expose on window.lvisPlugin (plugin webview isolation contract).
 */
export const IPC_NOTIFICATION_TOAST = "lvis:notification:toast";
/**
 * IPC channel — renderer → main; fired when the user clicks an in-app toast
 * (via the renderer's status-bar bridge) or when an OS notification's click
 * handler triggers focus.
 */
export const IPC_NOTIFICATION_CLICKED = "lvis:notification:clicked";

/**
 * Output cap — applied to BOTH body (toast / OS / audit) and title (audit).
 * Body and title share the same 80-char limit; the constant name is retained
 * for API stability but is now a single output cap rather than a body-only cap.
 */
const BODY_MAX_CHARS = 80;
const ELLIPSIS = "…";

/**
 * Per-kind cooldown map (ms). Anti-spam guard against turn-loop bursts and
 * micro-burst approvals. Values:
 *   - turn-end : 30 s (most spammy — long agentic loops)
 *   - approval : 2 s  (coalesce micro-bursts only)
 *   - routine  : 0    (rare — always fire)
 *   - ask-user : 0    (rare — user expects every one)
 *   - plugin   : 5 s  (#841 — protects against runaway plugin emit loops)
 *
 * In-memory only — cooldown resets on app restart by design
 * (cross-restart persistence is overkill for an anti-spam gate).
 */
const COOLDOWN_MS_BY_KIND: Record<NotificationKind, number> = {
  "turn-end": 30_000,
  approval: 2_000,
  routine: 0,
  "ask-user": 0,
  // #841 — plugin notifications inherit a 5s cooldown. Lower than turn-end
  // because plugin events span many distinct surfaces (meeting/work-proactive
  // /agent-hub etc.) and a per-kind cooldown that's too aggressive would
  // coalesce legitimate independent alerts. Still tight enough to defang a
  // buggy plugin emitting 30 events/sec from blasting toasts.
  plugin: 5_000,
};

/**
 * Strip ASCII control chars (C0: 0x00–0x1F, DEL: 0x7F, C1: 0x80–0x9F) which
 * are common in LLM / user-supplied bodies (newlines from prompts, ANSI escape
 * sequences from terminal-style output, etc). Windows toast XML and Linux
 * notify-send both mis-render or split on these. C1 range (0x80–0x9F) can
 * also surprise Windows toast XML. Defense-in-depth: applied to title too,
 * since the routine kind interpolates user/admin data.
 */
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f-\x9f]/g;
function stripControlChars(s: string): string {
  return s.replace(CONTROL_CHARS_RE, "");
}

export interface ToastPayload {
  kind: NotificationKind;
  title: string;
  body: string;
  contextRef?: NotificationContextRef;
}

/**
 * Minimal Electron Notification surface used by the service. Exposed as an
 * injectable factory so tests can stub it without spinning Electron.
 */
export interface NotificationLike {
  show(): void;
  on(event: "click", handler: () => void): void;
}

export interface NotificationServiceOptions {
  /** Live BrowserWindow getter. Service tolerates null (e.g. window closed). */
  getMainWindow: () => BrowserWindow | null;
  auditLogger?: AuditLogger;
  /**
   * Test injection — by default the service uses Electron's Notification
   * constructor and `app.isReady()`. Tests pass stubs to avoid loading
   * Electron at all.
   */
  notificationFactory?: (opts: {
    title: string;
    body: string;
    silent: boolean;
    urgency: "normal" | "critical" | "low";
  }) => NotificationLike;
  isReady?: () => boolean;
  /**
   * Test override of NODE_ENV check. Default: read process.env.NODE_ENV.
   */
  isTestEnv?: () => boolean;
  /**
   * #842 — focus detection across ALL LVIS-owned BrowserWindows (settings,
   * auth-window, link-window, auth-partition-viewer, detached children).
   * The pre-fix gate only consulted `mainWindow.isFocused()`, so an active
   * settings window would still trigger an OS pop. Defaults to a live
   * `BrowserWindow.getAllWindows().some(w => !w.isDestroyed() && w.isFocused())`
   * scan; tests override to avoid loading Electron.
   */
  isAnyWindowFocused?: () => boolean;
}

/**
 * Strip control chars then UTF-16 surrogate-safely cap at BODY_MAX_CHARS.
 * Using `[...str]` decomposes the string into code-point units so a 4-byte
 * emoji at position 80 doesn't get sliced into a lone surrogate.
 */
function truncateBody(body: string): string {
  const clean = stripControlChars(body);
  const codepoints = [...clean];
  if (codepoints.length <= BODY_MAX_CHARS) return clean;
  return codepoints.slice(0, BODY_MAX_CHARS).join("") + ELLIPSIS;
}

/**
 * Cap title to BODY_MAX_CHARS with the same surrogate-safe slicing as body.
 * No ellipsis appended — title slicing is for audit-output bounding only.
 */
function capTitle(title: string): string {
  const clean = stripControlChars(title);
  const codepoints = [...clean];
  if (codepoints.length <= BODY_MAX_CHARS) return clean;
  return codepoints.slice(0, BODY_MAX_CHARS).join("");
}

function defaultIsTestEnv(): boolean {
  return process.env.NODE_ENV === "test";
}

/**
 * Default notification factory — uses Electron's native Notification. Imported
 * lazily inside the function so unit tests that mock the module surface aren't
 * forced to load Electron at module-load time.
 */
function defaultNotificationFactory(opts: {
  title: string;
  body: string;
  silent: boolean;
  urgency: "normal" | "critical" | "low";
}): NotificationLike {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Notification } = require("electron") as typeof import("electron");
  const n = new Notification({
    title: opts.title,
    body: opts.body,
    silent: opts.silent,
    urgency: opts.urgency,
  });
  return {
    show: () => n.show(),
    on: (event, handler) => n.on(event, handler),
  };
}

function defaultIsReady(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require("electron") as typeof import("electron");
    return app.isReady();
  } catch {
    return false;
  }
}

/**
 * #842 — default multi-window focus probe. Scans every LVIS-owned
 * `BrowserWindow` (main + settings + auth + link + detached children) so
 * "user is actively working in some LVIS window" is detected even when
 * the main window is blurred. `isDestroyed()` filtered out to avoid
 * touching a window that's already being torn down. Wrapped in try/catch
 * so callers without Electron loaded (tests) fall back to "no focus".
 */
function defaultIsAnyWindowFocused(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { BrowserWindow } = require("electron") as typeof import("electron");
    return BrowserWindow.getAllWindows().some(
      (w) => !w.isDestroyed() && w.isFocused(),
    );
  } catch (err) {
    // Electron not loaded (e.g. unit tests) — log at warn so a *runtime*
    // import failure (broken Electron upgrade, missing native binding) does
    // not silently degrade to "always treat user as away". Tests pass via
    // the `isAnyWindowFocused` constructor option so the catch is rarely
    // hit outside true config errors.
    log.warn("defaultIsAnyWindowFocused fallback: %s", (err as Error).message);
    return false;
  }
}

export class NotificationService {
  private readonly getMainWindow: () => BrowserWindow | null;
  private readonly auditLogger?: AuditLogger;
  private readonly notificationFactory: NonNullable<NotificationServiceOptions["notificationFactory"]>;
  private readonly isReady: () => boolean;
  private readonly isTestEnv: () => boolean;
  private readonly isAnyWindowFocused: () => boolean;
  /**
   * Per-kind last-fire monotonic timestamps (performance.now() ms). Using a
   * monotonic clock (immune to NTP steps and manual clock changes) means a
   * wall-clock jump backwards never produces a negative elapsedMs that would
   * suppress all subsequent fires until real time "catches up". The audit
   * `timestamp` field keeps Date.now() because it records wall-clock event time.
   */
  private readonly lastFiredAt = new Map<NotificationKind, number>();

  constructor(opts: NotificationServiceOptions) {
    this.getMainWindow = opts.getMainWindow;
    this.auditLogger = opts.auditLogger;
    this.notificationFactory = opts.notificationFactory ?? defaultNotificationFactory;
    this.isReady = opts.isReady ?? defaultIsReady;
    this.isTestEnv = opts.isTestEnv ?? defaultIsTestEnv;
    this.isAnyWindowFocused = opts.isAnyWindowFocused ?? defaultIsAnyWindowFocused;
  }

  fire(opts: FireOptions): void {
    // Test-mode + pre-ready hard guard — never pop a notification before the
    // app is ready or inside a vitest run.
    if (this.isTestEnv() || !this.isReady()) return;

    // Per-kind cooldown — defense against runaway turn loops or approval
    // bursts. Suppressed events MUST still go through the audit logger so we
    // can detect spam in field telemetry. routine and ask-user have a 0 ms
    // cooldown (always fire).
    //
    // #843 — `bypassFocusGate` is an opt-in *manifest* signal that the event
    // is a critical alert (e.g. meeting.starting-soon). It must escape BOTH
    // the focus gate AND the per-kind cooldown — otherwise a plugin emitting
    // routine notifications in the prior 5s window would silently suppress
    // an unrelated critical alert that the manifest explicitly marked as
    // "must be delivered". The cooldown still updates `lastFiredAt` so that
    // the *next* non-bypass fire is correctly throttled relative to this
    // bypass event (i.e. bypass consumes the slot, it does not pretend the
    // fire never happened).
    //
    // Timing: performance.now() is monotonic (immune to NTP steps / manual
    // wall-clock changes). A Date.now() backwards jump would produce a
    // negative elapsedMs that trivially passes `< cooldownMs`, suppressing
    // every subsequent fire until real time "catches up". Monotonic timing
    // avoids that. The audit `timestamp` field keeps Date.now() intentionally
    // because it records wall-clock event time for human-readable log entries.
    const cooldownMs = COOLDOWN_MS_BY_KIND[opts.kind] ?? 0;
    if (cooldownMs > 0) {
      const last = this.lastFiredAt.get(opts.kind) ?? 0;
      const now = performance.now();
      const elapsedMs = now - last;
      if (last !== 0 && elapsedMs < cooldownMs && opts.bypassFocusGate !== true) {
        this.auditSuppressed(opts.kind, elapsedMs);
        return;
      }
      this.lastFiredAt.set(opts.kind, now);
    }

    // Sanitize title and body — strip control chars defense-in-depth (body
    // sources include LLM responses and user-typed questions; routine titles
    // interpolate user-authored routine IDs).
    //
    // Two body variants: the toast goes through the React renderer (markdown
    // OK), but OS-native notifications on macOS/Windows/Linux treat `body`
    // as plain text, so markdown leaks to the user as literal `**bold**` etc.
    // Strip before truncating so the 80-char cap reflects what the user sees.
    const cleanTitle = capTitle(opts.title);
    const truncatedBody = truncateBody(opts.body);
    const truncatedPlainBody = truncateBody(stripMarkdown(opts.body));
    // #843 — `bypassFocusGate` is a manifest signal that the event is
    // critical enough to escape the focus + cooldown gates. A silent (non-
    // urgent) OS notification on top of that is contradictory: the user
    // would see a quiet popup for an alert the plugin author flagged as
    // "must reach the user even with another window focused". Promote
    // `urgent` to `true` automatically when `bypassFocusGate` is set,
    // unless the caller has explicitly opted out by passing `urgent: false`.
    const urgent =
      opts.urgent ??
      (opts.kind === "approval" || opts.bypassFocusGate === true);

    // #842 — focus gate consults EVERY LVIS-owned window. The pre-fix path
    // checked `win.isFocused()` only, missing detached/aux windows (settings,
    // auth, link). #843 — `bypassFocusGate` forces the OS path regardless of
    // any focused window (critical surfaces like meeting.starting-soon).
    //
    // `mainAlive` semantics: "the main window is in a state where it can
    // *receive* an in-app toast". A minimized main is treated as not-alive
    // because the user can't see the in-app toast — we want the OS path
    // instead. A destroyed main (mid-teardown) is also not-alive.
    const win = this.getMainWindow();
    const mainAlive = win !== null && !win.isDestroyed() && !win.isMinimized();
    const anyFocused = this.isAnyWindowFocused();
    const focusGateActive = !opts.bypassFocusGate && mainAlive && anyFocused;
    const gate: "os" | "in-app" = focusGateActive ? "in-app" : "os";

    if (focusGateActive && win) {
      const payload: ToastPayload = {
        kind: opts.kind,
        title: cleanTitle,
        body: truncatedBody,
        contextRef: opts.contextRef,
      };
      try {
        win.webContents.send(IPC_NOTIFICATION_TOAST, payload);
      } catch (err) {
        // Send race (webContents destroyed mid-fire) — fall back to OS path
        // so the user still sees the cue. Audit reflects the final gate used.
        log.warn(
          "notification toast send failed, falling back to OS: %s",
          (err as Error).message,
        );
        this.fireOsNotification(opts, cleanTitle, truncatedPlainBody, urgent);
        this.audit("os", opts.kind, cleanTitle);
        return;
      }
    } else {
      this.fireOsNotification(opts, cleanTitle, truncatedPlainBody, urgent);
    }

    this.audit(gate, opts.kind, cleanTitle);
  }

  private fireOsNotification(opts: FireOptions, title: string, body: string, urgent: boolean): void {
    try {
      const n = this.notificationFactory({
        title,
        body,
        silent: !urgent,
        // urgency is Linux-only per Electron docs; on Windows/macOS, the
        // silent flag drives sound. Kept set for cross-platform parity.
        urgency: urgent ? "critical" : "normal",
      });
      n.on("click", () => {
        const win = this.getMainWindow();
        if (!win || win.isDestroyed()) return;
        try {
          if (win.isMinimized()) win.restore();
          win.show();
          win.focus();
          win.webContents.send(IPC_NOTIFICATION_CLICKED, {
            kind: opts.kind,
            contextRef: opts.contextRef,
          });
        } catch (err) {
          log.warn(
            "notification click handler failed: %s",
            (err as Error).message,
          );
        }
      });
      n.show();
    } catch (err) {
      // OS notification can fail on Linux without libnotify, on Windows
      // without AppUserModelId, etc. Never let a failed notification block
      // the lifecycle event that fired it.
      log.warn(
        "OS notification fire failed: %s",
        (err as Error).message,
      );
    }
  }

  private audit(gate: "os" | "in-app", kind: NotificationKind, title: string): void {
    if (!this.auditLogger) return;
    try {
      this.auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: "notification-service",
        type: "info",
        // body is intentionally NOT logged — body may contain user-typed
        // question text or assistant response (PII). Title is already bounded
        // by capTitle() at the entry point — the slice here is a belt-and-
        // suspenders cap on whatever raw text the caller might pass through
        // a future code path.
        input: JSON.stringify({
          event: "notification.fired",
          kind,
          gate,
          // reuses body cap as title cap — same 80-char limit applies to
          // audit fields.
          title: title.slice(0, BODY_MAX_CHARS),
        }),
      });
    } catch {
      // audit failure must never block the app
    }
  }

  /**
   * Audit a cooldown-suppressed fire. Must NEVER silently drop — a missing
   * audit trail hides runaway-loop bugs.
   */
  private auditSuppressed(kind: NotificationKind, elapsedMs: number): void {
    if (!this.auditLogger) return;
    try {
      this.auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: "notification-service",
        type: "info",
        input: JSON.stringify({
          event: "notification.suppressed",
          kind,
          reason: "cooldown",
          elapsedMs,
        }),
      });
    } catch {
      // audit failure must never block the app
    }
  }
}

export const __test = {
  truncateBody,
  capTitle,
  stripControlChars,
  BODY_MAX_CHARS,
  COOLDOWN_MS_BY_KIND,
};
