import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";
import { useTranslation } from "../../../i18n/react.js";
import type { BreadcrumbSegment, ViewLocation } from "../utils/view-location.js";
import { TEST_IDS } from "../../../shared/test-ids.js";

/**
 * Where the main window is, in two pieces that no longer sit together.
 *
 * They were one control in the top band. The workbench model (DESIGN.md)
 * separates them by what they act on: back/forward act on the WINDOW's
 * location, so they belong to the chrome; the path describes WHAT IS OPEN, so
 * it belongs with the content. VS Code makes the same split — history is
 * chrome, and `breadcrumb.*` is a content token family rendered at the leading
 * edge of the editor, not in the title bar.
 *
 * So this file exports the two halves separately:
 *   - {@link ViewHistoryNav} — the buttons, now in the sidebar's cluster strip.
 *   - {@link ViewPathBreadcrumb} — the path, now on the canvas's leading edge.
 *
 * They keep sharing {@link ViewPathNavProps}: the two halves read the same
 * navigation state, and splitting the type would let the halves disagree about
 * what "where you are" means. Both are still width-capped and truncate rather
 * than grow — the strip they sit in is a drag region, and grab area is scarce.
 *
 * Styling stays the band's icon-button recipe (`ghost` / `icon-xs`, muted
 * foreground, shared transition tokens) so neither half reads as a new control
 * family after the move.
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

/** The history half: back / forward. Chrome-side. */
export function ViewHistoryNav({
  canGoBack,
  canGoForward,
  backLabel,
  forwardLabel,
  onBack,
  onForward,
}: Pick<
  ViewPathNavProps,
  "canGoBack" | "canGoForward" | "backLabel" | "forwardLabel" | "onBack" | "onForward"
>) {
  const { t } = useTranslation();
  const backText = backLabel
    ? t("viewPathNav.backTo", { label: backLabel })
    : t("viewPathNav.back");
  const forwardText = forwardLabel
    ? t("viewPathNav.forwardTo", { label: forwardLabel })
    : t("viewPathNav.forward");

  return (
    <div className="flex shrink-0 items-center gap-0.5" data-testid="view-path-nav">
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
            data-testid={TEST_IDS.viewPathBack}
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
    </div>
  );
}

/**
 * The path half. Content-side: it renders on the canvas's leading edge, under
 * the window band, because it describes what is open rather than where the
 * window is.
 *
 * Collapsed below `md` — a window at `MAIN_WINDOW_MIN_WIDTH`
 * (`shared/shell-geometry.ts`), which is the chat band, has no room for a
 * readable path, and a two-character stub is not one. The history buttons live elsewhere now
 * and are unaffected, so the way back survives even at widths where the label
 * cannot. `min-w-0` plus per-crumb truncation keeps a long path from pushing
 * the canvas wider than it is.
 */
export function ViewPathBreadcrumb({
  segments,
  onSelectSegment,
}: Pick<ViewPathNavProps, "segments" | "onSelectSegment">) {
  const { t } = useTranslation();
  return (
    <nav
      className="hidden min-w-0 items-center gap-0.5 text-caption text-muted-foreground md:flex"
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
                className={isLast
                  ? "min-w-0 truncate px-1 py-0.5 font-medium text-foreground"
                  : "min-w-0 truncate px-1 py-0.5"}
                // The deepest crumb is where you already are, so it is text,
                // not a control — and it is what a screen reader should
                // announce as current.
                aria-current={isLast ? "page" : undefined}
                data-testid={`${isLast ? "view-path-current" : "view-path-segment"}-${segment.key}`}
              >
                {segment.label}
              </span>
            )}
          </span>
        );
      })}
    </nav>
  );
}
