// Managed bootstrap status banner.
//
// Renders one of three states based on the IPC event from the host:

//   - complete with failed[] → red banner listing failures, dismissable

//   - error    → red banner with the host-supplied message
//   - complete clean → silent (return null) — most users see nothing
//
// The renderer hook supplies `status` + `dismiss`. Banner does not auto-
// dismiss; the user closes it (success state never renders, so there's
// nothing to auto-clear).

import { Button } from "../../../components/ui/button.js";
import { useTranslation } from "../../../i18n/react.js";
import type { BootstrapStatusEvent } from "../hooks/use-bootstrap-status.js";

interface Props {
  status: BootstrapStatusEvent | null;
  onDismiss: () => void;
  onRetry: () => void;
}

export function BootstrapStatusBanner({ status, onDismiss, onRetry }: Props): React.ReactElement | null {
  const { t } = useTranslation();
  if (!status) return null;

  if (status.phase === "start") {
    return (
      <div className="flex items-center justify-between gap-2 bg-popover border border-border text-muted-foreground text-sm px-4 py-2 rounded-md mx-2 mt-2 shadow-lg lvis-anim-slide-down">
        <span>{t("bootstrapStatusBanner.installing")}</span>
      </div>
    );
  }

  if (status.phase === "error") {
    return (
      <div className="flex items-center justify-between gap-2 bg-popover border border-destructive/(--opacity-medium) text-destructive text-sm px-4 py-2 rounded-md mx-2 mt-2 shadow-lg lvis-anim-slide-down">
        <span>{t("bootstrapStatusBanner.bootstrapError", { message: status.message })}</span>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            onClick={onRetry}
            className="h-auto px-2 py-0.5 text-xs text-destructive border-destructive/(--opacity-medium) hover:bg-destructive/(--opacity-soft)"
          >
            {t("bootstrapStatusBanner.retry")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onDismiss}
            aria-label={t("bootstrapStatusBanner.dismissNotification")}
            className="text-destructive hover:text-destructive/(--opacity-intense) h-auto p-1"
          >
            ✕
          </Button>
        </div>
      </div>
    );
  }

  // phase === "complete"
  if (status.skippedReason) {
    return (
      <div className="flex items-center justify-between gap-2 bg-popover border border-warning/(--opacity-medium) text-warning text-sm px-4 py-2 rounded-md mx-2 mt-2 shadow-lg lvis-anim-slide-down">
        <span>{t("bootstrapStatusBanner.skipped", { skippedReason: status.skippedReason })}</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={onDismiss}
          aria-label={t("bootstrapStatusBanner.dismissNotification")}
          className="text-warning hover:text-warning/(--opacity-intense) h-auto p-1"
        >
          ✕
        </Button>
      </div>
    );
  }

  if (status.failed.length > 0) {
    // Truncate long error strings (e.g. multi-line stack traces from
    // tarball failures) so the banner stays single-line on narrow screens.
    const truncate = (s: string, max = 120): string =>
      s.length > max ? `${s.slice(0, max - 1)}…` : s;
    const summary =
      status.failed.length === 1
        ? t("bootstrapStatusBanner.singlePluginFailed", { id: status.failed[0].id, error: truncate(status.failed[0].error) })
        : t("bootstrapStatusBanner.multiplePluginsFailed", { count: status.failed.length });
    return (
      <div className="flex items-center justify-between gap-2 bg-popover border border-destructive/(--opacity-medium) text-destructive text-sm px-4 py-2 rounded-md mx-2 mt-2 shadow-lg lvis-anim-slide-down">
        <span>{summary}</span>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            onClick={onRetry}
            className="h-auto px-2 py-0.5 text-xs text-destructive border-destructive/(--opacity-medium) hover:bg-destructive/(--opacity-soft)"
          >
            {t("bootstrapStatusBanner.retry")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onDismiss}
            aria-label={t("bootstrapStatusBanner.dismissNotification")}
            className="text-destructive hover:text-destructive/(--opacity-intense) h-auto p-1"
          >
            ✕
          </Button>
        </div>
      </div>
    );
  }

  // complete + nothing failed + not skipped → silent.
  return null;
}
