import { useState } from "react";
import { LayoutGrid } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "../../../components/ui/popover.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../../components/ui/dialog.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";

export interface PluginEntry {
  viewKey: string;
  /** Plugin id owning the view — drives auth-state lookup. @optional */
  pluginId?: string;
  label: string;
  icon?: string;
  /**
   * `true` when the owning plugin declares `manifest.auth` and its current
   * statusTool result is `kind: "unauthed"`. The grid renders a small 🔒
   * indicator on those entries so users see the missing-auth state without
   * first opening Settings (architecture.md §9.4a).
   */
  unauthed?: boolean;
}

interface PluginGridButtonProps {
  plugins: PluginEntry[];
  onSelect: (viewKey: string) => void;
}

const DIALOG_THRESHOLD = 5;

function PluginGrid({ plugins, onSelect }: { plugins: PluginEntry[]; onSelect: (key: string) => void }) {
  return (
    <div
      className="grid gap-2"
      style={{ gridTemplateColumns: `repeat(${Math.min(4, plugins.length)}, minmax(72px, 1fr))` }}
      data-testid="plugin-grid"
    >
      {plugins.map((p) => (
        <button
          key={p.viewKey}
          className="relative flex flex-col items-center gap-1 rounded-md px-3 py-2 text-center text-xs hover:bg-muted transition-colors"
          onClick={() => onSelect(p.viewKey)}
          data-viewkey={p.viewKey}
          data-unauthed={p.unauthed ? "true" : undefined}
          aria-describedby={p.unauthed ? `${p.viewKey}-unauthed` : undefined}
          title={p.unauthed ? `${p.label} — 인증이 필요합니다` : undefined}
        >
          <span className="text-xl leading-none">{p.icon ?? "🔌"}</span>
          <span className="truncate max-w-[80px]">{p.label}</span>
          {p.unauthed && (
            <span
              id={`${p.viewKey}-unauthed`}
              aria-label="미인증"
              className="absolute -right-0.5 -top-0.5 inline-flex items-center justify-center rounded-full bg-red-500 px-1 py-px text-[8px] font-medium text-white shadow"
            >
              🔒
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

export function PluginGridButton({ plugins, onSelect }: PluginGridButtonProps) {
  const [open, setOpen] = useState(false);
  const anyUnauthed = plugins.some((p) => p.unauthed);
  const tooltipLabel = anyUnauthed ? "플러그인 — 인증 필요" : "플러그인";

  const handleSelect = (viewKey: string) => {
    setOpen(false);
    onSelect(viewKey);
  };

  // Small red dot on the LayoutGrid trigger when any plugin in the popover
  // is unauthenticated. Without this users only see the missing-auth state
  // by opening the popover; the dot draws attention from outside.
  const triggerInner = (
    <span className="relative inline-flex h-3.5 w-3.5">
      <LayoutGrid className="h-3.5 w-3.5" />
      {anyUnauthed && (
        <span
          aria-label="미인증 플러그인 있음"
          data-testid="plugin-grid-unauthed-dot"
          className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-red-500 ring-1 ring-background"
        />
      )}
    </span>
  );

  const trigger = (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-7 w-7 p-0"
          aria-label="플러그인 열기"
          data-testid="plugin-grid-button"
          onClick={() => setOpen(true)}
        >
          {triggerInner}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">{tooltipLabel}</TooltipContent>
    </Tooltip>
  );

  if (plugins.length === 0) {
    return trigger;
  }

  if (plugins.length < DIALOG_THRESHOLD) {
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-7 w-7 p-0"
                aria-label="플러그인 열기"
                data-testid="plugin-grid-button"
              >
                {triggerInner}
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="top">{tooltipLabel}</TooltipContent>
        </Tooltip>
        <PopoverContent align="start" className="w-auto p-3">
          <PluginGrid plugins={plugins} onSelect={handleSelect} />
        </PopoverContent>
      </Popover>
    );
  }

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="h-7 w-7 p-0"
            aria-label="플러그인 열기"
            data-testid="plugin-grid-button"
            onClick={() => setOpen(true)}
          >
            {triggerInner}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">{tooltipLabel}</TooltipContent>
      </Tooltip>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>플러그인</DialogTitle>
          </DialogHeader>
          <div className="overflow-y-auto max-h-[60vh] pr-1">
            <PluginGrid plugins={plugins} onSelect={handleSelect} />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
