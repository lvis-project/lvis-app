import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { Command as CommandIcon } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "../../../components/ui/popover.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "../../../components/ui/command.js";
import { getPluginViewLabel, toViewKey } from "../api-client.js";
import type { PluginUiExtension } from "../types.js";

export interface QuickAction {
  id: string;
  label: string;
  run: () => void | Promise<void>;
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
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  // Track IME composition so we don't close on Enter mid-composition
  const composingRef = useRef(false);

  // Reset query when popover closes
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) setQuery("");
      onOpenChange(next);
    },
    [onOpenChange],
  );

  // Focus input when popover opens
  useEffect(() => {
    if (open) {
      // Small delay to let Radix mount the content before focusing
      const id = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(id);
    }
  }, [open]);

  // Both Escape and IME-guard are handled at capture phase so cmdk cannot
  // consume the event before Popover can act. Escape closes; Enter during
  // IME composition is suppressed so Korean/CJK input doesn't accidentally
  // select an item mid-composition.
  const handleKeyDownCapture = useCallback(
    (e: ReactKeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        handleOpenChange(false);
      } else if (composingRef.current && e.key === "Enter") {
        e.stopPropagation();
        e.preventDefault();
      }
    },
    [handleOpenChange],
  );

  const handleSelectAction = useCallback(
    (action: QuickAction) => {
      handleOpenChange(false);
      void action.run();
    },
    [handleOpenChange],
  );

  const handleSelectSlash = useCallback(
    (cmd: string) => {
      handleOpenChange(false);
      onInsert(cmd + " ");
    },
    [handleOpenChange, onInsert],
  );

  const lowerQuery = query.toLowerCase();

  // Filter helpers — cmdk handles its own filtering but we hide empty groups manually
  const filteredActions = lowerQuery
    ? actions.filter((a) => a.label.toLowerCase().includes(lowerQuery))
    : actions;

  const filteredSlash = lowerQuery
    ? SLASH_COMMANDS.filter(
        ({ cmd, label }) =>
          cmd.includes(lowerQuery) || label.toLowerCase().includes(lowerQuery),
      )
    : SLASH_COMMANDS;

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

      <PopoverContent
        align="start"
        className="w-72 p-0"
        data-testid="command-popover"
        onKeyDownCapture={handleKeyDownCapture}
        // onInteractOutside fires for click-outside / focus-outside; we only
        // reset query state here — the actual close is handled by Radix
        // Popover's onOpenChange (via handleOpenChange).
        onInteractOutside={() => { setQuery(""); }}
      >
        <Command
          // Disable cmdk's built-in filtering — we filter manually to control group visibility
          shouldFilter={false}
        >
          <CommandInput
            ref={inputRef}
            placeholder="검색..."
            value={query}
            onValueChange={setQuery}
            data-testid="command-input"
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={() => { composingRef.current = false; }}
          />
          <CommandList
            className="max-h-[320px] overflow-y-auto scrollbar-thin"
          >
            <CommandEmpty>결과 없음</CommandEmpty>

            {filteredActions.length > 0 && (
              <CommandGroup
                heading="빠른 실행"
                data-testid="command-group-actions"
              >
                {filteredActions.map((action) => (
                  <CommandItem
                    key={action.id}
                    value={action.label}
                    onSelect={() => handleSelectAction(action)}
                  >
                    {action.label}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {filteredSlash.length > 0 && (
              <CommandGroup
                heading="슬래시 명령"
                data-testid="command-group-slash"
              >
                {filteredSlash.map(({ cmd, label }) => (
                  <CommandItem
                    key={cmd}
                    value={`${cmd} ${label}`}
                    onSelect={() => handleSelectSlash(cmd)}
                  >
                    <span className="font-mono text-xs text-muted-foreground w-24 shrink-0">
                      {cmd}
                    </span>
                    <span className="text-xs">{label}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Build the default quick-action list from app state.
 * Mirrors what was previously `commandActions` in App.tsx.
 */
export function buildQuickActions({
  setActiveView,
  setSettingsOpen,
  handleNewChat,
  pluginViews,
}: {
  setActiveView: (key: string) => void;
  setSettingsOpen: (open: boolean) => void;
  handleNewChat: () => void | Promise<void>;
  pluginViews: PluginUiExtension[];
}): QuickAction[] {
  return [
    { id: "home",      label: "홈으로 이동",   run: () => setActiveView("home") },
    { id: "routines",  label: "루틴 보기",     run: () => setActiveView("routines") },
    { id: "settings",  label: "설정 열기",     run: () => setSettingsOpen(true) },
    { id: "new-chat",  label: "새 대화 시작",  run: handleNewChat },
    ...pluginViews.map((i) => {
      const viewKey = toViewKey(i);
      return {
        id: `v:${viewKey}`,
        label: `${getPluginViewLabel(i)} 열기`,
        run: () => setActiveView(viewKey),
      };
    }),
  ];
}
