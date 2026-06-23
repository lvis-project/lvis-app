/**
 * useInlineSlashMenu — drives the caret-anchored "/" autocomplete inside the
 * composer textarea.
 *
 * Given the controlled text + caret, it derives the active trigger (via
 * detectSlashQuery), filters every category by the typed query, and exposes a
 * flat navigable item list plus the accept/replace logic. Composer wires the
 * keyboard (↑/↓/⏎/esc) to move/accept/close; the InlineSlashMenu component
 * renders items/activeIndex.
 *
 * The menu is intentionally a sibling of the popover SlashPicker: both share
 * slash-picker-data.ts so their catalog + matching semantics never diverge.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { RefObject } from "react";
import { useTranslation } from "../../../i18n/react.js";
import type { QuickAction } from "../components/command-actions.js";
import type { PluginEntry } from "../components/PluginGridButton.js";
import {
  CATEGORY_ORDER,
  filterActions,
  filterMcpTools,
  filterPlugins,
  filterSkills,
  filterSlashCommands,
  type Category,
  type McpToolEntry,
  type SkillEntry,
} from "../components/slash-picker-data.js";
import { detectSlashQuery } from "../utils/slash-trigger.js";

/** A single flat row in the inline menu, tagged with its source category. */
export interface InlineSlashItem {
  category: Category;
  /** Stable key for React. */
  key: string;
  /** Primary label (command string / shortcut label / plugin label). */
  label: string;
  /** Optional secondary text (a slash command's description). */
  hint?: string;
  /** Run the item: splice text at the trigger range, or run/open. */
  apply: (range: { start: number; end: number }) => void;
}

export interface UseInlineSlashMenuArgs {
  text: string;
  caret: number;
  enabled: boolean;
  isComposing: boolean;
  commandActions: QuickAction[];
  plugins: PluginEntry[];
  /** Live MCP-server tools (real host IPC) — referenced as text on accept. */
  mcpTools: McpToolEntry[];
  /** Registered skills (real host IPC) — referenced as text on accept. */
  skills: SkillEntry[];
  onSelectPlugin: (viewKey: string) => void;
  taRef: RefObject<HTMLTextAreaElement | null>;
  onTextChange: (next: string) => void;
}

export interface UseInlineSlashMenuResult {
  open: boolean;
  items: InlineSlashItem[];
  activeIndex: number;
  setActiveIndex: (i: number) => void;
  move: (delta: number) => void;
  accept: () => void;
  close: () => void;
}

export function useInlineSlashMenu({
  text,
  caret,
  enabled,
  isComposing,
  commandActions,
  plugins,
  mcpTools,
  skills,
  onSelectPlugin,
  taRef,
  onTextChange,
}: UseInlineSlashMenuArgs): UseInlineSlashMenuResult {
  const { t } = useTranslation();
  const [activeIndex, setActiveIndex] = useState(0);
  // Manual dismissal (esc) — re-armed when the trigger token changes so a new
  // "/" reopens after an explicit close.
  const [dismissedToken, setDismissedToken] = useState<string | null>(null);

  const trigger = useMemo(
    () => (enabled && !isComposing ? detectSlashQuery(text, caret) : null),
    [enabled, isComposing, text, caret],
  );

  const triggerKey = trigger ? `${trigger.start}:${trigger.end}:${trigger.query}` : null;

  const spliceText = useCallback(
    (range: { start: number; end: number }, insertion: string) => {
      const next = text.slice(0, range.start) + insertion + text.slice(range.end);
      onTextChange(next);
      const pos = range.start + insertion.length;
      requestAnimationFrame(() => {
        const ta = taRef.current;
        if (ta) {
          ta.setSelectionRange(pos, pos);
          ta.focus();
        }
      });
    },
    [text, onTextChange, taRef],
  );

  const stripTrigger = useCallback(
    (range: { start: number; end: number }) => {
      // Remove the typed "/query" token entirely (used when an item runs an
      // action / opens a view rather than inserting text).
      const next = text.slice(0, range.start) + text.slice(range.end);
      onTextChange(next);
      requestAnimationFrame(() => {
        const ta = taRef.current;
        if (ta) {
          ta.setSelectionRange(range.start, range.start);
          ta.focus();
        }
      });
    },
    [text, onTextChange, taRef],
  );

  const items = useMemo<InlineSlashItem[]>(() => {
    if (!trigger) return [];
    const q = trigger.query;
    const out: InlineSlashItem[] = [];
    for (const cat of CATEGORY_ORDER) {
      if (cat === "command") {
        for (const c of filterSlashCommands(q)) {
          out.push({
            category: "command",
            key: `cmd:${c.cmd}`,
            label: c.cmd,
            hint: t(c.labelKey),
            apply: (range) => spliceText(range, `${c.cmd} `),
          });
        }
      } else if (cat === "shortcut") {
        for (const a of filterActions(commandActions, q)) {
          out.push({
            category: "shortcut",
            key: `act:${a.id}`,
            label: a.label,
            apply: (range) => {
              stripTrigger(range);
              void a.run();
            },
          });
        }
      } else if (cat === "plugin") {
        for (const p of filterPlugins(plugins, q)) {
          out.push({
            category: "plugin",
            key: `plg:${p.viewKey}`,
            label: p.label,
            apply: (range) => {
              stripTrigger(range);
              onSelectPlugin(p.viewKey);
            },
          });
        }
      } else if (cat === "mcp") {
        for (const m of filterMcpTools(mcpTools, q)) {
          out.push({
            category: "mcp",
            key: `mcp:${m.serverId}/${m.name}`,
            label: m.name,
            hint: m.serverId,
            apply: (range) => spliceText(range, `${m.name} `),
          });
        }
      } else if (cat === "skills") {
        for (const s of filterSkills(skills, q)) {
          out.push({
            category: "skills",
            key: `skill:${s.name}`,
            label: s.name,
            hint: s.description,
            apply: (range) => spliceText(range, `${s.name} `),
          });
        }
      }
    }
    return out;
  }, [trigger, t, commandActions, plugins, mcpTools, skills, spliceText, stripTrigger, onSelectPlugin]);

  // Reset the active row whenever the result set changes shape.
  useEffect(() => {
    setActiveIndex(0);
  }, [triggerKey]);

  const open = trigger !== null && items.length > 0 && dismissedToken !== triggerKey;

  const move = useCallback(
    (delta: number) => {
      setActiveIndex((i) => {
        if (items.length === 0) return 0;
        return (i + delta + items.length) % items.length;
      });
    },
    [items.length],
  );

  const accept = useCallback(() => {
    if (!trigger) return;
    const item = items[activeIndex];
    if (!item) return;
    item.apply({ start: trigger.start, end: trigger.end });
  }, [trigger, items, activeIndex]);

  const close = useCallback(() => {
    setDismissedToken(triggerKey);
  }, [triggerKey]);

  return { open, items, activeIndex, setActiveIndex, move, accept, close };
}
