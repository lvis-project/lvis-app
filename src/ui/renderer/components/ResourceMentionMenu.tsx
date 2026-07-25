/**
 * ResourceMentionMenu — the caret-anchored dropdown for `@` resource mentions.
 *
 * Presentational only, exactly like {@link InlineSlashMenu}: focus stays in the
 * textarea (selection on `mousedown`, which prevents the focus shift) and keyboard
 * navigation is driven by Composer.handleKeyDown through the useResourceMention state.
 *
 * A sibling component rather than a shared generic one. The two menus differ in what a
 * row IS — a slash row carries a category icon and label, a resource row carries a
 * server and a URI — and the part actually worth not duplicating is the anchor
 * geometry, which both take from `useCaretAnchoredBox`.
 */
import { useRef } from "react";
import { createPortal } from "react-dom";
import type { RefObject } from "react";
import { Database } from "lucide-react";
import { useTranslation } from "../../../i18n/react.js";
import { useCaretAnchoredBox } from "../hooks/use-caret-anchored-box.js";
import type { ResourceMentionItem } from "../hooks/use-resource-mention.js";

interface ResourceMentionMenuProps {
  open: boolean;
  items: ResourceMentionItem[];
  activeIndex: number;
  anchorRef: RefObject<HTMLTextAreaElement | null>;
  onHover: (index: number) => void;
  onSelect: (index?: number) => void;
}

export function ResourceMentionMenu({
  open,
  items,
  activeIndex,
  anchorRef,
  onHover,
  onSelect,
}: ResourceMentionMenuProps) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement>(null);
  const anchor = useCaretAnchoredBox({
    open,
    anchorRef,
    listRef,
    activeIndex,
    itemCount: items.length,
  });

  if (!open || !anchor || items.length === 0) return null;

  return createPortal(
    <div
      data-testid="resource-mention-menu"
      role="listbox"
      className="fixed z-50 max-h-72 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md scrollbar-thin"
      style={{ left: anchor.left, width: anchor.width, bottom: anchor.bottom }}
      ref={listRef}
    >
      {items.map((item, index) => {
        const active = index === activeIndex;
        return (
          <div
            key={item.key}
            role="option"
            aria-selected={active}
            data-active={active}
            data-testid={`resource-mention-item-${index}`}
            onMouseEnter={() => onHover(index)}
            onMouseDown={(event) => {
              // Keep textarea focus — select without stealing the caret.
              event.preventDefault();
              onHover(index);
              onSelect(index);
            }}
            className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 ${
              active ? "bg-accent text-accent-foreground" : "text-foreground"
            }`}
          >
            <Database className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate text-xs">{item.label}</span>
            <span className="ml-auto truncate pl-2 text-[11px] text-muted-foreground">
              {item.hint}
            </span>
          </div>
        );
      })}
      <div className="px-2 pb-1 pt-1.5 text-[10px] text-muted-foreground">
        {t("composer.resourceMentionHint")}
      </div>
    </div>,
    document.body,
  );
}
