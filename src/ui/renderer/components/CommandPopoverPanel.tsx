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
import { useTranslation } from "../../../i18n/react.js";
import type { QuickAction } from "./command-actions.js";

const SLASH_COMMANDS: { cmd: string; labelKey: string }[] = [
  { cmd: "/new",      labelKey: "commandPopoverPanel.cmdNew" },
  { cmd: "/sessions", labelKey: "commandPopoverPanel.cmdSessions" },
  { cmd: "/load",     labelKey: "commandPopoverPanel.cmdLoad" },
  { cmd: "/compact",  labelKey: "commandPopoverPanel.cmdCompact" },
  { cmd: "/remember", labelKey: "commandPopoverPanel.cmdRemember" },
  { cmd: "/memory",   labelKey: "commandPopoverPanel.cmdMemory" },
  { cmd: "/vendor",   labelKey: "commandPopoverPanel.cmdVendor" },
  { cmd: "/tools",    labelKey: "commandPopoverPanel.cmdTools" },
  { cmd: "/permission", labelKey: "commandPopoverPanel.cmdPermission" },
  { cmd: "/permission dir list", labelKey: "commandPopoverPanel.cmdPermissionDirList" },
  { cmd: "/permission mode strict", labelKey: "commandPopoverPanel.cmdPermissionModeStrict" },
  { cmd: "/permission mode default", labelKey: "commandPopoverPanel.cmdPermissionModeDefault" },
  { cmd: "/permission mode auto", labelKey: "commandPopoverPanel.cmdPermissionModeAuto" },
  { cmd: "/permission mode allow", labelKey: "commandPopoverPanel.cmdPermissionModeAllow" },
  { cmd: "/permission hooks list", labelKey: "commandPopoverPanel.cmdPermissionHooksList" },
  { cmd: "/permission audit verify", labelKey: "commandPopoverPanel.cmdPermissionAuditVerify" },
  { cmd: "/help",     labelKey: "commandPopoverPanel.cmdHelp" },
];

interface CommandPopoverPanelProps {
  actions: QuickAction[];
  onInsert: (cmd: string) => void;
  onClose: () => void;
}

export function CommandPopoverPanel({ actions, onInsert, onClose }: CommandPopoverPanelProps) {
  const { t } = useTranslation();
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
        ({ cmd, labelKey }) =>
          cmd.includes(lowerQuery) || t(labelKey).toLowerCase().includes(lowerQuery),
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
          placeholder={t("commandPopoverPanel.searchPlaceholder")}
          value={query}
          onValueChange={setQuery}
          data-testid="command-input"
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => { composingRef.current = false; }}
        />
        <CommandList className="max-h-[320px] overflow-y-auto scrollbar-thin">
          <CommandEmpty>{t("commandPopoverPanel.noResults")}</CommandEmpty>

          {filteredActions.length > 0 && (
            <CommandGroup heading={t("commandPopoverPanel.quickActions")} data-testid="command-group-actions">
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
            <CommandGroup heading={t("commandPopoverPanel.slashCommands")} data-testid="command-group-slash">
              {filteredSlash.map(({ cmd, labelKey }) => (
                <CommandItem
                  key={cmd}
                  value={`${cmd} ${t(labelKey)}`}
                  onSelect={() => handleSelectSlash(cmd)}
                >
                  <span className="font-mono text-xs text-muted-foreground w-24 shrink-0">
                    {cmd}
                  </span>
                  <span className="text-xs">{t(labelKey)}</span>
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
