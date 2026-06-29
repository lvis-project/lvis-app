import { lazy, Suspense, useCallback } from "react";
import { Command as CommandIcon } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { Popover, PopoverTrigger } from "../../../components/ui/popover.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";
import type { QuickAction } from "./command-actions.js";
import { useTranslation } from "../../../i18n/react.js";
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
  const { t } = useTranslation();
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
              variant="outline"
              size="sm"
              className="h-7 w-7 shrink-0 bg-input-bar p-0"
              aria-label={t("commandPopover.ariaLabel")}
              data-testid="command-popover-trigger"
              // Tutorial-C SpotlightTour anchor (PR #983 follow-up). Step 3
              // of `first-boot-essentials` highlights this ⌘K toggle, see
              // `default-tour-scenarios.ts`.
              data-tour-anchor="command-palette-toggle"
            >
              <CommandIcon className="h-3.5 w-3.5" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">{t("commandPopover.shortcutHint")}</TooltipContent>
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
