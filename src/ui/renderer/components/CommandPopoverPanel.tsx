import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "../../../components/ui/command.js";
import { PopoverContent } from "../../../components/ui/popover.js";
import type { QuickAction } from "./command-actions.js";

const SLASH_COMMANDS: { cmd: string; label: string }[] = [
  { cmd: "/new",      label: "새 대화" },
  { cmd: "/sessions", label: "세션 목록" },
  { cmd: "/load",     label: "세션 불러오기" },
  { cmd: "/compact",  label: "대화 압축" },
  { cmd: "/remember", label: "메모리 저장" },
  { cmd: "/memory",   label: "메모리 조회" },
  { cmd: "/vendor",   label: "벤더 변경" },
  { cmd: "/tools",    label: "도구 목록" },
  { cmd: "/permission", label: "권한 상태" },
  { cmd: "/permission dir list", label: "허용 디렉터리 목록" },
  { cmd: "/permission mode strict", label: "권한 모드: strict" },
  { cmd: "/permission mode default", label: "권한 모드: default" },
  { cmd: "/permission mode auto", label: "권한 모드: auto" },
  { cmd: "/permission mode allow", label: "권한 모드: allow" },
  { cmd: "/permission hooks list", label: "Hook 신뢰 상태" },
  { cmd: "/permission audit verify", label: "권한 감사 검증" },
  { cmd: "/help",     label: "도움말" },
];

interface CommandPopoverPanelProps {
  actions: QuickAction[];
  onInsert: (cmd: string) => void;
  onClose: () => void;
}

export function CommandPopoverPanel({ actions, onInsert, onClose }: CommandPopoverPanelProps) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);

  useEffect(() => {
    const id = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(id);
  }, []);

  const handleKeyDownCapture = useCallback(
    (e: ReactKeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      } else if (composingRef.current && e.key === "Enter") {
        e.stopPropagation();
        e.preventDefault();
      }
    },
    [onClose],
  );

  const handleSelectAction = useCallback(
    (action: QuickAction) => {
      onClose();
      void action.run();
    },
    [onClose],
  );

  const handleSelectSlash = useCallback(
    (cmd: string) => {
      onClose();
      onInsert(cmd + " ");
    },
    [onClose, onInsert],
  );

  const lowerQuery = query.toLowerCase();
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
    <PopoverContent
      align="start"
      className="w-72 p-0"
      data-testid="command-popover"
      onKeyDownCapture={handleKeyDownCapture}
      onInteractOutside={() => { setQuery(""); }}
    >
      <Command shouldFilter={false}>
        <CommandInput
          ref={inputRef}
          placeholder="검색..."
          value={query}
          onValueChange={setQuery}
          data-testid="command-input"
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => { composingRef.current = false; }}
        />
        <CommandList className="max-h-[320px] overflow-y-auto scrollbar-thin">
          <CommandEmpty>결과 없음</CommandEmpty>

          {filteredActions.length > 0 && (
            <CommandGroup heading="빠른 실행" data-testid="command-group-actions">
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
            <CommandGroup heading="슬래시 명령" data-testid="command-group-slash">
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
  );
}

export default CommandPopoverPanel;
