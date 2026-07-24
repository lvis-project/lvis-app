import { type ReactNode } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../../components/ui/popover.js";

export interface SettingsHelpPopoverProps {
  children: ReactNode;
  ariaLabel?: string;
  testId?: string;
}

export function SettingsHelpPopover({
  children,
  ariaLabel,
  testId,
}: SettingsHelpPopoverProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          data-testid={testId}
          className="inline-flex size-5 shrink-0 items-center justify-center rounded-full border border-border text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          ?
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 text-sm leading-6 text-muted-foreground">
        {children}
      </PopoverContent>
    </Popover>
  );
}
