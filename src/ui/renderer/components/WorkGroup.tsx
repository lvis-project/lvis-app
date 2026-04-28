import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";

interface WorkGroupProps {
  stepCount: number;
  streaming: boolean;
  children: React.ReactNode;
}

/**
 * Collapsible wrapper for intermediate turn entries (reasoning + tool groups + non-final assistant).
 * Auto-collapses when streaming transitions from true to false.
 */
export function WorkGroup({ stepCount, streaming, children }: WorkGroupProps) {
  const [open, setOpen] = useState(true);
  const prevStreaming = useRef(streaming);

  useEffect(() => {
    if (prevStreaming.current && !streaming) {
      setOpen(false);
    }
    prevStreaming.current = streaming;
  }, [streaming]);

  return (
    <div className="max-w-[85%] rounded-md border border-dashed text-xs text-muted-foreground">
      <button
        className="flex w-full items-center gap-2 px-3 py-1.5 hover:bg-muted/30"
        onClick={() => setOpen((v) => !v)}
      >
        {streaming ? (
          <Loader2 className="h-3 w-3 animate-spin flex-shrink-0" />
        ) : (
          open ? <ChevronDown className="h-3 w-3 flex-shrink-0" /> : <ChevronRight className="h-3 w-3 flex-shrink-0" />
        )}
        <span className="font-medium">작업 {stepCount}단계</span>
        {!streaming && (
          <span className="text-[10px] opacity-60">{open ? "접기" : "펼치기"}</span>
        )}
      </button>
      {open && (
        <div className="border-t px-2 py-1.5 space-y-2">
          {children}
        </div>
      )}
    </div>
  );
}
