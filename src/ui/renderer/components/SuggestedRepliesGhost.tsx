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
//
// PR-D animation: `motion-safe:animate-in fade-in` eases the ghost in when
// a new turn's suggestion arrives. The `transition-opacity` keeps the fade
// smooth when CSS class state flips (e.g. typing → empty). `prefers-
// reduced-motion` opt-outs are honored by Tailwind's `motion-safe:` variant.
import type { ReactElement } from "react";
import { useTranslation } from "../../../i18n/react.js";

interface Props {
  text: string | null;
  visible: boolean;
}

export function SuggestedRepliesGhost({ text, visible }: Props): ReactElement | null {
  const { t } = useTranslation();
  if (!visible || !text) return null;
  return (
    <div
      data-testid="suggested-replies-ghost"
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 flex items-start px-4 py-2 text-body-sm text-input-bar-placeholder transition-opacity duration-(--motion-fast) ease-(--motion-ease-out) motion-safe:animate-in motion-safe:fade-in motion-reduce:transition-none"
    >
      <span className="truncate">{text}</span>
      <span className="ml-auto whitespace-nowrap pl-2 text-micro opacity-70">
        {t("suggestedRepliesGhost.tabToFill")}
      </span>
    </div>
  );
}
