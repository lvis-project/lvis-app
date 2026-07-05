




import { useTranslation } from "../../../i18n/react.js";

export interface ViewModeState {
  compactNum: number;
  /**
   * Exclusive slice end — use as `messages.slice(0, slicedRangeEnd)`.
   * Equal to `messageCountAtTrigger` stored in the checkpoint metadata.
   */
  slicedRangeEnd: number;
}

export function ViewModeBanner({
  viewMode,
  onExit,
}: {
  viewMode: ViewModeState | null;
  onExit: () => void;
}) {
  const { t } = useTranslation();

  if (!viewMode) return null;

  return (
    <div
      data-testid="view-mode-banner"
      className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-[hsl(var(--action-view)/0.3)] bg-[hsl(var(--action-view)/0.08)] px-4 py-2 backdrop-blur-[10px]"
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <span
          data-testid="view-mode-banner-title"
          className="text-[12px] font-semibold text-[hsl(var(--action-view))]"
        >
          {t("viewModeBanner.title", { compactNum: viewMode.compactNum })}
        </span>
        <span className="text-[10px] text-muted-foreground">
          {t("viewModeBanner.messageRange", { slicedRangeEnd: viewMode.slicedRangeEnd })}
        </span>
      </div>
      <button
        type="button"
        data-testid="view-mode-exit-btn"
        onClick={onExit}
        className="shrink-0 rounded-md border border-[hsl(var(--action-view)/0.4)] bg-[hsl(var(--action-view)/0.12)] px-3 py-1.5 text-[11px] font-medium text-[hsl(var(--action-view))] transition-colors hover:bg-[hsl(var(--action-view)/0.2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--action-view)/0.5)]"
        aria-label={t("viewModeBanner.exitAriaLabel")}
      >
        {t("viewModeBanner.exitButton")}
      </button>
    </div>
  );
}
