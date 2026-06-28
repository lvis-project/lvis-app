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
import { Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
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

const PICKER_ROW_CLASS = "min-h-8 gap-2.5 px-2 py-1.5";
const PICKER_BACK_ROW_CLASS = "min-h-7 gap-2.5 px-2 py-1 text-accent";
const PICKER_ICON_SLOT_CLASS = "flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground";
const PICKER_ICON_CLASS = "h-3.5 w-3.5 shrink-0";
const PICKER_TEXT_STACK_CLASS = "flex min-w-0 flex-1 flex-col justify-center";
const PICKER_TITLE_CLASS = "min-w-0 truncate text-xs leading-4";
const PICKER_SUBTITLE_CLASS = "mt-0.5 min-w-0 truncate text-[11px] leading-3 text-muted-foreground";
const PICKER_COUNT_CLASS =
  "ml-1 flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-muted px-1.5 text-[10px] leading-none text-muted-foreground";
const PICKER_GROUP_CLASS =
  "pt-1 [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-1 [&_[cmdk-group-heading]]:text-sm [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-foreground";

function PickerIconSlot({ children }: { children: ReactNode }) {
  return <span className={PICKER_ICON_SLOT_CLASS}>{children}</span>;
}

function PickerText({
  title,
  subtitle,
  titleClassName = "",
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  titleClassName?: string;
}) {
  return (
    <div className={PICKER_TEXT_STACK_CLASS}>
      <span className={`${PICKER_TITLE_CLASS} ${titleClassName}`.trim()}>{title}</span>
      {subtitle ? <span className={PICKER_SUBTITLE_CLASS}>{subtitle}</span> : null}
    </div>
  );
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

  const renderCommandRow = (c: SlashCommand) => (
    <CommandItem
      key={c.cmd}
      className={PICKER_ROW_CLASS}
      value={`${c.cmd} ${t(c.labelKey)}`}
      onSelect={() => runSlash(c.cmd)}
    >
      <PickerIconSlot>
        <CATEGORY_ICON.command className={PICKER_ICON_CLASS} />
      </PickerIconSlot>
      <PickerText title={c.cmd} subtitle={t(c.labelKey)} titleClassName="font-mono" />
    </CommandItem>
  );

  const renderActionRow = (a: QuickAction) => (
    <CommandItem key={a.id} className={PICKER_ROW_CLASS} value={a.label} onSelect={() => runAction(a)}>
      <PickerIconSlot>
        <CATEGORY_ICON.shortcut className={PICKER_ICON_CLASS} />
      </PickerIconSlot>
      <PickerText title={a.label} />
    </CommandItem>
  );

  const renderPluginRow = (p: PluginEntry) => {
    const Icon = pluginIconFor({ icon: p.icon, iconText: p.iconText });
    return (
      <CommandItem key={p.viewKey} className={PICKER_ROW_CLASS} value={p.label} onSelect={() => runPlugin(p)}>
        <PickerIconSlot>
          <Suspense fallback={<span className={PICKER_ICON_CLASS} />}>
            <Icon
              className={`${PICKER_ICON_CLASS} text-muted-foreground`}
              style={p.iconText ? { fontSize: "0.62rem" } : undefined}
            />
          </Suspense>
        </PickerIconSlot>
        <PickerText title={p.label} />
      </CommandItem>
    );
  };

  const McpIcon = CATEGORY_ICON.mcp;
  const renderMcpRow = (m: McpToolEntry) => (
    <CommandItem
      key={`${m.serverId}/${m.name}`}
      className={PICKER_ROW_CLASS}
      value={`${m.name} ${m.serverId}`}
      onSelect={() => runText(m.name)}
    >
      <PickerIconSlot>
        <McpIcon className={PICKER_ICON_CLASS} />
      </PickerIconSlot>
      <PickerText title={m.name} subtitle={m.serverId} titleClassName="font-mono" />
    </CommandItem>
  );

  const SkillIcon = CATEGORY_ICON.skills;
  const renderSkillRow = (s: SkillEntry) => (
    <CommandItem
      key={s.name}
      className={PICKER_ROW_CLASS}
      value={`${s.name} ${s.description}`}
      onSelect={() => runText(s.name)}
    >
      <PickerIconSlot>
        <SkillIcon className={PICKER_ICON_CLASS} />
      </PickerIconSlot>
      <PickerText title={s.name} subtitle={s.description} />
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
                    className={PICKER_ROW_CLASS}
                    value={catLabel(c)}
                    onSelect={() => setStep(c)}
                    data-testid={`slash-picker-cat-${c}`}
                  >
                    <PickerIconSlot>
                      <Icon className={PICKER_ICON_CLASS} />
                    </PickerIconSlot>
                    <PickerText title={catLabel(c)} subtitle={catDescription(c)} />
                    <span className={PICKER_COUNT_CLASS}>{counts[c]}</span>
                    <ChevronRight className={`${PICKER_ICON_CLASS} text-muted-foreground`} />
                  </CommandItem>
                );
              })}
            </CommandGroup>
          )}

          {/* Drilled-view header: a visible BACK affordance (‹ {category}) that
              pops to the root category list in ONE action. Esc also works
              (handleKeyDownCapture). Adopts the approved stepped-popover .back
              design (accent, semibold). */}
          {!searching && step !== null && (
            <CommandItem
              value="__back__"
              onSelect={() => setStep(null)}
              className={PICKER_BACK_ROW_CLASS}
              data-testid="slash-picker-back"
            >
              <ChevronLeft className={PICKER_ICON_CLASS} />
              <span className="min-w-0 flex-1 truncate text-xs font-semibold">{catLabel(step)}</span>
            </CommandItem>
          )}

          {/* Item lists — one group per visible category (drilled or searched). */}
          {visibleCategories.includes("command") && (searching || step === "command") && (
            <CommandGroup
              className={PICKER_GROUP_CLASS}
              heading={catLabel("command")}
              data-testid="slash-group-command"
            >
              {matchedCommands.map(renderCommandRow)}
            </CommandGroup>
          )}
          {visibleCategories.includes("shortcut") && (searching || step === "shortcut") && (
            <CommandGroup
              className={PICKER_GROUP_CLASS}
              heading={catLabel("shortcut")}
              data-testid="slash-group-shortcut"
            >
              {matchedActions.map(renderActionRow)}
            </CommandGroup>
          )}
          {visibleCategories.includes("plugin") && (searching || step === "plugin") && (
            <CommandGroup
              className={PICKER_GROUP_CLASS}
              heading={catLabel("plugin")}
              data-testid="slash-group-plugin"
            >
              {matchedPlugins.map(renderPluginRow)}
            </CommandGroup>
          )}
          {visibleCategories.includes("mcp") && (searching || step === "mcp") && (
            <CommandGroup className={PICKER_GROUP_CLASS} heading={catLabel("mcp")} data-testid="slash-group-mcp">
              {matchedMcpTools.map(renderMcpRow)}
            </CommandGroup>
          )}
          {visibleCategories.includes("skills") && (searching || step === "skills") && (
            <CommandGroup
              className={PICKER_GROUP_CLASS}
              heading={catLabel("skills")}
              data-testid="slash-group-skills"
            >
              {matchedSkills.map(renderSkillRow)}
            </CommandGroup>
          )}
        </CommandList>
      </Command>
    </PopoverContent>
  );
}

export default SlashPickerPanel;
