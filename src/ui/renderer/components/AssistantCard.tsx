import { Loader2, Star, RefreshCw, GitBranch, ThumbsUp, ThumbsDown, AlertTriangle } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { memo, useMemo, useState } from "react";
import { useTranslation } from "../../../i18n/react.js";
import { Button } from "../../../components/ui/button.js";
import { Input } from "../../../components/ui/input.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";
import type { ChatEntry } from "../../../lib/chat-stream-state.js";
import { clampDanglingMarkdownLink } from "../utils/streaming-markdown.js";
import { MARKDOWN_REMARK_PLUGINS } from "../utils/markdown-plugins.js";
import { replaceToolNamesInText } from "../utils/tool-display.js";
import { detectFromStream } from "../../../lib/stream-markers.js";

function AssistantCardImpl({
  entry,
  actions,
  isStarred,
  onFeedback,
  isFinal = true,
}: {
  entry: Extract<ChatEntry, { kind: "assistant" }>;
  actions?: { onRetry?: () => void; onFork?: () => void; onToggleStar?: () => void };
  isStarred?: boolean;
  onFeedback?: (rating: "up" | "down", reason?: string) => void | Promise<void>;
  isFinal?: boolean;
}) {
  const { t } = useTranslation();
  const [feedbackRating, setFeedbackRating] = useState<"up" | "down" | null>(null);
  const [showReasonBox, setShowReasonBox] = useState(false);
  const [reasonDraft, setReasonDraft] = useState("");
  // Issue #911 — host-emitted system notice (context-error / stream-error)
  // gets destructive styling + a "시스템 알림" header so the user can
  // distinguish a real LLM reply from an error banner masquerading as one.
  const isSystemNotice = entry.systemNotice !== undefined;
  const systemNoticeLabel =
    entry.systemNotice === "context-error"
      ? t("assistantCard.systemNoticeContextError")
      : entry.systemNotice === "stream-error"
        ? t("assistantCard.systemNoticeStreamError")
        : t("assistantCard.systemNotice");
  const title = isSystemNotice
    ? systemNoticeLabel
    : entry.streaming
      ? t("assistantCard.titleStreaming")
      : t("assistantCard.title");
  const displayText = useMemo(() => detectFromStream(entry.text || "").cleanedText, [entry.text]);
  const renderedText = useMemo(() => replaceToolNamesInText(displayText), [displayText]);
  const markdownText = entry.route === "command" ? preserveCommandLineBreaks(renderedText) : renderedText;
  // chars/4 token estimate 제거 (2026-05-07): TurnActionBar 의 TokenCostBadge
  // 가 provider-reported 값을 단일 source 로 표시. 카드 헤더의 ~tok 배지는
  // 한국어 2-3× under-estimate 거짓 정보였음.
  return (
    <div
      className={
        isSystemNotice
          ? "group relative min-w-0 w-full max-w-full overflow-visible rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm lvis-anim-message-in"
          : "group relative min-w-0 w-full max-w-full overflow-visible rounded-md px-3 py-2 text-sm lvis-anim-message-in"
      }
    >
      {(actions !== undefined || entry.streaming || isSystemNotice) && (
        <div
          className={
            isSystemNotice
              ? "mb-1 flex items-center gap-2 text-[11px] font-semibold text-destructive"
              : "mb-1 flex items-center gap-2 text-[11px] text-muted-foreground"
          }
        >
          {isSystemNotice ? <AlertTriangle className="h-3 w-3" /> : null}
          {title}
          {entry.streaming ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          {isStarred ? <Star key="starred" className="h-3 w-3 fill-emphasis text-emphasis lvis-anim-star" /> : null}
          {actions && !entry.streaming ? (
            <div className={`ml-auto gap-1 ${isFinal !== false ? "flex" : "hidden group-hover:flex"}`}>
              {actions.onRetry && (
                <Tooltip><TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-5 w-5 text-muted-foreground hover:text-foreground"
                    onClick={actions.onRetry}
                    title={t("assistantCard.retryButton")}
                  >
                    <RefreshCw className="h-3 w-3" />
                  </Button>
                </TooltipTrigger><TooltipContent>{t("assistantCard.retryButton")}</TooltipContent></Tooltip>
              )}
              {actions.onFork && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5 text-muted-foreground hover:text-foreground"
                  onClick={actions.onFork}
                  title={t("assistantCard.forkButton")}
                >
                  <GitBranch className="h-3 w-3" />
                </Button>
              )}
              {actions.onToggleStar && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5 text-muted-foreground hover:text-foreground"
                  onClick={actions.onToggleStar}
                  title={t("assistantCard.starButton")}
                >
                  <Star key={isStarred ? "on" : "off"} className={`h-3 w-3 ${isStarred ? "fill-emphasis text-emphasis lvis-anim-star" : ""}`} />
                </Button>
              )}
            </div>
          ) : null}
        </div>
      )}

      <div
        className={`prose prose-sm lvis-prose max-h-none max-w-none overflow-y-visible break-words [overflow-wrap:anywhere] ${entry.route === "command" ? "whitespace-pre-wrap" : ""}`}
        data-testid="assistant-message-body"
      >
        <ReactMarkdown remarkPlugins={MARKDOWN_REMARK_PLUGINS}>
          {entry.streaming
            ? clampDanglingMarkdownLink(markdownText) || t("assistantCard.streamingPlaceholder")
            : markdownText}
        </ReactMarkdown>
      </div>

      {!entry.streaming && onFeedback ? (
        <div className="mt-1.5 flex items-center gap-1">
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
                aria-label={t("assistantCard.feedbackUp")}
              >
                <ThumbsUp key={feedbackRating === "up" ? "on" : "off"} className={`h-3.5 w-3.5 ${feedbackRating === "up" ? "fill-success lvis-anim-pop" : ""}`} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("assistantCard.feedbackUp")}</TooltipContent>
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
                aria-label={t("assistantCard.feedbackDown")}
              >
                <ThumbsDown key={feedbackRating === "down" ? "on" : "off"} className={`h-3.5 w-3.5 ${feedbackRating === "down" ? "fill-destructive lvis-anim-pop" : ""}`} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("assistantCard.feedbackDown")}</TooltipContent>
          </Tooltip>
          {showReasonBox && feedbackRating !== "down" ? (
            <div className="ml-1 flex items-center gap-1">
              <Input
                type="text"
                maxLength={200}
                placeholder={t("assistantCard.reasonPlaceholder")}
                value={reasonDraft}
                onChange={(e) => setReasonDraft(e.target.value)}
                className="h-6 w-40 px-2 text-xs"
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
                {t("assistantCard.sendButton")}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function preserveCommandLineBreaks(text: string): string {
  return text.replace(/([^\n])\n(?=[^\n])/g, "$1  \n");
}

export const AssistantCard = memo(AssistantCardImpl);
