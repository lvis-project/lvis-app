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

export type NotificationKind = "turn-end" | "routine" | "ask-user" | "approval";

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

const BODY_MAX_CHARS = 80;
const ELLIPSIS = "…";

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
}

function truncateBody(body: string): string {
  if (body.length <= BODY_MAX_CHARS) return body;
  return body.slice(0, BODY_MAX_CHARS) + ELLIPSIS;
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

export class NotificationService {
  private readonly getMainWindow: () => BrowserWindow | null;
  private readonly auditLogger?: AuditLogger;
  private readonly notificationFactory: NonNullable<NotificationServiceOptions["notificationFactory"]>;
  private readonly isReady: () => boolean;
  private readonly isTestEnv: () => boolean;

  constructor(opts: NotificationServiceOptions) {
    this.getMainWindow = opts.getMainWindow;
    this.auditLogger = opts.auditLogger;
    this.notificationFactory = opts.notificationFactory ?? defaultNotificationFactory;
    this.isReady = opts.isReady ?? defaultIsReady;
    this.isTestEnv = opts.isTestEnv ?? defaultIsTestEnv;
  }

  fire(opts: FireOptions): void {
    // Test-mode + pre-ready hard guard — never pop a notification before the
    // app is ready or inside a vitest run.
    if (this.isTestEnv() || !this.isReady()) return;

    const truncatedBody = truncateBody(opts.body);
    const urgent = opts.urgent ?? (opts.kind === "approval");

    const win = this.getMainWindow();
    const winFocused =
      win !== null && !win.isDestroyed() && win.isFocused() && !win.isMinimized();
    const gate: "os" | "in-app" = winFocused ? "in-app" : "os";

    if (winFocused && win) {
      const payload: ToastPayload = {
        kind: opts.kind,
        title: opts.title,
        body: truncatedBody,
        contextRef: opts.contextRef,
      };
      try {
        win.webContents.send(IPC_NOTIFICATION_TOAST, payload);
      } catch (err) {
        // Send race (webContents destroyed mid-fire) — fall back to OS path
        // so the user still sees the cue. Audit reflects the final gate used.
        console.warn(
          "[lvis] notification toast send failed, falling back to OS:",
          (err as Error).message,
        );
        this.fireOsNotification(opts, truncatedBody, urgent);
        this.audit("os", opts.kind, opts.title);
        return;
      }
    } else {
      this.fireOsNotification(opts, truncatedBody, urgent);
    }

    this.audit(gate, opts.kind, opts.title);
  }

  private fireOsNotification(opts: FireOptions, body: string, urgent: boolean): void {
    try {
      const n = this.notificationFactory({
        title: opts.title,
        body,
        silent: !urgent,
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
          console.warn(
            "[lvis] notification click handler failed:",
            (err as Error).message,
          );
        }
      });
      n.show();
    } catch (err) {
      // OS notification can fail on Linux without libnotify, on Windows
      // without AppUserModelId, etc. Never let a failed notification block
      // the lifecycle event that fired it.
      console.warn(
        "[lvis] OS notification fire failed:",
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
        // question text or assistant response (PII). Title is bounded.
        input: JSON.stringify({
          event: "notification.fired",
          kind,
          gate,
          title: title.slice(0, BODY_MAX_CHARS),
        }),
      });
    } catch {
      // audit failure must never block the app
    }
  }
}

export const __test = {
  truncateBody,
  BODY_MAX_CHARS,
};
