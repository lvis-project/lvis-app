export type StatusBarSeverity = "info" | "success" | "warning" | "error";

/**
 * Notification toast metadata — present on toasts that originate from the
 * notification system (#260). Producer-style toasts (install progress, etc.)
 * leave this undefined; clicking them is a no-op. The discriminator-style
 * field lets the StatusBar render a click handler for notification toasts
 * only without coupling the component to every producer.
 */
export interface NotificationToastMeta {
  kind: "turn-end" | "routine" | "ask-user" | "approval";
  contextRef?: {
    sessionId?: string;
    routineId?: string;
    questionId?: string;
    approvalId?: string;
  };
}

export interface PersistentItem {
  id: string;
  severity: StatusBarSeverity;
  /** Short label (left of dot) — e.g. "다음 루틴". */
  label: string;
  /** Variable value (right of dot) — e.g. "04:42 KST". */
  value: string;
}

export interface ToastItem {
  id: string;
  severity: StatusBarSeverity;
  message: string;
  /** Wall-clock ms when this toast should auto-evict. */
  expiresAt: number;
  /**
   * Issue #260 — when present, identifies this toast as a notification
   * toast. The StatusBar renders an onClick that calls `notifyClick` and
   * dismisses the toast. Producer toasts (install progress) omit this.
   */
  notification?: NotificationToastMeta;
}
