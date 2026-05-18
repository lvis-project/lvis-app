// Ghost-text overlay rendered on top of the Composer textarea when (a) the
// textarea body is empty, (b) a `best` suggested reply is available, and
// (c) the user has not dismissed the current snapshot.
//
// The parent (Composer) owns positioning context: this component renders an
// absolute-positioned layer that visually aligns with the textarea text.
// `pointer-events-none` keeps clicks falling through to the textarea so
// focus / caret behavior is unchanged.
//
// Spec: `docs/architecture/proposals/suggested-replies-ghost-text.md` §6.1.
import type { ReactElement } from "react";

interface Props {
  text: string | null;
  visible: boolean;
}

export function SuggestedRepliesGhost({ text, visible }: Props): ReactElement | null {
  if (!visible || !text) return null;
  return (
    <div
      data-testid="suggested-replies-ghost"
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 flex items-start px-4 py-2 text-xs text-muted-foreground/60"
    >
      <span className="truncate">{text}</span>
      <span className="ml-auto whitespace-nowrap pl-2 text-[10px] opacity-70">
        Tab to fill
      </span>
    </div>
  );
}
