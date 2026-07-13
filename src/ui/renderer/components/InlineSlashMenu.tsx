/**
 * InlineSlashMenu — the caret-anchored dropdown for type-to-filter "/" usage.
 *
 * Rendered in a portal with `position: fixed`, anchored to the textarea box and
 * growing UPWARD (bottom pinned just above the textarea). Portaling sidesteps
 * the two `overflow-hidden` ancestors of the composer; anchoring to the box
 * (not the glyph) matches how chat composers surface slash menus and avoids the
 * need for caret-pixel measurement.
 *
 * Focus stays in the textarea — selection happens on `mousedown` (preventing
 * the default focus shift), and keyboard nav is driven by Composer.handleKeyDown
 * through the useInlineSlashMenu state. This component is purely presentational.
 */
import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { RefObject } from "react";
import { useTranslation } from "../../../i18n/react.js";
import { CATEGORY_ICON, catLabel } from "./slash-picker-data.js";
import type { InlineSlashItem } from "../hooks/use-inline-slash-menu.js";
import {
  useNativeContextMenu,
  type NativeContextMenuHandlers,
} from "../hooks/use-native-context-menu.js";

interface InlineSlashMenuProps {
  open: boolean;
  items: InlineSlashItem[];
  activeIndex: number;
  anchorRef: RefObject<HTMLTextAreaElement | null>;
  onHover: (index: number) => void;
  onSelect: (index?: number) => void;
}

interface Anchor {
  left: number;
  width: number;
  bottom: number;
}

export function InlineSlashMenu({
  open,
  items,
  activeIndex,
  anchorRef,
  onHover,
  onSelect,
}: InlineSlashMenuProps) {
  const { t } = useTranslation();
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const openNativeContextMenu = useNativeContextMenu();

  useLayoutEffect(() => {
    if (!open) return;
    const ta = anchorRef.current;
    if (!ta) return;
    const rect = ta.getBoundingClientRect();
    setAnchor({
      left: rect.left,
      width: rect.width,
      // Grow upward: pin the menu's bottom just above the textarea top.
      bottom: window.innerHeight - rect.top + 4,
    });
  }, [open, anchorRef, items.length, activeIndex]);

  // Keep the active row in view.
  useLayoutEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-active="true"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  if (!open || !anchor || items.length === 0) return null;

  return createPortal(
    <div
      data-testid="inline-slash-menu"
      role="listbox"
      className="fixed z-50 max-h-72 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md scrollbar-thin"
      style={{ left: anchor.left, width: anchor.width, bottom: anchor.bottom }}
      ref={listRef}
    >
      {items.map((item, index) => {
        const active = index === activeIndex;
        const Icon = CATEGORY_ICON[item.category];
        return (
          <div
            key={item.key}
            role="option"
            aria-selected={active}
            data-active={active}
            data-testid={`inline-slash-item-${index}`}
            onMouseEnter={() => onHover(index)}
            onContextMenu={(event) => openNativeContextMenu(event, "command-item", {
              "command.activate": () => onSelect(index),
              "command.copy": () => navigator.clipboard.writeText(item.label),
            } as NativeContextMenuHandlers)}
            onMouseDown={(e) => {
              // Keep textarea focus — select without stealing the caret.
              e.preventDefault();
              onHover(index);
              onSelect();
            }}
            className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 ${
              active ? "bg-accent text-accent-foreground" : "text-foreground"
            }`}
          >
            <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className={`${item.category === "command" ? "font-mono " : ""}text-xs`}>
              {item.label}
            </span>
            {item.hint && (
              <span className="ml-auto truncate text-[11px] text-muted-foreground">{item.hint}</span>
            )}
            <span className="ml-1 shrink-0 text-[10px] uppercase text-muted-foreground/(--opacity-strong)">
              {catLabel(item.category)}
            </span>
          </div>
        );
      })}
      <div className="px-2 pb-1 pt-1.5 text-[10px] text-muted-foreground">
        {t("slashPicker.inlineHint")}
      </div>
    </div>,
    document.body,
  );
}
