import { Copy, Check, RefreshCw, GitBranch, Star, ThumbsUp, ThumbsDown } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Button } from "../../../components/ui/button.js";
import { Input } from "../../../components/ui/input.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";
import { Popover, PopoverContent, PopoverTrigger } from "../../../components/ui/popover.js";
import { TokenCostBadge, type TokenCostBadgePricing, type TokenCostBadgeProps } from "./TokenCostBadge.js";
import type { LLMVendor } from "../../../shared/llm-vendor-defaults.js";
import { formatHhMmKst } from "../utils/format-time.js";
import { useTranslation } from "../../../i18n/react.js";

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
  copyText,
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
  /**
   * Plain text of this turn's assistant message (the same cleaned text the
   * user sees rendered). When provided, a leading Copy button writes it to
   * the clipboard. Omitted in view-mode / when there is nothing to copy.
   */
  copyText?: string;
  actions?: { onRetry?: () => void; onFork?: () => void; onToggleStar?: () => void };
  onFeedback?: (rating: "up" | "down", reason?: string) => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const [feedbackRating, setFeedbackRating] = useState<"up" | "down" | null>(null);
  const [showReasonBox, setShowReasonBox] = useState(false);
  const [reasonDraft, setReasonDraft] = useState("");
  const [copied, setCopied] = useState(false);
  const copyResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCopy = () => {
    const text = copyText ?? "";
    if (!text) return;
    void navigator.clipboard.writeText(text);
    setCopied(true);
    if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
    copyResetTimer.current = setTimeout(() => setCopied(false), 1500);
  };

  // Centralized KST formatter — keeps wall-clock display stable regardless of
  // the host OS timezone.
  const timestampLabel = useMemo(() => formatHhMmKst(timestamp), [timestamp]);

  return (
    <div className="flex items-center gap-1 text-xs text-muted-foreground mt-0.5 px-3">
      {timestampLabel ? <span className="shrink-0">{timestampLabel}</span> : null}
      {turnSummary ? <TokenCostBadge {...turnSummary} pricing={pricing} vendor={vendor} /> : null}
      <div className="flex-1" />
      {copyText ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={`h-5 w-5 ${copied ? "text-success" : "text-muted-foreground hover:text-foreground"}`}
              title={t("turnActionBar.copyButton")}
              aria-label={t("turnActionBar.copyButton")}
              onClick={handleCopy}
            >
              {copied ? (
                <Check key="on" className="h-3 w-3 lvis-anim-pop" />
              ) : (
                <Copy key="off" className="h-3 w-3" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("turnActionBar.copyButton")}</TooltipContent>
        </Tooltip>
      ) : null}
      {actions?.onRetry && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-5 w-5 text-muted-foreground hover:text-foreground"
              title={t("turnActionBar.retryButton")}
              onClick={actions.onRetry}
            >
              <RefreshCw className="h-3 w-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("turnActionBar.retryButton")}</TooltipContent>
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
          <TooltipContent>{t("turnActionBar.forkButton")}</TooltipContent>
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
          <TooltipContent>{t("turnActionBar.starButton")}</TooltipContent>
        </Tooltip>
      )}
      {onFeedback ? (
        <>
          <span className="text-muted-foreground/(--opacity-muted)">|</span>
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
                aria-label={t("turnActionBar.feedbackUp")}
              >
                <ThumbsUp key={feedbackRating === "up" ? "on" : "off"} className={`h-3 w-3 ${feedbackRating === "up" ? "fill-success lvis-anim-pop" : ""}`} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("turnActionBar.feedbackUp")}</TooltipContent>
          </Tooltip>
          {/* Dislike + reason POPOVER: the reason input floats ABOVE the 👎
              button (side="top", Radix collision-aware) instead of appending
              inline to the row, so it never overflows off-screen. */}
          <Popover
            open={showReasonBox && feedbackRating !== "down"}
            onOpenChange={(open) => {
              if (open && feedbackRating === "down") return;
              setShowReasonBox(open);
              if (!open) setReasonDraft("");
            }}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className={`h-5 w-5 ${feedbackRating === "down" ? "text-destructive" : "text-muted-foreground hover:text-foreground"}`}
                    aria-label={t("turnActionBar.feedbackDown")}
                  >
                    <ThumbsDown key={feedbackRating === "down" ? "on" : "off"} className={`h-3 w-3 ${feedbackRating === "down" ? "fill-destructive lvis-anim-pop" : ""}`} />
                  </Button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent>{t("turnActionBar.feedbackDown")}</TooltipContent>
            </Tooltip>
            <PopoverContent
              side="top"
              align="end"
              className="flex w-auto items-center gap-1 p-2"
              data-testid="turn-feedback-reason-popover"
            >
              <Input
                type="text"
                maxLength={200}
                placeholder={t("turnActionBar.reasonPlaceholder")}
                value={reasonDraft}
                onChange={(e) => setReasonDraft(e.target.value)}
                className="h-6 w-36 px-2 text-xs"
                autoFocus
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
                {t("turnActionBar.sendButton")}
              </Button>
            </PopoverContent>
          </Popover>
        </>
      ) : null}
    </div>
  );
}
