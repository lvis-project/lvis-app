/**
 * SlashPickerPanel — the popover body for SlashPicker.
 *
 * Stepped drill-down: the root view lists categories (command / shortcut /
 * plugin) as collapsible rows; selecting one opens its items. A non-empty
 * search query collapses the drill-down into a flat cross-category result list
 * so the user can still match everything at once. Lazy-loaded (cmdk) so the app
 * does not import the Command palette at startup.
 */
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { ChevronRight } from "lucide-react";
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
import { pluginIconFor } from "../utils/plugin-icon.js";
import type { QuickAction } from "./command-actions.js";
import type { PluginEntry } from "./PluginGridButton.js";
import {
  CATEGORY_ICON,
  CATEGORY_ORDER,
  catDescription,
  catLabel,
  filterActions,
  filterPlugins,
  filterSlashCommands,
  type Category,
  type SlashCommand,
} from "./slash-picker-data.js";

interface SlashPickerPanelProps {
  actions: QuickAction[];
  plugins: PluginEntry[];
  onSelectPlugin: (viewKey: string) => void;
  onInsert: (cmd: string) => void;
  onClose: () => void;
}

export function SlashPickerPanel({
  actions,
  plugins,
  onSelectPlugin,
  onInsert,
  onClose,
}: SlashPickerPanelProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  // null = root category list; a Category = drilled into that group.
  const [step, setStep] = useState<Category | null>(null);
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
        // Esc backs out of a drilled category first, then closes the picker.
        if (step !== null) {
          setStep(null);
          return;
        }
        onClose();
      } else if (composingRef.current && e.key === "Enter") {
        e.stopPropagation();
        e.preventDefault();
      }
    },
    [onClose, step],
  );

  const runSlash = useCallback(
    (cmd: string) => {
      onClose();
      onInsert(cmd + " ");
    },
    [onClose, onInsert],
  );

  const runAction = useCallback(
    (action: QuickAction) => {
      onClose();
      void action.run();
    },
    [onClose],
  );

  const runPlugin = useCallback(
    (plugin: PluginEntry) => {
      onClose();
      onSelectPlugin(plugin.viewKey);
    },
    [onClose, onSelectPlugin],
  );

  const searching = query.trim().length > 0;
  const matchedCommands = filterSlashCommands(query);
  const matchedActions = filterActions(actions, query);
  const matchedPlugins = filterPlugins(plugins, query);

  const counts: Record<Category, number> = {
    command: matchedCommands.length,
    shortcut: matchedActions.length,
    plugin: matchedPlugins.length,
  };

  // Which categories render: when searching, every category with a hit; when
  // drilled, only the active one; at root, all of them (as drill rows).
  const visibleCategories: Category[] = searching
    ? CATEGORY_ORDER.filter((c) => counts[c] > 0)
    : step !== null
      ? [step]
      : CATEGORY_ORDER;

  const renderCommandRow = (c: SlashCommand) => (
    <CommandItem
      key={c.cmd}
      value={`${c.cmd} ${t(c.labelKey)}`}
      onSelect={() => runSlash(c.cmd)}
    >
      <span className="font-mono text-xs text-muted-foreground w-28 shrink-0">{c.cmd}</span>
      <span className="text-xs">{t(c.labelKey)}</span>
    </CommandItem>
  );

  const renderActionRow = (a: QuickAction) => (
    <CommandItem key={a.id} value={a.label} onSelect={() => runAction(a)}>
      <span className="text-xs">{a.label}</span>
    </CommandItem>
  );

  const renderPluginRow = (p: PluginEntry) => {
    const Icon = pluginIconFor({ icon: p.icon, iconText: p.iconText });
    return (
      <CommandItem key={p.viewKey} value={p.label} onSelect={() => runPlugin(p)}>
        <Suspense fallback={<span className="h-3.5 w-3.5 shrink-0" />}>
          <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </Suspense>
        <span className="text-xs">{p.label}</span>
      </CommandItem>
    );
  };

  return (
    <PopoverContent
      align="start"
      className="w-80 p-0"
      data-testid="slash-picker"
      onKeyDownCapture={handleKeyDownCapture}
      onInteractOutside={() => {
        setQuery("");
        setStep(null);
      }}
    >
      <Command shouldFilter={false}>
        <CommandInput
          ref={inputRef}
          placeholder={t("commandPopoverPanel.searchPlaceholder")}
          value={query}
          onValueChange={(next) => {
            setQuery(next);
            // Any typed query leaves the drill-down for the flat search view.
            if (next.trim().length > 0) setStep(null);
          }}
          data-testid="command-input"
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
          }}
        />
        <CommandList className="max-h-[340px] overflow-y-auto scrollbar-thin">
          <CommandEmpty>{t("commandPopoverPanel.noResults")}</CommandEmpty>

          {/* Root drill-down: category rows that open each group. Only shown
              when not searching and not already inside a category. */}
          {!searching && step === null && (
            <CommandGroup data-testid="slash-picker-categories">
              {CATEGORY_ORDER.filter((c) => counts[c] > 0).map((c) => {
                const Icon = CATEGORY_ICON[c];
                return (
                  <CommandItem
                    key={c}
                    value={catLabel(c)}
                    onSelect={() => setStep(c)}
                    data-testid={`slash-picker-cat-${c}`}
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="text-xs">{catLabel(c)}</span>
                      <span className="text-[11px] text-muted-foreground line-clamp-1">
                        {catDescription(c)}
                      </span>
                    </div>
                    <span className="ml-1 rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">
                      {counts[c]}
                    </span>
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  </CommandItem>
                );
              })}
            </CommandGroup>
          )}

          {/* Item lists — one group per visible category (drilled or searched). */}
          {visibleCategories.includes("command") && (searching || step === "command") && (
            <CommandGroup heading={catLabel("command")} data-testid="slash-group-command">
              {matchedCommands.map(renderCommandRow)}
            </CommandGroup>
          )}
          {visibleCategories.includes("shortcut") && (searching || step === "shortcut") && (
            <CommandGroup heading={catLabel("shortcut")} data-testid="slash-group-shortcut">
              {matchedActions.map(renderActionRow)}
            </CommandGroup>
          )}
          {visibleCategories.includes("plugin") && (searching || step === "plugin") && (
            <CommandGroup heading={catLabel("plugin")} data-testid="slash-group-plugin">
              {matchedPlugins.map(renderPluginRow)}
            </CommandGroup>
          )}
        </CommandList>
      </Command>
    </PopoverContent>
  );
}

export default SlashPickerPanel;
