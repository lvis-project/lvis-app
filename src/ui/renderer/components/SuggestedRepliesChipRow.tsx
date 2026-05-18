// iOS QuickType-style chip row rendered immediately above the Composer when
// 2+ suggested replies are available. The `best` reply is shown as ghost
// text inside the textarea; this row carries the remaining alternates so
// the user can pick one with a click (PR-B). ↑/↓ cycle is deferred to PR-D.
//
// Spec: `docs/architecture/proposals/suggested-replies-ghost-text.md` §6.1.
import type { ReactElement } from "react";

interface Props {
  alternates: string[];
  onAccept: (text: string) => void;
}

export function SuggestedRepliesChipRow({ alternates, onAccept }: Props): ReactElement | null {
  if (alternates.length === 0) return null;
  return (
    <div
      data-testid="suggested-replies-chip-row"
      role="toolbar"
      aria-label="대체 답변 추천"
      className="mx-3 mb-1 flex gap-2 overflow-x-auto"
    >
      {alternates.map((text) => (
        <button
          key={text}
          type="button"
          data-testid="suggested-replies-chip"
          className="shrink-0 rounded-full bg-muted px-3 py-1 text-xs hover:bg-accent"
          onClick={() => onAccept(text)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}
