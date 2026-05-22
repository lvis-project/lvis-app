import { RefreshCw, GitBranch, Star, ThumbsUp, ThumbsDown } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "../../../components/ui/button.js";
import { Input } from "../../../components/ui/input.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";
import { TokenCostBadge, type TokenCostBadgePricing, type TokenCostBadgeProps } from "./TokenCostBadge.js";
import type { LLMVendor } from "../../../shared/llm-vendor-defaults.js";
import { formatHhMmKst } from "../utils/format-time.js";

/**
 * Turn-aggregate provider-reported token usage forwarded to the inline
 * <TokenCostBadge>. Subset of TokenCostBadgeProps (pricing 은 별 prop).
 */
export type TurnSummaryForBadge = Pick<
  TokenCostBadgeProps,
  "tokensIn" | "freshInputTokens" | "tokensOut" | "cacheReadTokens" | "cacheWriteTokens" | "usageByModel"
>;

export function TurnActionBar({
  timestamp,
  turnSummary,
  pricing,
  vendor,
  isStarred,
  actions,
  onFeedback,
}: {
  /**
   * Wall-clock epoch ms when this turn's assistant message was created.
   * Sourced from `ChatEntry.createdAt` (persisted on the assistant message's
   * meta and propagated through historyToEntries). Undefined for legacy
   * sessions written before per-message timestamps were stored — those
   * render WITHOUT a time stamp (CLAUDE.md "No Fallback Code": better to
   * show nothing than fake the load time as the original turn time).
   */
  timestamp?: number;
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

  // Centralized KST formatter — keeps wall-clock display consistent between
  // TurnActionBar and SessionCalendarPopover regardless of OS timezone.
  const timestampLabel = useMemo(() => formatHhMmKst(timestamp), [timestamp]);

  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5 px-3">
      {timestampLabel ? <span className="shrink-0">{timestampLabel}</span> : null}
      {turnSummary ? <TokenCostBadge {...turnSummary} pricing={pricing} vendor={vendor} /> : null}
      <div className="flex-1" />
      {actions?.onRetry && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-5 w-5 text-muted-foreground hover:text-foreground"
              title="다시 시도 (깊이: high)"
              onClick={actions.onRetry}
            >
              <RefreshCw className="h-3 w-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>다시 시도 (깊이: high)</TooltipContent>
        </Tooltip>
      )}
      {actions?.onFork && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-5 w-5 text-muted-foreground hover:text-foreground"
              onClick={actions.onFork}
            >
              <GitBranch className="h-3 w-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>분기</TooltipContent>
        </Tooltip>
      )}
      {actions?.onToggleStar && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-5 w-5 text-muted-foreground hover:text-foreground"
              onClick={actions.onToggleStar}
            >
              <Star key={isStarred ? "on" : "off"} className={`h-3 w-3 ${isStarred ? "fill-emphasis text-emphasis lvis-anim-star" : ""}`} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>즐겨찾기</TooltipContent>
        </Tooltip>
      )}
      {onFeedback ? (
        <>
          <span className="text-muted-foreground/30">|</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={`h-5 w-5 ${feedbackRating === "up" ? "text-success" : "text-muted-foreground hover:text-foreground"}`}
                onClick={() => {
                  if (feedbackRating === "up") return;
                  setFeedbackRating("up");
                  setShowReasonBox(false);
                  void onFeedback("up");
                }}
                aria-label="도움이 됐어요"
              >
                <ThumbsUp key={feedbackRating === "up" ? "on" : "off"} className={`h-3 w-3 ${feedbackRating === "up" ? "fill-success lvis-anim-pop" : ""}`} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>도움이 됐어요</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={`h-5 w-5 ${feedbackRating === "down" ? "text-destructive" : "text-muted-foreground hover:text-foreground"}`}
                onClick={() => {
                  if (feedbackRating === "down") return;
                  setShowReasonBox(true);
                }}
                aria-label="개선이 필요해요"
              >
                <ThumbsDown key={feedbackRating === "down" ? "on" : "off"} className={`h-3 w-3 ${feedbackRating === "down" ? "fill-destructive lvis-anim-pop" : ""}`} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>개선이 필요해요</TooltipContent>
          </Tooltip>
          {showReasonBox && feedbackRating !== "down" ? (
            <div className="flex items-center gap-1">
              <Input
                type="text"
                maxLength={200}
                placeholder="이유 (선택)"
                value={reasonDraft}
                onChange={(e) => setReasonDraft(e.target.value)}
                className="h-6 w-36 px-2 text-xs"
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
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() => {
                  setFeedbackRating("down");
                  setShowReasonBox(false);
                  void onFeedback("down", reasonDraft.trim() || undefined);
                }}
              >
                전송
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
