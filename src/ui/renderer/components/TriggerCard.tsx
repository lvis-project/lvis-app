// TriggerCard — proactive brain trigger result.
//
// Surfaces a captured `hostApi.triggerConversation()` session that ran on
// an *isolated* ConversationLoop (not the user's chat). Two outcomes:
//   - Dismiss → host drops the cached session; chat untouched.
//   - 지금 답하기 → host appends the trigger turn(s) to the active chat
//     history; the conversation continues there as if the user had been
//     in it the whole time.
//
// Until the user picks one, the trigger session is fully isolated from
// chat — no context pollution.
//
// P2: visibility-driven render branching.
//   - `user-visible` → modal-like card, no auto-dismiss
//   - `summary-only` → compact toast, auto-dismiss after 8s (hover pauses
//     the timer; leaving the toast resumes a fresh 8s window)
//   - `silent` is filtered upstream in `useTriggerResult` so this component
//     never receives one.

import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "../../../components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card.js";
import type { TriggerResult } from "../hooks/use-trigger-result.js";

const VISIBILITY_LABEL: Record<string, string> = {
  "silent": "백그라운드",
  "summary-only": "요약",
  "user-visible": "확인 필요",
};

const SUMMARY_AUTO_DISMISS_MS = 8000;

export function TriggerCard({
  result,
  onDismiss,
  onAccept,
}: {
  result: TriggerResult;
  onDismiss: (sessionId: string) => void;
  onAccept: (sessionId: string) => Promise<{ ok: boolean; imported?: number; reason?: string }>;
}) {
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const isSummary = result.visibility === "summary-only";

  // Auto-dismiss for summary-only. Hovering pauses the timer; mouseleave
  // restarts a fresh window so a partially-read toast does not vanish
  // mid-read. The timer is also paused while an import is in flight so a
  // network round-trip doesn't get cut by auto-dismiss.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoveringRef = useRef(false);

  useEffect(() => {
    if (!isSummary) return;
    const armTimer = () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        if (aliveRef.current) onDismiss(result.sessionId);
      }, SUMMARY_AUTO_DISMISS_MS);
    };
    if (!hoveringRef.current && !accepting) armTimer();
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [isSummary, accepting, result.sessionId, onDismiss]);

  const completedLabel = useMemo(() => {
    try {
      return new Date(result.completedAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
    } catch {
      return result.completedAt;
    }
  }, [result.completedAt]);

  const visibilityLabel = VISIBILITY_LABEL[result.visibility] ?? result.visibility;

  const handleAccept = async () => {
    setAccepting(true);
    setError(null);
    try {
      const out = await onAccept(result.sessionId);
      if (!aliveRef.current) return;
      if (!out.ok) {
        setError(out.reason ?? "import 실패");
      }
    } catch (e) {
      if (aliveRef.current) setError((e as Error).message);
    } finally {
      if (aliveRef.current) setAccepting(false);
    }
  };

  const handleMouseEnter = () => {
    if (!isSummary) return;
    hoveringRef.current = true;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };
  const handleMouseLeave = () => {
    if (!isSummary) return;
    hoveringRef.current = false;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      if (aliveRef.current) onDismiss(result.sessionId);
    }, SUMMARY_AUTO_DISMISS_MS);
  };

  const cardClassName = isSummary
    ? "flex flex-col border-amber-500/40 bg-amber-500/5 shadow-md backdrop-blur"
    : "flex h-full flex-col border-amber-500/40 bg-amber-500/5 shadow-lg backdrop-blur";

  return (
    <Card
      data-testid="trigger-card"
      data-variant={isSummary ? "summary" : "modal"}
      className={cardClassName}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <CardHeader className="shrink-0 pb-2">
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="text-sm">
              <span className="mr-1 text-amber-500">●</span>
              {result.source}
            </CardTitle>
            <CardDescription className="text-[11px]">
              {visibilityLabel} · {completedLabel}
            </CardDescription>
          </div>
          <div className="flex gap-1">
            <Button
              size="sm"
              variant="default"
              className="h-7 text-xs"
              disabled={accepting}
              onClick={handleAccept}
            >
              {accepting ? "이어받는 중..." : "지금 답하기"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => onDismiss(result.sessionId)}
            >
              무시
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent
        className={
          isSummary
            ? "min-h-0 overflow-hidden pt-0"
            : "min-h-0 flex-1 overflow-y-auto pt-0"
        }
      >
        {result.summary ? (
          <div
            className={
              isSummary
                ? "prose prose-sm prose-invert line-clamp-2 max-w-none break-words text-foreground"
                : "prose prose-sm prose-invert max-w-none break-words text-foreground"
            }
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{result.summary}</ReactMarkdown>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">아직 응답이 없습니다.</p>
        )}
        {error ? (
          <p className="mt-2 text-xs text-destructive">이어받기 실패: {error}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
