import { useState } from "react";
import { Command as CommandIcon } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "../../../components/ui/popover.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";

interface SlashCommandButtonProps {
  onInsert: (cmd: string) => void;
}

const SLASH_COMMANDS: { cmd: string; label: string }[] = [
  { cmd: "/new",      label: "새 대화" },
  { cmd: "/sessions", label: "세션 목록" },
  { cmd: "/load",     label: "세션 불러오기" },
  { cmd: "/compact",  label: "대화 압축" },
  { cmd: "/remember", label: "메모리 저장" },
  { cmd: "/memory",   label: "메모리 조회" },
  { cmd: "/vendor",   label: "벤더 변경" },
  { cmd: "/tools",    label: "도구 목록" },
  { cmd: "/help",     label: "도움말" },
];

export function SlashCommandButton({ onInsert }: SlashCommandButtonProps) {
  const [open, setOpen] = useState(false);

  const handleSelect = (cmd: string) => {
    setOpen(false);
    onInsert(cmd);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="h-7 w-7 p-0"
              aria-label="슬래시 명령"
              data-testid="slash-command-button"
            >
              <CommandIcon className="h-3.5 w-3.5" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">슬래시 명령</TooltipContent>
      </Tooltip>
      <PopoverContent align="start" className="w-52 p-1" data-testid="slash-command-popover">
        <div className="space-y-0.5">
          {SLASH_COMMANDS.map(({ cmd, label }) => (
            <button
              key={cmd}
              className="flex w-full items-center gap-3 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-muted transition-colors"
              onClick={() => handleSelect(cmd)}
              data-cmd={cmd}
            >
              <span className="font-mono text-xs text-muted-foreground w-20 shrink-0">{cmd}</span>
              <span className="text-xs">{label}</span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
