import type { LucideIcon } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";

/**
 * The one shape the window band uses to report app lifecycle state: an app
 * update, plugin updates, managed-plugin bootstrap.
 *
 * Each subject used to draw its own surface — two of them as floating banners
 * over the content — so three unrelated visual languages competed for the same
 * moment and the content lost width to them. One pill shape, one row, one
 * height token means a second pill appearing next to a first cannot move
 * anything else on screen, and a reader learns the shape once.
 *
 * Tone is the only visual axis. It is a semantic token name, so a theme bundle
 * supplies the actual color.
 */
type ToolbarStatusPillTone = "info" | "muted" | "success" | "warning" | "destructive";

/**
 * Full class strings per tone rather than an interpolated token name: the
 * stylesheet build scans source text for utilities, and a name assembled at
 * runtime is not there to be found.
 */
const TONE_CLASS: Record<ToolbarStatusPillTone, string> = {
  info: "text-info border-info/(--opacity-medium) bg-info/(--opacity-subtle) hover:bg-info/(--opacity-light)",
  muted: "text-muted-foreground border-border bg-muted/(--opacity-medium)",
  success: "text-success border-success/(--opacity-medium) bg-success/(--opacity-subtle) hover:bg-success/(--opacity-light)",
  warning: "text-warning border-warning/(--opacity-medium) bg-warning/(--opacity-subtle) hover:bg-warning/(--opacity-light)",
  destructive:
    "text-destructive border-destructive/(--opacity-medium) bg-destructive/(--opacity-subtle) hover:bg-destructive/(--opacity-light)",
};

/** The trailing icon-only control: skip a version, dismiss a report. */
interface ToolbarStatusPillAction {
  icon: LucideIcon;
  title: string;
  ariaLabel: string;
  onClick: () => void;
  testId: string;
  disabled?: boolean;
}

export interface ToolbarStatusPillProps {
  tone: ToolbarStatusPillTone;
  icon: LucideIcon;
  /** The pill's visible text. Short — it shares the band with everything else. */
  label: string;
  /** Hover text and tooltip body. The place the long form goes. */
  title: string;
  ariaLabel: string;
  /** Work is in flight: the icon spins and the cursor reads as progress. */
  busy?: boolean;
  onClick?: () => void;
  disabled?: boolean;
  testId: string;
  secondaryAction?: ToolbarStatusPillAction;
}

export function ToolbarStatusPill({
  tone,
  icon: Icon,
  label,
  title,
  ariaLabel,
  busy = false,
  onClick,
  disabled = false,
  testId,
  secondaryAction,
}: ToolbarStatusPillProps) {
  const pill = (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={`h-(--chrome-control-height) gap-1 border px-2 text-[11px] font-medium disabled:opacity-60 ${TONE_CLASS[tone]}${busy ? " cursor-progress" : ""}`}
          onClick={onClick}
          disabled={disabled}
          title={title}
          aria-label={ariaLabel}
          data-testid={testId}
        >
          <Icon className={busy ? "h-3 w-3 animate-spin" : "h-3 w-3"} />
          <span>{label}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{title}</TooltipContent>
    </Tooltip>
  );

  if (!secondaryAction) return pill;

  const { icon: ActionIcon } = secondaryAction;
  return (
    <div className="flex items-center gap-1">
      {pill}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-(--chrome-control-height) w-(--chrome-control-height) aspect-square text-muted-foreground hover:text-foreground disabled:opacity-60"
            onClick={secondaryAction.onClick}
            disabled={secondaryAction.disabled}
            title={secondaryAction.title}
            aria-label={secondaryAction.ariaLabel}
            data-testid={secondaryAction.testId}
          >
            <ActionIcon className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{secondaryAction.title}</TooltipContent>
      </Tooltip>
    </div>
  );
}
