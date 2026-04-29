import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";

interface WorkGroupProps {
  stepCount: number;
  streaming: boolean;
  children: React.ReactNode;
}

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
    <div className="max-w-[85%] text-xs text-muted-foreground">
      <button
        className="flex items-center gap-1.5 px-1 py-1 hover:opacity-80"
        onClick={() => setOpen((v) => !v)}
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
