import { RefreshCw, GitBranch, Star, ThumbsUp, ThumbsDown } from "lucide-react";
import { useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";

export function TurnActionBar({
  turnTokens,
  isStarred,
  actions,
  onFeedback,
}: {
  turnTokens?: number;
  isStarred?: boolean;
  actions?: { onRetry?: () => void; onFork?: () => void; onToggleStar?: () => void };
  onFeedback?: (rating: "up" | "down", reason?: string) => void | Promise<void>;
}) {
  const [feedbackRating, setFeedbackRating] = useState<"up" | "down" | null>(null);
  const [showReasonBox, setShowReasonBox] = useState(false);
  const [reasonDraft, setReasonDraft] = useState("");

  const [timestamp] = useState(() => new Date().toLocaleString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }));

  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground/60 mt-0.5 px-1">
      <span className="shrink-0">{timestamp}</span>
      {turnTokens && turnTokens > 0 ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="cursor-default rounded bg-muted/40 px-1 text-[10px]">
              ~{turnTokens >= 1000 ? `${(turnTokens / 1000).toFixed(1)}k` : turnTokens} tok
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            <div>이번 턴 전체 토큰(추정): {turnTokens.toLocaleString()}</div>
            <div className="text-muted-foreground">실제값은 감사 로그에서 확인 가능</div>
          </TooltipContent>
        </Tooltip>
      ) : null}
      <div className="flex-1" />
      {actions?.onRetry && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button className="rounded p-0.5 hover:bg-muted hover:text-foreground transition-colors" title="다시 시도 (깊이: high)" onClick={actions.onRetry}>
              <RefreshCw className="h-3 w-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent>다시 시도 (깊이: high)</TooltipContent>
        </Tooltip>
      )}
      {actions?.onFork && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button className="rounded p-0.5 hover:bg-muted hover:text-foreground transition-colors" onClick={actions.onFork}>
              <GitBranch className="h-3 w-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent>분기</TooltipContent>
        </Tooltip>
      )}
      {actions?.onToggleStar && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button className="rounded p-0.5 hover:bg-muted hover:text-foreground transition-colors" onClick={actions.onToggleStar}>
              <Star className={`h-3 w-3 ${isStarred ? "fill-yellow-400 text-yellow-400" : ""}`} />
            </button>
          </TooltipTrigger>
          <TooltipContent>즐겨찾기</TooltipContent>
        </Tooltip>
      )}
      {onFeedback ? (
        <>
          <span className="text-muted-foreground/30">|</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className={`rounded p-0.5 hover:bg-muted transition-colors ${feedbackRating === "up" ? "text-green-500" : "hover:text-foreground"}`}
                onClick={() => {
                  if (feedbackRating === "up") return;
                  setFeedbackRating("up");
                  setShowReasonBox(false);
                  void onFeedback("up");
                }}
                aria-label="도움이 됐어요"
              >
                <ThumbsUp className={`h-3 w-3 ${feedbackRating === "up" ? "fill-green-500" : ""}`} />
              </button>
            </TooltipTrigger>
            <TooltipContent>도움이 됐어요</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className={`rounded p-0.5 hover:bg-muted transition-colors ${feedbackRating === "down" ? "text-red-500" : "hover:text-foreground"}`}
                onClick={() => {
                  if (feedbackRating === "down") return;
                  setShowReasonBox(true);
                }}
                aria-label="개선이 필요해요"
              >
                <ThumbsDown className={`h-3 w-3 ${feedbackRating === "down" ? "fill-red-500" : ""}`} />
              </button>
            </TooltipTrigger>
            <TooltipContent>개선이 필요해요</TooltipContent>
          </Tooltip>
          {showReasonBox && feedbackRating !== "down" ? (
            <div className="flex items-center gap-1">
              <input
                type="text"
                maxLength={200}
                placeholder="이유 (선택)"
                value={reasonDraft}
                onChange={(e) => setReasonDraft(e.target.value)}
                className="h-6 rounded border border-input bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring w-36"
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
        </>
      ) : null}
    </div>
  );
}
