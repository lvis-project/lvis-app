// TriggerCard — proactive brain trigger result.
//
// Surfaces a captured `hostApi.triggerConversation()` session that ran on
// an *isolated* ConversationLoop (not the user's chat). Two outcomes:
//   - Dismiss → host drops the cached session; chat untouched.
//   - 확인하기 → host imports the trigger session into the active chat
//     history; the conversation continues there as if the user had been
//     in it the whole time.
//
// Until the user picks one, the trigger session is fully isolated from
// chat — no context pollution.
//
// P2: visibility-driven render branching.
//   - `user-visible` → centered card, no auto-dismiss
//   - `summary-only` → compact toast, auto-dismiss after 8s; hover OR
//     keyboard focus pauses the timer; releasing either restarts a fresh
//     8s window. Pointer-already-over-on-mount is detected via
//     `:hover` so a toast that pops under the cursor doesn't dismiss
//     while the user reads it.
//   - `silent` is filtered upstream in `useTriggerResult`, so this
//     component never receives one.
//
// Lifecycle contract: parent MUST key on `result.sessionId` (see
// ChatView) so a session change forces remount + cleanup of the in-flight
// timer. The component does not defend against in-place sessionId swap.

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

  // Toast persists until the user clicks "확인하기" or "무시" — earlier
  // versions auto-dismissed after 8s with hover/focus pause, but
  // clicking outside the app (or anywhere outside the toast) silently
  // killed proactive notifications. The user has to make an explicit
  // decision now.
  const cardRef = useRef<HTMLDivElement | null>(null);

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

  const cardClassName = isSummary
    ? "flex flex-col border-amber-500/40 bg-amber-500/5 shadow-md backdrop-blur"
    : "flex h-full flex-col border-amber-500/40 bg-amber-500/5 shadow-lg backdrop-blur";

  // a11y: the summary toast is a transient status message — announce it
  // to assistive tech via aria-live so screen-reader users don't miss it
  // when it auto-dismisses. Centered/user-visible variant is more
  // persistent and gets the default `region` semantics from Card.
  const a11yProps = isSummary
    ? { role: "status", "aria-live": "polite" as const, "aria-atomic": true as const }
    : {};

  return (
    <Card
      ref={cardRef}
      data-testid="trigger-card"
      data-variant={isSummary ? "summary" : "centered"}
      className={cardClassName}
      {...a11yProps}
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
              data-testid="trigger-accept"
              disabled={accepting}
              onClick={handleAccept}
            >
              {accepting ? "확인 중..." : "확인하기"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              data-testid="trigger-dismiss"
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
