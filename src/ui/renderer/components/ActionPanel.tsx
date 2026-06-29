import { PanelRightClose, PanelRightOpen, Play, Sparkles } from "lucide-react";
import { useCallback } from "react";
import { useTranslation } from "../../../i18n/react.js";
import { Button } from "../../../components/ui/button.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";
import type { QuickAction } from "./CommandPopover.js";

export interface ActionPanelProps {
  actions: QuickAction[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ActionPanel({ actions, open, onOpenChange }: ActionPanelProps) {
  const { t } = useTranslation();

  const runAction = useCallback((action: QuickAction) => {
    void Promise.resolve(action.run()).catch((err) => {
      console.error("[action-panel] action failed", err);
    });
  }, []);

  if (!open) {
    return (
      <aside
        aria-label={t("actionPanel.railAriaLabel")}
        className="flex w-12 shrink-0 flex-col items-center border-l border-border bg-card/80 pt-2 text-card-foreground"
        data-testid="action-panel-rail"
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              aria-label={t("actionPanel.openAriaLabel")}
              aria-expanded={false}
              data-testid="action-panel-open"
              onClick={() => onOpenChange(true)}
            >
              <PanelRightOpen className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">{t("actionPanel.openTooltip")}</TooltipContent>
        </Tooltip>
      </aside>
    );
  }

  return (
    <aside
      aria-label={t("actionPanel.panelAriaLabel")}
      className="flex w-80 max-w-[38vw] shrink-0 flex-col border-l border-border bg-card text-card-foreground shadow-[-12px_0_30px_rgba(15,23,42,0.08)]"
      data-testid="action-panel"
    >
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
        <div className="flex min-w-0 items-center gap-2">
          <Sparkles className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold leading-5">{t("actionPanel.title")}</h2>
            <p className="truncate text-[11px] leading-4 text-muted-foreground">
              {t("actionPanel.subtitle", { count: actions.length })}
            </p>
          </div>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              aria-label={t("actionPanel.closeAriaLabel")}
              aria-expanded={true}
              data-testid="action-panel-close"
              onClick={() => onOpenChange(false)}
            >
              <PanelRightClose className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">{t("actionPanel.closeTooltip")}</TooltipContent>
        </Tooltip>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <ul className="flex flex-col gap-1" aria-label={t("actionPanel.actionListAriaLabel")}>
          {actions.map((action, index) => (
            <li key={action.id}>
              <button
                type="button"
                className="group flex min-h-10 w-full items-center gap-2 rounded-md border border-transparent px-2.5 py-2 text-left text-sm transition-colors hover:border-border hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                data-testid={`action-panel-item-${action.id}`}
                onClick={() => runAction(action)}
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-muted text-[11px] font-medium text-muted-foreground group-hover:text-foreground">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1 truncate">{action.label}</span>
                <Play className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-70" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}
