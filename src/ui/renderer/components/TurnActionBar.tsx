import { RefreshCw, GitBranch, Star, ThumbsUp, ThumbsDown } from "lucide-react";
import { useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";
import { TokenCostBadge, type TokenCostBadgePricing, type TokenCostBadgeProps } from "./TokenCostBadge.js";
import type { LLMVendor } from "../../../shared/llm-vendor-defaults.js";

/**
 * Turn-aggregate provider-reported token usage forwarded to the inline
 * <TokenCostBadge>. Subset of TokenCostBadgeProps (pricing 은 별 prop).
 */
export type TurnSummaryForBadge = Pick<
  TokenCostBadgeProps,
  "tokensIn" | "freshInputTokens" | "tokensOut" | "cacheReadTokens" | "cacheWriteTokens"
>;

export function TurnActionBar({
  turnSummary,
  pricing,
  vendor,
  isStarred,
  actions,
  onFeedback,
}: {
  turnSummary?: TurnSummaryForBadge;
  pricing?: TokenCostBadgePricing;
  /** Active vendor — selects cache-cost branching in TokenCostBadge. */
  vendor?: LLMVendor;
  isStarred?: boolean;
  actions?: { onRetry?: () => void; onFork?: () => void; onToggleStar?: () => void };
  onFeedback?: (rating: "up" | "down", reason?: string) => void | Promise<void>;
}) {
  const [feedbackRating, setFeedbackRating] = useState<"up" | "down" | null>(null);
  const [showReasonBox, setShowReasonBox] = useState(false);
  const [reasonDraft, setReasonDraft] = useState("");

  const [timestamp] = useState(() => new Date().toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
  }));

  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5 px-3">
      <span className="shrink-0">{timestamp}</span>
      {turnSummary ? <TokenCostBadge {...turnSummary} pricing={pricing} vendor={vendor} /> : null}
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
              <Star key={isStarred ? "on" : "off"} className={`h-3 w-3 ${isStarred ? "fill-emphasis text-emphasis lvis-anim-star" : ""}`} />
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
                className={`rounded p-0.5 hover:bg-muted transition-colors ${feedbackRating === "up" ? "text-success" : "hover:text-foreground"}`}
                onClick={() => {
                  if (feedbackRating === "up") return;
                  setFeedbackRating("up");
                  setShowReasonBox(false);
                  void onFeedback("up");
                }}
                aria-label="도움이 됐어요"
              >
                <ThumbsUp key={feedbackRating === "up" ? "on" : "off"} className={`h-3 w-3 ${feedbackRating === "up" ? "fill-success lvis-anim-pop" : ""}`} />
              </button>
            </TooltipTrigger>
            <TooltipContent>도움이 됐어요</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className={`rounded p-0.5 hover:bg-muted transition-colors ${feedbackRating === "down" ? "text-destructive" : "hover:text-foreground"}`}
                onClick={() => {
                  if (feedbackRating === "down") return;
                  setShowReasonBox(true);
                }}
                aria-label="개선이 필요해요"
              >
                <ThumbsDown key={feedbackRating === "down" ? "on" : "off"} className={`h-3 w-3 ${feedbackRating === "down" ? "fill-destructive lvis-anim-pop" : ""}`} />
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
