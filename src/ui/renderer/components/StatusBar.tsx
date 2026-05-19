import type { PersistentItem, StatusBarSeverity, ToastItem } from "../hooks/use-status-bar.js";
import { LvisLogo } from "./LvisLogo.js";

const EMOJI_FONT_STACK =
  "'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', 'Twemoji Mozilla', sans-serif";

/**
 * Bottom status bar (#231). Two slots:
 *   - left: persistent items (next routine, online/offline, …)
 *   - right: transient toasts (install progress, lifecycle results, …)
 *
 * Component is intentionally presentational — all state and producer
 * wiring lives in `useStatusBar`. Keep it under ~24px of vertical space
 * to match iTerm / VS Code / Windows Terminal proportions.
 *
 * Issue #260 — toasts originating from the notification system carry a
 * `notification` meta. When provided, `onToastClick` fires on click; the
 * caller (App.tsx) wires this to `notifyClick` IPC and `removeToast`. Other
 * toast producers (install progress, lifecycle results) leave the meta
 * undefined and their toasts remain non-clickable cosmetic spans.
 *
 * Sequential toast display: only `visibleToast` (the queue head) is rendered
 * at any time. `pendingCount` shows how many more are waiting.
 */
export interface StatusBarProps {
  persistent: PersistentItem[];
  /** The single toast currently at the front of the queue (or null). */
  visibleToast: ToastItem | null;
  /** Number of toasts queued behind the visible one. */
  pendingCount?: number;
  /**
   * Click handler invoked when a toast that has `notification` metadata is
   * clicked. The handler receives the full ToastItem so callers can dispatch
   * the IPC call and dismiss the toast in a single pass.
   */
  onToastClick?: (toast: ToastItem) => void;
}

const SEVERITY_DOT: Record<StatusBarSeverity, string> = {
  info: "bg-info",
  success: "bg-success",
  warning: "bg-warning",
  error: "bg-destructive",
};

const SEVERITY_TEXT: Record<StatusBarSeverity, string> = {
  info: "text-muted-foreground",
  success: "text-success",
  warning: "text-warning",
  error: "text-destructive",
};

export function StatusBar(props: StatusBarProps) {
  const { persistent, visibleToast, pendingCount = 0, onToastClick } = props;

  return (
    <footer
      className="flex h-6 shrink-0 items-center justify-between gap-3 border-t bg-background px-3 text-[11px] text-muted-foreground"
      data-testid="status-bar"
      role="status"
      aria-live="polite"
    >
      <div className="flex min-w-0 items-center truncate">
        {persistent.length === 0 ? (
          <span className="flex items-center gap-1.5 opacity-60">
            <LvisLogo className="h-3.5 w-3.5 shrink-0" decorative />
            <span>LVIS</span>
          </span>
        ) : (
          persistent.map((item, idx) => {
            const inner = item.dot === true ? (
              <>
                {item.a11yLabel !== undefined && (
                  <span className="sr-only">{item.a11yLabel}</span>
                )}
                <span
                  data-testid={`status-bar-dot-${item.id}`}
                  className={`h-2 w-2 shrink-0 rounded-full ${SEVERITY_DOT[item.severity]}`}
                  aria-hidden="true"
                />
              </>
            ) : (
              <>
                {item.a11yLabel !== undefined && (
                  <span className="sr-only">{item.a11yLabel}</span>
                )}
                {item.label !== undefined && item.label.length > 0 && (
                  <span
                    style={{ fontFamily: EMOJI_FONT_STACK }}
                    className="shrink-0 leading-none"
                    aria-hidden="true"
                  >
                    {item.label}
                  </span>
                )}
                {item.value !== undefined && item.value.length > 0 && (
                  <span className={`truncate tabular-nums ${SEVERITY_TEXT[item.severity]}`}>
                    {item.value}
                  </span>
                )}
              </>
            );
            // Z onboarding chain — the vendor/model cell is the final
            // SpotlightTour anchor (step 7). Tagging it here keeps the
            // anchor close to the rendered DOM rather than requiring a
            // separate wrapper component.
            const tourAnchor =
              item.id === "vendor:llm" ? "status-bar-vendor" : undefined;
            return (
              <span key={item.id} className="flex min-w-0 items-center truncate">
                {idx > 0 && (
                  <span className="px-2 opacity-30" aria-hidden="true">|</span>
                )}
                {item.onClick !== undefined ? (
                  <button
                    type="button"
                    onClick={item.onClick}
                    title={item.tooltip}
                    data-tour-anchor={tourAnchor}
                    className="flex items-center gap-1 truncate cursor-pointer hover:opacity-80 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    {inner}
                  </button>
                ) : (
                  <span
                    className="flex items-center gap-1 truncate"
                    title={item.tooltip}
                    data-tour-anchor={tourAnchor}
                  >
                    {inner}
                  </span>
                )}
              </span>
            );
          })
        )}
      </div>
      <div className="flex min-w-0 items-center gap-2 truncate">
        {visibleToast !== null && (() => {
          const toast = visibleToast;
          const clickable = toast.notification !== undefined && typeof onToastClick === "function";
          const baseClass = `flex min-w-0 items-center gap-1.5 truncate lvis-anim-slide-up ${SEVERITY_TEXT[toast.severity]}`;
          const dot = (
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${SEVERITY_DOT[toast.severity]}`}
              aria-hidden="true"
            />
          );
          const pendingBadge = pendingCount > 0 ? (
            <span className="shrink-0 opacity-50 tabular-nums">+{pendingCount}</span>
          ) : null;
          if (clickable) {
            return (
              <>
                <button
                  key={toast.id}
                  type="button"
                  onClick={() => onToastClick?.(toast)}
                  className={`${baseClass} cursor-pointer hover:opacity-80 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring`}
                >
                  {dot}
                  <span className="truncate">{toast.message}</span>
                </button>
                {pendingBadge}
              </>
            );
          }
          return (
            <>
              <span key={toast.id} className={baseClass}>
                {dot}
                <span className="truncate">{toast.message}</span>
              </span>
              {pendingBadge}
            </>
          );
        })()}
      </div>
    </footer>
  );
}
