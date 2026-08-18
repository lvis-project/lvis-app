import { Loader2, Pin, RefreshCw, GitBranch, ThumbsUp, ThumbsDown, AlertTriangle, History } from "lucide-react";
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

/**
 * Trailing "[중단됨]"-style markers that older engine versions appended to the
 * assistant TEXT on abort. New turns carry `entry.interrupted` instead; these
 * literals survive only in already-persisted sessions, so they are stripped at
 * render and replaced by the same badge — one visual language for both eras.
 * Tail-anchored on the exact known catalog values: prose that merely mentions
 * the marker mid-sentence is left alone.
 */
const LEGACY_INTERRUPT_TAIL = /(?:\n*\s*)(?:\[Interrupted\]|\[중단됨\]|\[中断\]|\[Interrompu\]|\[Interrumpido\]|\[Unterbrochen\])\s*$/;
function splitLegacyInterruptTail(text: string): { text: string; hadMarker: boolean } {
  const stripped = text.replace(LEGACY_INTERRUPT_TAIL, "");
  return { text: stripped, hadMarker: stripped !== text };
}

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

  // distinguish a real LLM reply from an error banner masquerading as one.
  const isSystemNotice = entry.systemNotice !== undefined;
  // Issue #2113 — a systemNotice replayed from persisted history is an old
  // error, not a fresh one. Softened styling + a "previous session" badge
  // keep it recognizable without re-alarming the user after a session
  // reload (e.g. OS-notification click). Live notices keep the destructive
  // treatment unchanged. This is the single live/restored distinction point.
  const isRestoredNotice = isSystemNotice && entry.restored === true;
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
  const legacySplit = useMemo(() => splitLegacyInterruptTail(entry.text || ""), [entry.text]);
  const wasInterrupted = entry.interrupted === true || legacySplit.hadMarker;
  const displayText = useMemo(() => detectFromStream(legacySplit.text).cleanedText, [legacySplit.text]);
  const renderedText = useMemo(() => replaceToolNamesInText(displayText), [displayText]);
  const markdownText = entry.route === "command" ? preserveCommandLineBreaks(renderedText) : renderedText;
  const hasRenderableText = markdownText.trim().length > 0;
  const hasHeaderTitle = title.trim().length > 0;
  const showHeader = actions !== undefined || isSystemNotice || wasInterrupted || (entry.streaming && hasHeaderTitle);


  if (entry.streaming && !isSystemNotice && !hasRenderableText) {
    return null;
  }
  return (
    <div
      className={
        isRestoredNotice
          ? "group relative min-w-0 w-full max-w-full overflow-visible rounded-lg border border-border/(--opacity-medium) bg-muted/(--opacity-subtle) p-3 text-sm lvis-anim-message-in"
          : isSystemNotice
            ? "group relative min-w-0 w-full max-w-full overflow-visible rounded-lg border border-destructive/(--opacity-medium) bg-destructive/(--opacity-faint) p-3 text-sm shadow-sm lvis-anim-message-in"
            : "group relative min-w-0 w-full max-w-full overflow-visible py-1 text-sm lvis-anim-message-in"
      }
    >
      {/* Header bar — mirrors WorkBoardPanel's SectionShell header pattern */}
      {showHeader && (
        <div
          className={
            isRestoredNotice
              ? "mb-2 flex items-center gap-1.5 rounded border-b border-border/(--opacity-light) pb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
              : isSystemNotice
                ? "mb-2 flex items-center gap-1.5 rounded border-b border-destructive/(--opacity-light) pb-2 text-[11px] font-semibold uppercase tracking-wider text-destructive"
                : "mb-2 flex items-center gap-1.5 rounded pb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
          }
        >
          {isRestoredNotice ? (
            <History className="h-3 w-3" />
          ) : isSystemNotice ? (
            <AlertTriangle className="h-3 w-3" />
          ) : null}
          {title}
          {isRestoredNotice ? (
            <span
              data-testid="assistant-restored-notice-badge"
              className="rounded-full border border-border/(--opacity-medium) bg-muted/(--opacity-half) px-1.5 py-px text-[10px] font-medium normal-case tracking-normal text-muted-foreground"
            >
              {t("assistantCard.restoredNoticeBadge")}
            </span>
          ) : null}
          {wasInterrupted && !entry.streaming ? (
            <span
              data-testid="assistant-interrupted-badge"
              className="rounded-full border border-warning/(--opacity-medium) bg-warning/(--opacity-soft) px-1.5 py-px text-[10px] font-medium normal-case tracking-normal text-warning"
            >
              {t("assistantCard.interruptedBadge")}
            </span>
          ) : null}
          {entry.streaming ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          {isStarred ? <Pin key="starred" className="h-3 w-3 fill-emphasis text-emphasis lvis-anim-star" /> : null}
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
                  <Pin key={isStarred ? "on" : "off"} className={`h-3 w-3 ${isStarred ? "fill-emphasis text-emphasis lvis-anim-star" : ""}`} />
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
          {entry.streaming ? clampDanglingMarkdownLink(markdownText) : markdownText}
        </ReactMarkdown>
      </div>

      {!entry.streaming && onFeedback ? (
        <div className="mt-2 flex items-center gap-1 border-t border-border/(--opacity-medium) pt-2">
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
