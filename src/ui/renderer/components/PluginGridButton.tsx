import { useState } from "react";
import { LayoutGrid } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "../../../components/ui/popover.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../../components/ui/dialog.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";

export interface PluginEntry {
  viewKey: string;
  label: string;
  icon?: string;
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
          className="flex flex-col items-center gap-1 rounded-md px-3 py-2 text-center text-xs hover:bg-muted transition-colors"
          onClick={() => onSelect(p.viewKey)}
          data-viewkey={p.viewKey}
        >
          <span className="text-xl leading-none">{p.icon ?? "🔌"}</span>
          <span className="truncate max-w-[80px]">{p.label}</span>
        </button>
      ))}
    </div>
  );
}

export function PluginGridButton({ plugins, onSelect }: PluginGridButtonProps) {
  const [open, setOpen] = useState(false);

  const handleSelect = (viewKey: string) => {
    setOpen(false);
    onSelect(viewKey);
  };

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
          <LayoutGrid className="h-3.5 w-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">플러그인</TooltipContent>
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
                <LayoutGrid className="h-3.5 w-3.5" />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="top">플러그인</TooltipContent>
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
            <LayoutGrid className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">플러그인</TooltipContent>
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
