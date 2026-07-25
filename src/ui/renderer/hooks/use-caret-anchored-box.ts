/**
 * Geometry for a composer dropdown that hangs off the textarea and grows UPWARD.
 *
 * Extracted from InlineSlashMenu when the `@` mention menu needed the same box. It is
 * the part of those two components that genuinely is the same thing — anchor to the
 * textarea's box (not the caret glyph, which would need pixel measurement), pin the
 * menu's bottom just above it, and keep the active row scrolled into view. What a row
 * looks like stays with each menu, because that is where they actually differ.
 *
 * Portaled callers need `position: fixed` values: the composer has two
 * `overflow-hidden` ancestors, so a menu positioned inside the tree gets clipped.
 */
import { useLayoutEffect, useState } from "react";
import type { RefObject } from "react";

export interface CaretAnchoredBox {
  left: number;
  width: number;
  /** Distance from the viewport BOTTOM, so the menu grows upward. */
  bottom: number;
}

export function useCaretAnchoredBox({
  open,
  anchorRef,
  listRef,
  activeIndex,
  itemCount,
}: {
  open: boolean;
  anchorRef: RefObject<HTMLTextAreaElement | null>;
  listRef: RefObject<HTMLDivElement | null>;
  activeIndex: number;
  itemCount: number;
}): CaretAnchoredBox | null {
  const [anchor, setAnchor] = useState<CaretAnchoredBox | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const textarea = anchorRef.current;
    if (!textarea) return;
    const rect = textarea.getBoundingClientRect();
    setAnchor({
      left: rect.left,
      width: rect.width,
      bottom: window.innerHeight - rect.top + 4,
    });
    // `itemCount` and `activeIndex` are dependencies because the textarea grows as the
    // user types: re-measuring only on open would leave the menu overlapping it.
  }, [open, anchorRef, itemCount, activeIndex]);

  useLayoutEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-active="true"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open, listRef]);

  return anchor;
}
