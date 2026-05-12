import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { debugLog, isDebugStreamEnabled } from "../../../lib/debug-stream.js";
import { formatDuration } from "../../../lib/turn-summary-format.js";

interface WorkGroupProps {
  stepCount: number;
  streaming: boolean;
  children: React.ReactNode;
  /**
   * Optional total wall-clock duration of the turn (ms). When provided and
   * the group is not streaming, the header shows `⏱ Tm Ts` next to the
   * step count. Reuses the shared turn-summary `formatDuration` formatter
   * so this label stays consistent with TurnSummaryFooter and per-tool
   * duration labels.
   */
  turnDurationMs?: number;
}

// Monotonic per-instance id so multiple WorkGroups in one turn can be
// distinguished in the debug logs without relying on React internals.
let __wgInstanceCounter = 0;

export function WorkGroup({ stepCount, streaming, children, turnDurationMs }: WorkGroupProps) {
  // Past-turn WorkGroups always receive streaming=false from first render,
  // so they must start closed. Active-turn WorkGroups start open and
  // auto-close when the true→false transition fires in the effect below.
  const debugStreamEnabled = isDebugStreamEnabled();
  const [open, setOpen] = useState(streaming);
  const prevStreaming = useRef(streaming);

  // Diagnostic-only: stable per-instance id (mount-time only). Lets the user
  // correlate "WG[3] mount", "WG[3] render", "WG[3] effect" across logs.
  // Skip allocation + `data-wg-id` attribute when diagnostics are off (#566
  // item 3) — keeps the disabled-mode renderer free of debug-only side
  // effects.
  const idRef = useRef<number | null>(null);
  if (debugStreamEnabled && idRef.current === null) {
    idRef.current = ++__wgInstanceCounter;
  }
  const wgId = idRef.current;

  // Diagnostic: log mount + every unmount.
  useEffect(() => {
    if (debugStreamEnabled) {
      debugLog("WG", "mount", { wgId, streaming, stepCount, openInitial: open });
    }
    return () => {
      if (debugStreamEnabled) debugLog("WG", "unmount", { wgId });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const willCollapse = prevStreaming.current && !streaming;
    if (debugStreamEnabled) {
      debugLog("WG", "effect", {
        wgId,
        streaming,
        prevStreaming: prevStreaming.current,
        open,
        willCollapse,
      });
    }
    if (willCollapse) {
      setOpen(false);
    }
    prevStreaming.current = streaming;
  }, [streaming]);

  // Diagnostic: log every render with the relevant state — surfaces
  // re-renders that come from parent prop changes vs internal state.
  if (debugStreamEnabled) {
    debugLog("WG", "render", { wgId, streaming, open, stepCount });
  }

  return (
    <div className="min-w-0 w-full max-w-full overflow-x-hidden text-xs text-muted-foreground" data-testid="work-group" {...(wgId !== null ? { "data-wg-id": wgId } : {})}>
      <button
        type="button"
        className="flex max-w-full min-w-0 items-center gap-1.5 px-1 py-1 hover:opacity-80"
        onClick={() => {
          if (debugStreamEnabled) {
            debugLog("WG", "click-toggle", { wgId, prevOpen: open });
          }
          setOpen((v) => !v);
        }}
      >
        {streaming
          ? <Loader2 className="h-3 w-3 animate-spin flex-shrink-0" />
          : null}
        <span className="min-w-0 font-medium text-foreground/90">
          {streaming ? "작업 중..." : "작업"}
        </span>
        {/*
          Single-step intermediate entries still render the WorkGroup header
          (this `{stepCount}단계` line + the chevron) for parity with multi-
          step turns — a uniform "작업 N단계" affordance is more discoverable
          than collapsing single-step turns into inline rendering, which would
          remove the expand/collapse UI for half the chat history. Reviewed
          in #565; intentional, not a candidate for inline rendering.
        */}
        {!streaming && <span className="shrink-0 opacity-50">{stepCount}단계</span>}
        {!streaming && turnDurationMs !== undefined && turnDurationMs > 0 && (
          <span className="shrink-0 opacity-50 tabular-nums">⏱ {formatDuration(turnDurationMs)}</span>
        )}
        {!streaming && (
          open
            ? <ChevronDown className="h-3 w-3 flex-shrink-0 opacity-50" />
            : <ChevronRight className="h-3 w-3 flex-shrink-0 opacity-50" />
        )}
      </button>
      {open && (
        <div className="min-w-0 space-y-1.5 pl-1 pt-1 text-foreground">
          {children}
        </div>
      )}
    </div>
  );
}
