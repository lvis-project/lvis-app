import { useState } from "react";
import { Brain, ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import type { ChatEntry } from "../../../lib/chat-stream-state.js";
import { useTranslation } from "../../../i18n/react.js";

/**
 * Thinking card. Always starts COLLAPSED — including while the model is still
 * streaming reasoning. The folded state shows just the header (a spinner +
 * "thinking…" title while streaming, a brain + "thought" title once done); the
 * reasoning body is revealed ONLY when the user clicks the header. This keeps
 * live reasoning from auto-expanding and cluttering the conversation; the user
 * opts in to read it. (Previously it auto-expanded during streaming and
 * auto-collapsed on completion.)
 */
export function ReasoningCard({
  entry,
}: {
  entry: Extract<ChatEntry, { kind: "reasoning" }>;
}) {
  const { t } = useTranslation();
  const streaming = entry.streaming === true;
  // Always collapsed by default — even while streaming. Expands only on click.
  const [open, setOpen] = useState(false);

  const title = streaming ? t("reasoningCard.thinkingTitle") : t("reasoningCard.thoughtCompleteTitle");
  const bodyVisible = open;

  return (
    <div className="min-w-0 w-full max-w-full rounded-md text-sm text-muted-foreground lvis-anim-message-in">
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-[11px] text-muted-foreground hover:bg-muted/(--opacity-muted)"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={bodyVisible}
      >
        {streaming
          ? <Loader2 className="h-3 w-3 flex-shrink-0 animate-spin" />
          : <Brain className="h-3 w-3 flex-shrink-0" />}
        <span className="min-w-0 font-medium">{title}</span>
        {/* Chevron always shown (even while streaming) so the folded block reads
            as expandable. */}
        <span className="shrink-0">
          {bodyVisible
            ? <ChevronDown className="h-3 w-3 flex-shrink-0" />
            : <ChevronRight className="h-3 w-3 flex-shrink-0" />}
        </span>
      </button>
      {bodyVisible && (
        <div className="ml-3 min-w-0 whitespace-pre-wrap break-words border-l-2 border-muted py-1 pl-3 text-[11px] italic leading-5 text-muted-foreground/(--opacity-intense) [overflow-wrap:anywhere] lvis-anim-fade-in">
          {entry.text || (streaming ? t("reasoningCard.thinkingBody") : "")}
        </div>
      )}
    </div>
  );
}
