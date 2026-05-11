import { Loader2, Star, RefreshCw, GitBranch, ThumbsUp, ThumbsDown } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";
import type { ChatEntry } from "../../../lib/chat-stream-state.js";
import { clampDanglingMarkdownLink } from "../utils/streaming-markdown.js";
import { MARKDOWN_REMARK_PLUGINS } from "../utils/markdown-plugins.js";
import { replaceToolNamesInText } from "../utils/tool-display.js";
import { detectFromStream } from "../../../lib/stream-markers.js";

export function AssistantCard({
  entry,
  actions,
  isStarred,
  onFeedback,
  isFinal = true,
}: {
  entry: Extract<ChatEntry, { kind: "assistant" }>;
  highlightQuery?: string;
  actions?: { onRetry?: () => void; onFork?: () => void; onToggleStar?: () => void };
  isStarred?: boolean;
  onFeedback?: (rating: "up" | "down", reason?: string) => void | Promise<void>;
  isFinal?: boolean;
  embedded?: boolean;
}) {
  const [feedbackRating, setFeedbackRating] = useState<"up" | "down" | null>(null);
  const [showReasonBox, setShowReasonBox] = useState(false);
  const [reasonDraft, setReasonDraft] = useState("");
  const title = entry.streaming ? "LVIS 응답 작성 중" : "LVIS 응답";
  const displayText = detectFromStream(entry.text || "").cleanedText;
  const renderedText = replaceToolNamesInText(displayText);
  const markdownText = entry.route === "command" ? preserveCommandLineBreaks(renderedText) : renderedText;
  // chars/4 token estimate 제거 (2026-05-07): TurnActionBar 의 TokenCostBadge
  // 가 provider-reported 값을 단일 source 로 표시. 카드 헤더의 ~tok 배지는
  // 한국어 2-3× under-estimate 거짓 정보였음.
  return (
    <div className="group relative min-w-0 w-full max-w-full overflow-visible rounded-md px-3 py-2 text-sm">
      {(actions !== undefined || entry.streaming) && (
        <div className="mb-1 flex items-center gap-2 text-[11px] text-muted-foreground">
          {title}
          {entry.streaming ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          {isStarred ? <Star key="starred" className="h-3 w-3 fill-emphasis text-emphasis lvis-anim-star" /> : null}
          {actions && !entry.streaming ? (
            <div className={`ml-auto gap-1 ${isFinal !== false ? "flex" : "hidden group-hover:flex"}`}>
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
                  <Star key={isStarred ? "on" : "off"} className={`h-3 w-3 ${isStarred ? "fill-emphasis text-emphasis lvis-anim-star" : ""}`} />
                </button>
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
            ? clampDanglingMarkdownLink(markdownText) || "응답을 작성하는 중..."
            : markdownText}
        </ReactMarkdown>
      </div>

      {!entry.streaming && onFeedback ? (
        <div className="mt-1.5 flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className={`rounded p-0.5 hover:bg-muted transition-colors ${feedbackRating === "up" ? "text-success" : "text-muted-foreground"}`}
                onClick={() => {
                  if (feedbackRating === "up") return;
                  setFeedbackRating("up");
                  setShowReasonBox(false);
                  void onFeedback("up");
                }}
                aria-label="도움이 됐어요"
              >
                <ThumbsUp key={feedbackRating === "up" ? "on" : "off"} className={`h-3.5 w-3.5 ${feedbackRating === "up" ? "fill-success lvis-anim-pop" : ""}`} />
              </button>
            </TooltipTrigger>
            <TooltipContent>도움이 됐어요</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className={`rounded p-0.5 hover:bg-muted transition-colors ${feedbackRating === "down" ? "text-destructive" : "text-muted-foreground"}`}
                onClick={() => {
                  if (feedbackRating === "down") return;
                  setShowReasonBox(true);
                }}
                aria-label="개선이 필요해요"
              >
                <ThumbsDown key={feedbackRating === "down" ? "on" : "off"} className={`h-3.5 w-3.5 ${feedbackRating === "down" ? "fill-destructive lvis-anim-pop" : ""}`} />
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

function preserveCommandLineBreaks(text: string): string {
  return text.replace(/([^\n])\n(?=[^\n])/g, "$1  \n");
}
