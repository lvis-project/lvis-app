import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { debugLog, isDebugStreamEnabled } from "../../../lib/debug-stream.js";

interface WorkGroupProps {
  stepCount: number;
  streaming: boolean;
  children: React.ReactNode;
  /**
   * Optional total wall-clock duration of the turn (ms). When provided and
   * the group is not streaming, the header shows `⏱ Tm Ts` next to the
   * step count. Replaces the standalone TurnSummaryFooter that previously
   * carried this info as a separate row.
   */
  turnDurationMs?: number;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSec = ms / 1000;
  if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec - min * 60;
  return `${min}m ${sec.toFixed(1)}s`;
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

  // Diagnostic: stable per-instance id (mount-time only). Lets the user
  // correlate "WG[3] mount", "WG[3] render", "WG[3] effect" across logs.
  const idRef = useRef<number | null>(null);
  if (idRef.current === null) {
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
    <div className="min-w-0 w-full max-w-full overflow-x-hidden text-xs text-muted-foreground" data-wg-id={wgId}>
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
        <div className="min-w-0 space-y-1.5 pl-1 pt-1">
          {children}
        </div>
      )}
    </div>
  );
}
