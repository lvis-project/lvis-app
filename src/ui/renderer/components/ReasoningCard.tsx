import { useEffect, useRef, useState } from "react";
import { Brain, ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import type { ChatEntry } from "../../../lib/chat-stream-state.js";

/**
 * Thinking card. Two modes:
 *   - streaming=true   → always expanded, shows live reasoning deltas with a
 *     spinner. Header click is disabled.
 *   - streaming=false  → auto-collapses once (on the true→false transition)
 *     so completed reasoning doesn't clutter the conversation; user can click
 *     the header to re-expand the captured thought. Mirrors ToolGroupCard's
 *     "expand to inspect the result" pattern.
 *   - embedded=true    → rendered inside an already-collapsible WorkGroup, so
 *     the reasoning body stays visible when that outer group is open.
 *
 * A ref-based one-shot guard ensures the auto-collapse only fires on the
 * transition — re-renders after the user has re-opened it do not snap it shut
 * again.
 */
export function ReasoningCard({
  entry,
  embedded = false,
}: {
  entry: Extract<ChatEntry, { kind: "reasoning" }>;
  embedded?: boolean;
}) {
  const streaming = entry.streaming === true;
  // Initial open state mirrors streaming: live turns start expanded so deltas
  // are visible, already-complete entries (session history reload, non-
  // streaming rehydrated turns) start collapsed — otherwise the auto-collapse
  // effect below never runs for them (no streaming→done edge) and every past
  // reasoning block in history would render fully expanded.
  const [open, setOpen] = useState(streaming || embedded);
  const wasStreamingRef = useRef(streaming);

  useEffect(() => {
    if (!embedded && wasStreamingRef.current && !streaming) {
      // streaming just finished — collapse once. Subsequent user re-expands
      // remain untouched because wasStreamingRef.current is now false and this
      // branch can no longer trigger.
      setOpen(false);
    }
    wasStreamingRef.current = streaming;
  }, [streaming]);

  const title = streaming ? "생각 중..." : "생각 완료";
  const bodyVisible = streaming || open || embedded;
  const approxTokens = !streaming && entry.text
    ? Math.max(1, Math.ceil(entry.text.length / 4))
    : 0;

  return (
    <div className={`${embedded ? "w-full" : "max-w-[85%]"} rounded-md text-sm text-muted-foreground`}>
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-1.5 text-[11px] text-muted-foreground hover:bg-muted/30 disabled:cursor-default disabled:hover:bg-transparent"
        onClick={() => {
          if (streaming || embedded) return;
          setOpen((o) => !o);
        }}
        disabled={streaming || embedded}
        aria-expanded={bodyVisible}
      >
        {streaming
          ? <Loader2 className="h-3 w-3 flex-shrink-0 animate-spin" />
          : <Brain className="h-3 w-3 flex-shrink-0" />}
        <span className="font-medium">{title}</span>
        {approxTokens > 0 && (
          <span className="rounded bg-muted/60 px-1 text-[10px] text-muted-foreground">
            ~{approxTokens >= 1000 ? `${(approxTokens / 1000).toFixed(1)}k` : approxTokens} tok
          </span>
        )}
        {!streaming && !embedded && (
          <span className="ml-auto">
            {bodyVisible
              ? <ChevronDown className="h-3 w-3 flex-shrink-0" />
              : <ChevronRight className="h-3 w-3 flex-shrink-0" />}
          </span>
        )}
      </button>
      {bodyVisible && (
        <div className="whitespace-pre-wrap border-l-2 border-muted ml-3 pl-3 py-1 text-[11px] italic leading-5 text-muted-foreground/80">
          {entry.text || (streaming ? "생각하는 중..." : "")}
        </div>
      )}
    </div>
  );
}
