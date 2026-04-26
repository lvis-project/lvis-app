import type { PersistentItem, StatusBarSeverity, ToastItem } from "../hooks/use-status-bar.js";

/**
 * Bottom status bar (#231). Two slots:
 *   - left: persistent items (next routine, online/offline, …)
 *   - right: transient toasts (install progress, lifecycle results, …)
 *
 * Component is intentionally presentational — all state and producer
 * wiring lives in `useStatusBar`. Keep it under ~24px of vertical space
 * to match iTerm / VS Code / Windows Terminal proportions.
 */
export interface StatusBarProps {
  persistent: PersistentItem[];
  toasts: ToastItem[];
}

const SEVERITY_DOT: Record<StatusBarSeverity, string> = {
  info: "bg-blue-400",
  success: "bg-green-500",
  warning: "bg-amber-400",
  error: "bg-red-500",
};

const SEVERITY_TEXT: Record<StatusBarSeverity, string> = {
  info: "text-muted-foreground",
  success: "text-green-700 dark:text-green-300",
  warning: "text-amber-700 dark:text-amber-300",
  error: "text-red-700 dark:text-red-300",
};

export function StatusBar(props: StatusBarProps) {
  const { persistent, toasts } = props;

  return (
    <footer
      className="flex h-6 shrink-0 items-center justify-between gap-3 border-t bg-background px-3 text-[11px] text-muted-foreground"
      role="status"
      aria-live="polite"
    >
      <div className="flex min-w-0 items-center gap-3 truncate">
        {persistent.length === 0 ? (
          <span className="opacity-50">LVIS</span>
        ) : (
          persistent.map((item) => (
            <span key={item.id} className="flex min-w-0 items-center gap-1.5 truncate">
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${SEVERITY_DOT[item.severity]}`}
                aria-hidden="true"
              />
              <span className="truncate">
                <span className="opacity-70">{item.label}</span>
                <span className="px-1 opacity-40">·</span>
                <span>{item.value}</span>
              </span>
            </span>
          ))
        )}
      </div>
      <div className="flex min-w-0 items-center gap-3 truncate">
        {toasts.slice(-3).map((toast) => (
          <span
            key={toast.id}
            className={`flex min-w-0 items-center gap-1.5 truncate ${SEVERITY_TEXT[toast.severity]}`}
          >
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${SEVERITY_DOT[toast.severity]}`}
              aria-hidden="true"
            />
            <span className="truncate">{toast.message}</span>
          </span>
        ))}
      </div>
    </footer>
  );
}
