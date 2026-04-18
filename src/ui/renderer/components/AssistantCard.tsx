import { Loader2, Star, RefreshCw, GitBranch } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";
import type { ChatEntry } from "../../../lib/chat-stream-state.js";
import { highlightText } from "../utils/html-preview.js";

export function AssistantCard({
  entry,
  highlightQuery,
  actions,
  isStarred,
}: {
  entry: Extract<ChatEntry, { kind: "assistant" }>;
  highlightQuery?: string;
  actions?: { onRetry?: () => void; onFork?: () => void; onToggleStar?: () => void };
  isStarred?: boolean;
}) {
  const title = entry.streaming ? "LVIS 응답 작성 중" : "LVIS 응답";
  const highlighted = highlightText(entry.text, highlightQuery);
  // Sprint 4.B: rough token estimate for tooltip (~4 chars/token)
  const outputTokens = Math.ceil(entry.text.length / 4);
  return (
    <div className="group relative max-w-[85%] rounded-md border bg-card px-3 py-2 text-sm">
      <div className="mb-1 flex items-center gap-2 text-[11px] text-muted-foreground">
        {title}
        {entry.streaming ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
        {isStarred ? <Star className="h-3 w-3 fill-yellow-400 text-yellow-400" /> : null}
        {!entry.streaming && outputTokens > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="ml-auto cursor-default rounded bg-muted/60 px-1 text-[10px] text-muted-foreground">
                ~{outputTokens >= 1000 ? `${(outputTokens / 1000).toFixed(1)}k` : outputTokens} tok
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">
              <div>출력 토큰(추정): {outputTokens.toLocaleString()}</div>
              <div className="text-muted-foreground">실제값은 감사 로그에서 확인 가능</div>
            </TooltipContent>
          </Tooltip>
        )}
        {actions && !entry.streaming ? (
          <div className="hidden gap-1 group-hover:flex">
            {actions.onRetry && (
              <Tooltip><TooltipTrigger asChild>
                <button className="rounded p-0.5 hover:bg-muted" onClick={actions.onRetry} title="다시 시도 (깊이: high)">
                  <RefreshCw className="h-3 w-3" />
                </button>
              </TooltipTrigger><TooltipContent>다시 시도 (깊이: high)</TooltipContent></Tooltip>
            )}
            {actions.onFork && (
              <button className="rounded p-0.5 hover:bg-muted" onClick={actions.onFork} title="분기"><GitBranch className="h-3 w-3" /></button>
            )}
            {actions.onToggleStar && (
              <button className="rounded p-0.5 hover:bg-muted" onClick={actions.onToggleStar} title="즐겨찾기">
                <Star className={`h-3 w-3 ${isStarred ? "fill-yellow-400 text-yellow-400" : ""}`} />
              </button>
            )}
          </div>
        ) : null}
      </div>

      <div className="prose prose-sm prose-invert max-w-none break-words">
        {highlightQuery && highlighted ? (
          <div className="whitespace-pre-wrap">{highlighted}</div>
        ) : (
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {entry.text || (entry.streaming ? "응답을 작성하는 중..." : "")}
          </ReactMarkdown>
        )}
      </div>
    </div>
  );
}
