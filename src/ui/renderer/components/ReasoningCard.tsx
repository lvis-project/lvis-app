import { Loader2 } from "lucide-react";
import type { ChatEntry } from "../../../lib/chat-stream-state.js";

export function ReasoningCard({ entry }: { entry: Extract<ChatEntry, { kind: "reasoning" }> }) {
  const title = entry.streaming ? "생각 정리 중" : "생각 정리";

  return (
    <div className="max-w-[85%] rounded-md border border-dashed bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
      <div className="mb-1 flex items-center gap-2 text-[11px] text-muted-foreground">
        {title}
        {entry.streaming ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
      </div>
      <div className="whitespace-pre-wrap text-[12px] italic leading-5">
        {entry.text || (entry.streaming ? "생각을 정리하는 중..." : "")}
      </div>
    </div>
  );
}
