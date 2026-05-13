import { lazy, Suspense, useCallback } from "react";
import { Command as CommandIcon } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { Popover, PopoverTrigger } from "../../../components/ui/popover.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";
import type { QuickAction } from "./command-actions.js";
export type { QuickAction } from "./command-actions.js";

const LazyCommandPopoverPanel = lazy(() => import("./CommandPopoverPanel.js"));

export interface CommandPopoverProps {
  /** Quick-action items (홈, 루틴, 설정, 새 대화, plugin views …) */
  actions: QuickAction[];
  /** Called when a slash command is selected; receives the command string with a trailing space e.g. "/help " */
  onInsert: (cmd: string) => void;
  /** Controlled open state — toggled externally (e.g. Cmd/Ctrl+K) */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CommandPopover({ actions, onInsert, open, onOpenChange }: CommandPopoverProps) {
  const handleOpenChange = useCallback(
    (next: boolean) => {
      onOpenChange(next);
    },
    [onOpenChange],
  );

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              aria-label="명령 팔레트 (Ctrl/Cmd+K)"
              data-testid="command-popover-trigger"
            >
              <CommandIcon className="h-3.5 w-3.5" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">Ctrl/Cmd + K</TooltipContent>
      </Tooltip>

      {open && (
        <Suspense fallback={null}>
          <LazyCommandPopoverPanel
            actions={actions}
            onInsert={onInsert}
            onClose={() => handleOpenChange(false)}
          />
        </Suspense>
      )}
    </Popover>
  );
}
