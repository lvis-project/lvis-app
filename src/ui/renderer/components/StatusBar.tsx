import type { PersistentItem, StatusBarSeverity, ToastItem } from "../hooks/use-status-bar.js";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../../components/ui/tooltip.js";
import { X } from "lucide-react";
import { t } from "../../../i18n/runtime.js";
import { MarqueeText } from "./MarqueeText.js";

const EMOJI_FONT_STACK =
  "'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', 'Twemoji Mozilla', sans-serif";
const EMOJI_STYLE = { fontFamily: EMOJI_FONT_STACK };

/**
 * Composer-adjacent status/toast surface.
 *
 * Component is intentionally presentational — all state and producer
 * wiring lives in `useStatusBar`. In chat it is rendered directly above the
 * composer so transient failures stay near the user's current input focus.
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
  onToastDismiss?: (toast: ToastItem) => void;
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

const TOAST_TONE: Record<StatusBarSeverity, string> = {
  info: "border-info/(--opacity-medium) bg-info/(--opacity-faint) text-foreground",
  success: "border-success/(--opacity-medium) bg-success/(--opacity-faint) text-success",
  warning: "border-warning/(--opacity-medium) bg-warning/(--opacity-faint) text-warning",
  error: "border-destructive/(--opacity-medium) bg-destructive/(--opacity-faint) text-destructive",
};

export function StatusBar(props: StatusBarProps) {
  const { persistent, visibleToast, pendingCount = 0, onToastClick, onToastDismiss } = props;

  // Render nothing when there is no persistent indicator and no toast, so the
  // composer dock does not reserve empty vertical space.
  if ((!persistent || persistent.length === 0) && !visibleToast) return null;

  return (
    <TooltipProvider>
    <footer
      className="flex w-full min-w-0 items-center gap-3 text-[11px] text-muted-foreground"
      data-testid="status-bar"
      role="status"
      aria-live="polite"
    >
      {persistent.length > 0 ? (
        <div className="flex min-w-0 items-center truncate">
          {persistent.map((item, idx) => {
            const previous = idx > 0 ? persistent[idx - 1] : undefined;
            const joinWithPrevious =
              previous?.id === "health:services" && item.id === "vendor:llm";
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
                    data-status-bar-emoji="true"
                    style={EMOJI_STYLE}
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
            const trigger = item.onClick !== undefined ? (
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
            );
            return (
              <span
                key={item.id}
                className={`flex min-w-0 items-center truncate ${joinWithPrevious ? "ml-1.5" : ""}`}
              >
                {idx > 0 && !joinWithPrevious && (
                  <span className="px-2 opacity-30" aria-hidden="true">|</span>
                )}
                {item.tooltip !== undefined && item.tooltip.length > 0 ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      {trigger}
                    </TooltipTrigger>
                    <TooltipContent side="top" className="whitespace-pre-line text-left">
                      {item.tooltip}
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  trigger
                )}
              </span>
            );
          })}
        </div>
      ) : null}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {visibleToast !== null && (() => {
          const toast = visibleToast;
          const clickable = toast.notification !== undefined && typeof onToastClick === "function";
          const dismissible = typeof onToastDismiss === "function";
          const baseClass =
            `flex min-w-0 w-full items-start gap-2 overflow-hidden rounded-t-xl rounded-b-md border px-3 pb-6 pt-2.5 text-[13px] lvis-anim-slide-up ${TOAST_TONE[toast.severity]}`;
          const dot = (
            <span
              className={`mt-1 h-2 w-2 shrink-0 rounded-full ${SEVERITY_DOT[toast.severity]}`}
              aria-hidden="true"
            />
          );
          const pendingBadge = pendingCount > 0 ? (
            <span className="shrink-0 rounded-full border border-border bg-background/(--opacity-stronger) px-1.5 py-0.5 text-[11px] text-muted-foreground tabular-nums">+{pendingCount}</span>
          ) : null;
          const dismissButton = dismissible ? (
            <button
              type="button"
              onClick={() => onToastDismiss?.(toast)}
              className="mt-[-0.125rem] inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              aria-label={t("statusBar.toastDismissAriaLabel")}
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          ) : null;
          if (clickable) {
            return (
              <div key={toast.id} className={baseClass}>
                {dot}
                <MarqueeText
                  text={toast.message}
                  className="flex-1 text-left"
                  data-testid="status-toast-message"
                />
                <button
                  type="button"
                  onClick={() => onToastClick?.(toast)}
                  className="shrink-0 text-[12px] font-medium text-foreground underline underline-offset-4 hover:text-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  {t("statusBar.toastDetailsAction")}
                </button>
                {dismissButton}
                {pendingBadge}
              </div>
            );
          }
          return (
            <div key={toast.id} className={baseClass}>
              {dot}
              <MarqueeText
                text={toast.message}
                className="flex-1 text-left"
                data-testid="status-toast-message"
              />
              {dismissButton}
              {pendingBadge}
            </div>
          );
        })()}
      </div>
    </footer>
    </TooltipProvider>
  );
}
