/**
 * SlashPickerPanel — the popover body for SlashPicker.
 *
 * Stepped drill-down: the root view lists categories (command / shortcut /
 * plugin / mcp / skills) as collapsible rows; selecting one opens its items.
 * The 2nd-depth (drilled) item list reuses the SAME two-line cmdk row design
 * as the root. A non-empty search query collapses the drill-down into a flat
 * cross-category result list so the user can still match everything at once.
 * Lazy-loaded (cmdk) so the app does not import the Command palette at startup.
 */
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
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
import { useSlashPickerRuntime } from "../hooks/use-slash-picker-runtime.js";
import type { QuickAction } from "./command-actions.js";
import type { PluginEntry } from "./PluginGridButton.js";
import {
  CATEGORY_ICON,
  CATEGORY_ORDER,
  catDescription,
  catLabel,
  filterActions,
  filterMcpTools,
  filterPlugins,
  filterSkills,
  filterSlashCommands,
  type Category,
  type McpToolEntry,
  type SkillEntry,
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
  // Live MCP-server tools + registered skills (real host IPC, fetched while
  // the panel is mounted/open).
  const { mcpTools, skills } = useSlashPickerRuntime(true);

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
      } else if (e.key === "Backspace" && step !== null && query.length === 0) {
        // Backspace on an empty query pops the page stack back to root (cmdk
        // "pages" idiom) — same one-action back as the visible back row / Esc.
        e.stopPropagation();
        e.preventDefault();
        setStep(null);
      } else if (composingRef.current && e.key === "Enter") {
        e.stopPropagation();
        e.preventDefault();
      }
    },
    [onClose, step, query],
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

  // MCP tools and skills are referenced into the draft as plain text (their
  // namespaced name), so the user can compose a request that names them. This
  // mirrors how shortcuts/plugins resolve to a single onClose + side effect.
  const runText = useCallback(
    (text: string) => {
      onClose();
      onInsert(text + " ");
    },
    [onClose, onInsert],
  );

  const searching = query.trim().length > 0;
  const matchedCommands = filterSlashCommands(query);
  const matchedActions = filterActions(actions, query);
  const matchedPlugins = filterPlugins(plugins, query);
  const matchedMcpTools = filterMcpTools(mcpTools, query);
  const matchedSkills = filterSkills(skills, query);

  const counts: Record<Category, number> = {
    command: matchedCommands.length,
    shortcut: matchedActions.length,
    plugin: matchedPlugins.length,
    mcp: matchedMcpTools.length,
    skills: matchedSkills.length,
  };

  // Which categories render: when searching, every category with a hit; when
  // drilled, only the active one; at root, all of them (as drill rows).
  const visibleCategories: Category[] = searching
    ? CATEGORY_ORDER.filter((c) => counts[c] > 0)
    : step !== null
      ? [step]
      : CATEGORY_ORDER;

  // All drilled item rows share ONE two-line cmdk layout: a fixed-size leading
  // icon box (h-5 w-5, shrink-0 — never collapses onto the label) + a flex-col
  // text wrapper (name + optional description). This matches the root category
  // rows and the mcp/skill rows so the 2nd depth reads as polished as the 1st
  // depth, and the fixed icon box prevents the icon/label overlap ("EPEP").
  const CommandIcon = CATEGORY_ICON.command;
  const renderCommandRow = (c: SlashCommand) => (
    <CommandItem
      key={c.cmd}
      value={`${c.cmd} ${t(c.labelKey)}`}
      onSelect={() => runSlash(c.cmd)}
    >
      <CommandIcon className="h-5 w-5 shrink-0 rounded-[5px] bg-muted p-1 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="font-mono text-xs">{c.cmd}</span>
        <span className="text-[11px] text-muted-foreground line-clamp-1">{t(c.labelKey)}</span>
      </div>
    </CommandItem>
  );

  const ActionIcon = CATEGORY_ICON.shortcut;
  const renderActionRow = (a: QuickAction) => (
    <CommandItem key={a.id} value={a.label} onSelect={() => runAction(a)}>
      <ActionIcon className="h-5 w-5 shrink-0 rounded-[5px] bg-muted p-1 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-xs">{a.label}</span>
      </div>
    </CommandItem>
  );

  const renderPluginRow = (p: PluginEntry) => {
    const Icon = pluginIconFor({ icon: p.icon, iconText: p.iconText });
    return (
      <CommandItem key={p.viewKey} value={p.label} onSelect={() => runPlugin(p)}>
        <Suspense fallback={<span className="h-5 w-5 shrink-0 rounded-[5px] bg-muted" />}>
          <Icon className="h-5 w-5 shrink-0 rounded-[5px] bg-muted p-1 text-muted-foreground" />
        </Suspense>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-xs">{p.label}</span>
        </div>
      </CommandItem>
    );
  };

  const McpIcon = CATEGORY_ICON.mcp;
  const renderMcpRow = (m: McpToolEntry) => (
    <CommandItem key={`${m.serverId}/${m.name}`} value={`${m.name} ${m.serverId}`} onSelect={() => runText(m.name)}>
      <McpIcon className="h-5 w-5 shrink-0 rounded-[5px] bg-muted p-1 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="font-mono text-xs">{m.name}</span>
        <span className="text-[11px] text-muted-foreground line-clamp-1">{m.serverId}</span>
      </div>
    </CommandItem>
  );

  const SkillIcon = CATEGORY_ICON.skills;
  const renderSkillRow = (s: SkillEntry) => (
    <CommandItem key={s.name} value={`${s.name} ${s.description}`} onSelect={() => runText(s.name)}>
      <SkillIcon className="h-5 w-5 shrink-0 rounded-[5px] bg-muted p-1 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-xs">{s.name}</span>
        <span className="text-[11px] text-muted-foreground line-clamp-1">{s.description}</span>
      </div>
    </CommandItem>
  );

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
                    <Icon className="h-5 w-5 shrink-0 rounded-[5px] bg-muted p-1 text-muted-foreground" />
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

          {/* Drilled-view back row — a discoverable, one-click affordance that
              pops the page stack back to the root category list (NOT closing the
              picker). Keyboard equivalent: Esc / Backspace-on-empty-query (wired
              in handleKeyDownCapture). Only shown when drilled and not searching
              (search already flattens to the cross-category view). */}
          {!searching && step !== null && (
            <CommandGroup data-testid="slash-picker-back">
              <CommandItem
                value="__back__"
                onSelect={() => setStep(null)}
                data-testid="slash-picker-back-row"
                className="text-accent-foreground"
              >
                <ChevronLeft className="h-3.5 w-3.5 shrink-0 text-accent" />
                <span className="text-xs font-medium text-accent">{t("slashPicker.back")}</span>
                <span className="ml-1 truncate text-[11px] text-muted-foreground">
                  {catLabel(step)}
                </span>
              </CommandItem>
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
          {visibleCategories.includes("mcp") && (searching || step === "mcp") && (
            <CommandGroup heading={catLabel("mcp")} data-testid="slash-group-mcp">
              {matchedMcpTools.map(renderMcpRow)}
            </CommandGroup>
          )}
          {visibleCategories.includes("skills") && (searching || step === "skills") && (
            <CommandGroup heading={catLabel("skills")} data-testid="slash-group-skills">
              {matchedSkills.map(renderSkillRow)}
            </CommandGroup>
          )}
        </CommandList>
      </Command>
    </PopoverContent>
  );
}

export default SlashPickerPanel;
