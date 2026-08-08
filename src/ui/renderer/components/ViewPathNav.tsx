import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";
import { useTranslation } from "../../../i18n/react.js";
import type { BreadcrumbSegment, ViewLocation } from "../utils/view-location.js";

/**
 * Back / forward plus the path to where the main window is.
 *
 * Lives at the LEADING edge of the top band, which is also the window's drag
 * region: every control here has to opt out of dragging, so each one costs
 * grab area. The path is therefore width-capped and truncates rather than
 * growing — see `MainToolbar`, which owns the cap and the remaining spacer.
 *
 * Styling is the band's existing icon-button recipe (`ghost` / `icon-xs` at
 * h-7 w-7, muted foreground, the same transition tokens) so this reads as part
 * of the toolbar rather than as a new control family.
 */
export interface ViewPathNavProps {
  segments: BreadcrumbSegment[];
  canGoBack: boolean;
  canGoForward: boolean;
  /** Destination labels, when known — the button says where it goes rather
   *  than only that it goes back. */
  backLabel?: string;
  forwardLabel?: string;
  onBack: () => void;
  onForward: () => void;
  /** Navigate to an ancestor crumb. The last segment has no target. */
  onSelectSegment: (target: ViewLocation) => void;
}

const ICON_BUTTON_CLASS =
  "h-7 w-7 shrink-0 rounded-lg text-muted-foreground transition-[color,background-color,transform] "
  + "duration-[var(--motion-fast)] ease-[var(--motion-ease-standard)] hover:bg-accent "
  + "hover:text-foreground active:scale-[0.96] disabled:opacity-40 motion-reduce:transition-none "
  + "motion-reduce:transform-none";

export function ViewPathNav({
  segments,
  canGoBack,
  canGoForward,
  backLabel,
  forwardLabel,
  onBack,
  onForward,
  onSelectSegment,
}: ViewPathNavProps) {
  const { t } = useTranslation();
  const backText = backLabel
    ? t("viewPathNav.backTo", { label: backLabel })
    : t("viewPathNav.back");
  const forwardText = forwardLabel
    ? t("viewPathNav.forwardTo", { label: forwardLabel })
    : t("viewPathNav.forward");

  return (
    <div className="flex min-w-0 items-center gap-0.5" data-testid="view-path-nav">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className={ICON_BUTTON_CLASS}
            disabled={!canGoBack}
            onClick={onBack}
            aria-label={backText}
            title={backText}
            data-testid="view-path-back"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{backText}</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className={ICON_BUTTON_CLASS}
            disabled={!canGoForward}
            onClick={onForward}
            aria-label={forwardText}
            title={forwardText}
            data-testid="view-path-forward"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{forwardText}</TooltipContent>
      </Tooltip>

      {/* Collapsed below `md` — the 460px chat band has no room for a readable
          path, and a two-character stub is not one. The buttons above stay, so
          the way back survives even where its label cannot. `min-w-0` plus
          per-crumb truncation keeps a long path from eating the drag band at
          the widths where it does render. */}
      <nav
        className="ml-1 hidden min-w-0 items-center gap-0.5 text-caption text-muted-foreground md:flex"
        aria-label={t("viewPathNav.ariaLabel")}
        data-testid="view-path-breadcrumb"
      >
        {segments.map((segment, index) => {
          const isLast = index === segments.length - 1;
          return (
            <span
              key={segment.key}
              className="flex min-w-0 items-center gap-0.5"
            >
              {index > 0 ? (
                <ChevronRight className="h-3 w-3 shrink-0 opacity-60" aria-hidden="true" />
              ) : null}
              {segment.target && !isLast ? (
                <button
                  type="button"
                  className="min-w-0 truncate rounded px-1 py-0.5 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => onSelectSegment(segment.target!)}
                  data-testid={`view-path-segment-${segment.key}`}
                >
                  {segment.label}
                </button>
              ) : (
                <span
                  className="min-w-0 truncate px-1 py-0.5 font-medium text-foreground"
                  // The deepest crumb is where you already are, so it is text,
                  // not a control — and it is what a screen reader should
                  // announce as current.
                  aria-current="page"
                  data-testid={`view-path-current-${segment.key}`}
                >
                  {segment.label}
                </span>
              )}
            </span>
          );
        })}
      </nav>
    </div>
  );
}
