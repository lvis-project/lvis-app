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

import { useMemo, useState } from "react";
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
      if (!out.ok) {
        setError(out.reason ?? "import 실패");
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAccepting(false);
    }
  };

  return (
    <Card
      data-testid="trigger-card"
      className="flex h-full flex-col border-amber-500/40 bg-amber-500/5 shadow-lg backdrop-blur"
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
      <CardContent className="min-h-0 flex-1 overflow-y-auto pt-0">
        {result.summary ? (
          <div className="prose prose-sm prose-invert max-w-none break-words text-foreground">
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
