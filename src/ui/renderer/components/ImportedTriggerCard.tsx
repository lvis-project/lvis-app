// ImportedTriggerCard — visible-history representation of an accepted
// brain proactive trigger.
//
// Why a dedicated card (not user/assistant bubbles):
//   1. The brain authored the trigger prompt; rendering it as a "나"
//      bubble misattributes authorship.
//   2. The trigger session is intentionally distinct from chat — its
//      provenance ("LVIS proactively did X based on signal Y") matters
//      for triage and trust. Flattening to user→assistant erases that.
//   3. The chat LLM's response to the trigger lives INSIDE the card
//      so the whole proactive interaction stays visually grouped — a
//      sibling assistant bubble below the card would scatter the
//      reading order across the chat.
//
// The card collapses prompt text by default (it's templated and long),
// shows the LLM's response inline, and surfaces a small footer with
// the source tag + tool-call count.

import { useState } from "react";
import { ChevronDown, ChevronRight, Sparkles } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

function stripEmailIdLine(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^\s*-\s*emailId\s*:/i.test(line))
    .join("\n");
}

interface ImportedTriggerCardProps {
  source: string;
  prompt: string;
  summary: string;
  toolCallCount: number;
  importedAt: string;
  /** Chat LLM's reply (streamed in after the user clicked 확인하기). */
  response?: string;
  /** True while the response is mid-stream — show a subtle indicator. */
  responseStreaming?: boolean;
}

export function ImportedTriggerCard({
  source,
  prompt,
  summary,
  toolCallCount,
  importedAt,
  response,
  responseStreaming,
}: ImportedTriggerCardProps) {
  const [expanded, setExpanded] = useState(false);

  let timeLabel: string;
  try {
    timeLabel = new Date(importedAt).toLocaleString("ko-KR", {
      timeZone: "Asia/Seoul",
    });
  } catch {
    timeLabel = importedAt;
  }

  return (
    <div
      data-testid="imported-trigger-card"
      data-source={source}
      data-streaming={responseStreaming ? "true" : "false"}
      className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm"
    >
      <div className="mb-1.5 flex items-center gap-2 text-[11px] text-muted-foreground">
        <Sparkles className="h-3 w-3 text-amber-500" />
        <span className="font-medium text-amber-700 dark:text-amber-400">
          LVIS proactive
        </span>
        <span className="text-muted-foreground">·</span>
        <span>{source}</span>
        <span className="text-muted-foreground">·</span>
        <span>{timeLabel}</span>
        {toolCallCount > 0 ? (
          <>
            <span className="text-muted-foreground">·</span>
            <span>도구 {toolCallCount}회</span>
          </>
        ) : null}
      </div>
      {summary ? (
        <div className="prose prose-sm prose-invert max-w-none break-words text-foreground">
          {/*
            Strip the `- emailId: …` line for display. The id is
            essential for the chat LLM (it uses it to call email_read)
            and stays in the wrapped envelope sent over IPC, but it's
            opaque base64 noise to a human reading the card. Keeping
            it visible was making the card look cluttered.
          */}
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{stripEmailIdLine(summary)}</ReactMarkdown>
        </div>
      ) : null}
      {/*
        Always render the response section after streaming has
        started — even if the LLM emitted only a tool_use and ended
        the turn with no text_delta. Hiding it on empty made the
        accept-then-empty case look broken (card sat with brain
        summary only and the user wondered if the click landed).
      */}
      <div
        data-testid="imported-trigger-response"
        className="mt-2 border-t border-amber-500/20 pt-2"
      >
        <div className="mb-1 flex items-center gap-1 text-[11px] text-muted-foreground">
          <span>LVIS 응답</span>
          {responseStreaming ? (
            <span
              className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500"
              aria-label="응답 중"
            />
          ) : null}
        </div>
        {response && response.length > 0 ? (
          <div className="prose prose-sm prose-invert max-w-none break-words text-foreground">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{response}</ReactMarkdown>
          </div>
        ) : !responseStreaming ? (
          <p className="text-xs text-muted-foreground">
            응답이 비어있습니다. (도구 호출만 있었거나 LLM 이 텍스트를 생성하지 않음)
          </p>
        ) : null}
      </div>
      <button
        type="button"
        className="mt-2 flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        트리거 프롬프트 {expanded ? "숨기기" : "보기"}
      </button>
      {expanded ? (
        <pre className="mt-1.5 whitespace-pre-wrap break-words rounded bg-muted/40 p-2 text-[11px] text-muted-foreground">
          {prompt}
        </pre>
      ) : null}
    </div>
  );
}
