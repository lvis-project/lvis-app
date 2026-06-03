// iOS QuickType-style chip row rendered immediately above the Composer when
// 2+ suggested replies are available. The `best` reply is shown as ghost
// text inside the textarea; this row carries the remaining alternates so
// the user can pick one with a click (PR-B) or cycle with ↑/↓ (PR-D).
//
// Spec: `docs/architecture/proposals/suggested-replies-ghost-text.md` §6.1.
//
// PR-D additions:
//   • `focusedIdx` + `onFocusChange` — Composer drives focus via ArrowUp /
//     ArrowDown so the user can cycle without leaving the textarea. Each
//     chip is a real <button>, so the focused chip also accepts native
//     Enter / Space via its own onClick (no extra wiring needed).
//   • Fade-slide animation — `transition-*` classes on row + chips so a new
//     turn's chips ease in instead of popping. `key={text}` on chips means
//     React mounts a fresh node per suggestion, which lets the
//     `motion-safe:animate-in` class re-fire on every push.
import { useEffect, useRef } from "react";
import type { ReactElement } from "react";
import { useTranslation } from "../../../i18n/react.js";

interface Props {
  alternates: string[];
  /** Index of the currently keyboard-focused chip. `null` = no chip focused
   *  (focus lives in the textarea). Composer owns this state so ArrowUp /
   *  ArrowDown can also rotate focus back out of the row. */
  focusedIdx: number | null;
  onAccept: (text: string) => void;
  onFocusChange: (idx: number | null) => void;
}

export function SuggestedRepliesChipRow({
  alternates,
  focusedIdx,
  onAccept,
  onFocusChange,
}: Props): ReactElement | null {
  const { t } = useTranslation();
  // Imperatively move DOM focus when `focusedIdx` changes. Composer drives
  // the index from keyboard events; the chip refs receive `.focus()` here so
  // assistive tech + focus rings stay in sync with the keyboard cursor.
  const chipRefs = useRef<Array<HTMLButtonElement | null>>([]);
  useEffect(() => {
    if (focusedIdx === null) return;
    const el = chipRefs.current[focusedIdx];
    if (el) el.focus();
  }, [focusedIdx]);

  if (alternates.length === 0) return null;
  return (
    <div
      data-testid="suggested-replies-chip-row"
      role="toolbar"
      aria-label={t("suggestedRepliesChipRow.toolbarAriaLabel")}
      className="mx-3 mt-3 mb-1 flex gap-2 overflow-x-auto transition-opacity duration-150 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1"
    >
      {alternates.map((text, idx) => {
        const isFocused = focusedIdx === idx;
        return (
          <button
            key={`${idx}-${text}`}
            ref={(el) => {
              chipRefs.current[idx] = el;
            }}
            type="button"
            data-testid="suggested-replies-chip"
            data-focused={isFocused ? "true" : undefined}
            tabIndex={isFocused ? 0 : -1}
            // Focus ring + background highlight when the keyboard cursor lands
            // on this chip. Hover-on-pointer + focus-on-keyboard are visually
            // distinct (hover = bg-accent, focus = ring + bg-accent) so users
            // can tell where input is going.
            className={
              "shrink-0 rounded-full bg-muted px-3 py-1 text-xs transition-all duration-150 hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring" +
              (isFocused ? " bg-accent ring-2 ring-ring" : "")
            }
            onClick={() => onAccept(text)}
            onFocus={() => onFocusChange(idx)}
            onBlur={(e) => {
              // Only clear focus if focus moved *outside* the row. Tabbing
              // between chips inside the row would otherwise drop the index
              // mid-transition.
              const next = e.relatedTarget as HTMLElement | null;
              if (!next || !next.closest("[data-testid='suggested-replies-chip-row']")) {
                onFocusChange(null);
              }
            }}
          >
            {text}
          </button>
        );
      })}
    </div>
  );
}
