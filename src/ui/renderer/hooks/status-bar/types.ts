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
  /**
   * Short label (left of dot) — e.g. "다음 루틴", or an emoji glyph. Optional
   * when `dot` is true: dot-only producers (마켓플레이스 online ping) omit
   * both `label` and `value` so the status bar shows nothing but the colored
   * dot + tooltip.
   */
  label?: string;
  /** Variable value (right of dot) — e.g. "04:42 KST". */
  value?: string;
  /**
   * When true the StatusBar renders this item as a small colored circle only
   * (severity → background class). `label` / `value` are ignored. Used by
   * binary indicators like marketplace online/offline where the dot itself
   * is the entire visual payload and the meaning lives in the `tooltip`.
   */
  dot?: boolean;
  /**
   * Screen-reader text. When `label` is an emoji glyph the SR would read its
   * Unicode name ("wrench") which loses semantic meaning; producers supply a
   * Korean phrase here (예: "도구 개수") that the StatusBar exposes via an
   * sr-only span while the emoji span is `aria-hidden`. Optional — text
   * labels can omit this and rely on `label` being read directly.
   */
  a11yLabel?: string;
  /**
   * Optional click handler. When set, the StatusBar renders this item as a
   * button (focus-visible ring + hover affordance) so users can navigate to a
   * related Settings tab. Producers like vendor/model use this to open
   * Settings → LLM. Items without onClick render as a plain span.
   */
  onClick?: () => void;
  /**
   * Optional title text shown on hover. Useful when `value` is abbreviated
   * (e.g. truncated model name) and the full string improves discoverability.
   */
  tooltip?: string;
}

export interface ToastItem {
  id: string;
  severity: StatusBarSeverity;
  message: string;
  /** Duration this toast should stay visible after it reaches the queue head. */
  ttlMs?: number;
  /** Wall-clock ms when the current queue-head toast should auto-evict. */
  expiresAt: number;
  /**
   * Issue #260 — when present, identifies this toast as a notification
   * toast. The StatusBar renders an onClick that calls `notifyClick` and
   * dismisses the toast. Producer toasts (install progress) omit this.
   */
  notification?: NotificationToastMeta;
}
