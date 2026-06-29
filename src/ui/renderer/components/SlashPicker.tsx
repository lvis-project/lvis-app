/**
 * SlashPicker — the unified "/" entry point that replaces the old ⌘
 * CommandPopover. It folds the built-in slash commands, the view shortcuts
 * (QuickAction list), and the installed plugins into ONE picker, adopting the
 * resource-picker Command-palette look (search box + grouped, two-line items).
 *
 * Layout: a stepped/collapsing drill-down. The root view lists the categories
 * (collapsed, persona-menu style); choosing one drills into its items. Typing
 * in the search box switches to a flat, cross-category result list so a query
 * still matches everything at once.
 *
 * Everything inserts through one callback: slash commands are inserted as text
 * ("/cmd "), shortcuts run their action, plugins open their view.
 */
import { lazy, Suspense, useCallback } from "react";
import { Command as CommandIcon } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { Popover, PopoverTrigger } from "../../../components/ui/popover.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";
import type { QuickAction } from "./command-actions.js";
import type { PluginEntry } from "./PluginGridButton.js";
import { useTranslation } from "../../../i18n/react.js";

export type { QuickAction } from "./command-actions.js";

const LazySlashPickerPanel = lazy(() => import("./SlashPickerPanel.js"));

export interface SlashPickerProps {
  /** View shortcuts (홈/루틴/설정/새 대화 + 플러그인 뷰). */
  actions: QuickAction[];
  /** Installed plugins — surfaced as their own category. */
  plugins: PluginEntry[];
  /** Open a plugin's view by its view key. */
  onSelectPlugin: (viewKey: string) => void;
  /** Insert a slash command at the caret; receives the trailing space e.g. "/help ". */
  onInsert: (cmd: string) => void;
  /** Controlled open state — toggled externally (e.g. Cmd/Ctrl+K). */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SlashPicker({
  actions,
  plugins,
  onSelectPlugin,
  onInsert,
  open,
  onOpenChange,
}: SlashPickerProps) {
  const { t } = useTranslation();
  const handleOpenChange = useCallback((next: boolean) => onOpenChange(next), [onOpenChange]);

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
              // Tutorial-C SpotlightTour anchor. Step 3 of
              // `first-boot-essentials` highlights this picker toggle, see
              // `default-tour-scenarios.ts`. Kept on the unified picker so the
              // tour target stays live across the ⌘/$ merge.
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
          <LazySlashPickerPanel
            actions={actions}
            plugins={plugins}
            onSelectPlugin={onSelectPlugin}
            onInsert={onInsert}
            onClose={() => handleOpenChange(false)}
          />
        </Suspense>
      )}
    </Popover>
  );
}
