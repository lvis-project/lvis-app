import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { debugLog } from "../../../lib/debug-stream.js";

interface WorkGroupProps {
  stepCount: number;
  streaming: boolean;
  children: React.ReactNode;
}

// Monotonic per-instance id so multiple WorkGroups in one turn can be
// distinguished in the debug logs without relying on React internals.
let __wgInstanceCounter = 0;

export function WorkGroup({ stepCount, streaming, children }: WorkGroupProps) {
  // Past-turn WorkGroups always receive streaming=false from first render,
  // so they must start closed. Active-turn WorkGroups start open and
  // auto-close when the true→false transition fires in the effect below.
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
    debugLog("WG", "mount", { wgId, streaming, stepCount, openInitial: open });
    return () => {
      debugLog("WG", "unmount", { wgId });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const willCollapse = prevStreaming.current && !streaming;
    debugLog("WG", "effect", {
      wgId,
      streaming,
      prevStreaming: prevStreaming.current,
      open,
      willCollapse,
    });
    if (willCollapse) {
      setOpen(false);
    }
    prevStreaming.current = streaming;
  }, [streaming]);

  // Diagnostic: log every render with the relevant state — surfaces
  // re-renders that come from parent prop changes vs internal state.
  debugLog("WG", "render", { wgId, streaming, open, stepCount });

  return (
    <div className="max-w-[85%] text-xs text-muted-foreground" data-wg-id={wgId}>
      <button
        type="button"
        className="flex items-center gap-1.5 px-1 py-1 hover:opacity-80"
        onClick={() => {
          debugLog("WG", "click-toggle", { wgId, prevOpen: open });
          setOpen((v) => !v);
        }}
      >
        {streaming
          ? <Loader2 className="h-3 w-3 animate-spin flex-shrink-0" />
          : null}
        <span className="font-medium text-foreground/90">작업</span>
        <span className="opacity-50">{stepCount}단계</span>
        {!streaming && (
          open
            ? <ChevronDown className="h-3 w-3 flex-shrink-0 opacity-50" />
            : <ChevronRight className="h-3 w-3 flex-shrink-0 opacity-50" />
        )}
      </button>
      {open && (
        <div className="pl-1 space-y-1.5 pt-1">
          {children}
        </div>
      )}
    </div>
  );
}
