import { Loader2, Star, RefreshCw, GitBranch, ThumbsUp, ThumbsDown } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";
import type { ChatEntry } from "../../../lib/chat-stream-state.js";
import { highlightText } from "../utils/html-preview.js";
import { clampDanglingMarkdownLink } from "../utils/streaming-markdown.js";

export function AssistantCard({
  entry,
  highlightQuery,
  actions,
  isStarred,
  onFeedback,
  isFinal = true,
  turnTokens,
}: {
  entry: Extract<ChatEntry, { kind: "assistant" }>;
  highlightQuery?: string;
  actions?: { onRetry?: () => void; onFork?: () => void; onToggleStar?: () => void };
  isStarred?: boolean;
  onFeedback?: (rating: "up" | "down", reason?: string) => void | Promise<void>;
  isFinal?: boolean;
  turnTokens?: number;
}) {
  const [feedbackRating, setFeedbackRating] = useState<"up" | "down" | null>(null);
  const [showReasonBox, setShowReasonBox] = useState(false);
  const [reasonDraft, setReasonDraft] = useState("");
  const title = entry.streaming ? "LVIS 응답 작성 중" : "LVIS 응답";
  const highlighted = highlightText(entry.text, highlightQuery);
  // Sprint 4.B: rough token estimate for tooltip (~4 chars/token)
  const outputTokens = Math.ceil(entry.text.length / 4);
  return (
    <div className="group relative max-w-[85%] rounded-md px-3 py-2 text-sm">
      {(actions !== undefined || isFinal !== false) && (
        <div className="mb-1 flex items-center gap-2 text-[11px] text-muted-foreground">
          {title}
          {entry.streaming ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          {isStarred ? <Star className="h-3 w-3 fill-yellow-400 text-yellow-400" /> : null}
          {!entry.streaming && (isFinal && turnTokens && turnTokens > 0 ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="ml-auto cursor-default rounded bg-muted/60 px-1 text-[10px] text-muted-foreground">
                  ~{turnTokens >= 1000 ? `${(turnTokens / 1000).toFixed(1)}k` : turnTokens} tok
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs">
                <div>이번 턴 전체 토큰(추정): {turnTokens.toLocaleString()}</div>
                <div className="text-muted-foreground">실제값은 감사 로그에서 확인 가능</div>
              </TooltipContent>
            </Tooltip>
          ) : outputTokens > 0 ? (
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
          ) : null)}
          {actions && !entry.streaming ? (
            <div className={`gap-1 ${isFinal !== false ? "flex" : "hidden group-hover:flex"}`}>
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
      )}

      <div className="prose prose-sm prose-invert max-w-none break-words">
        {highlightQuery && highlighted ? (
          <div className="whitespace-pre-wrap">{highlighted}</div>
        ) : (
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {entry.streaming
              ? clampDanglingMarkdownLink(entry.text) || "응답을 작성하는 중..."
              : (entry.text || "")}
          </ReactMarkdown>
        )}
      </div>

      {!entry.streaming && onFeedback ? (
        <div className="mt-1.5 flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className={`rounded p-0.5 hover:bg-muted transition-colors ${feedbackRating === "up" ? "text-green-500" : "text-muted-foreground"}`}
                onClick={() => {
                  if (feedbackRating === "up") return;
                  setFeedbackRating("up");
                  setShowReasonBox(false);
                  void onFeedback("up");
                }}
                aria-label="도움이 됐어요"
              >
                <ThumbsUp className={`h-3.5 w-3.5 ${feedbackRating === "up" ? "fill-green-500" : ""}`} />
              </button>
            </TooltipTrigger>
            <TooltipContent>도움이 됐어요</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className={`rounded p-0.5 hover:bg-muted transition-colors ${feedbackRating === "down" ? "text-red-500" : "text-muted-foreground"}`}
                onClick={() => {
                  if (feedbackRating === "down") return;
                  setShowReasonBox(true);
                }}
                aria-label="개선이 필요해요"
              >
                <ThumbsDown className={`h-3.5 w-3.5 ${feedbackRating === "down" ? "fill-red-500" : ""}`} />
              </button>
            </TooltipTrigger>
            <TooltipContent>개선이 필요해요</TooltipContent>
          </Tooltip>
          {showReasonBox && feedbackRating !== "down" ? (
            <div className="ml-1 flex items-center gap-1">
              <input
                type="text"
                maxLength={200}
                placeholder="이유 (선택)"
                value={reasonDraft}
                onChange={(e) => setReasonDraft(e.target.value)}
                className="h-6 rounded border border-input bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring w-40"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    setFeedbackRating("down");
                    setShowReasonBox(false);
                    void onFeedback("down", reasonDraft.trim() || undefined);
                  } else if (e.key === "Escape") {
                    setShowReasonBox(false);
                    setReasonDraft("");
                  }
                }}
              />
              <button
                className="rounded px-1.5 py-0.5 text-xs bg-muted hover:bg-muted/80"
                onClick={() => {
                  setFeedbackRating("down");
                  setShowReasonBox(false);
                  void onFeedback("down", reasonDraft.trim() || undefined);
                }}
              >
                전송
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
