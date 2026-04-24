// Phase 2: dismissable daily briefing card — props-only, no App hook state.

import { useMemo } from "react";
import { Button } from "../../../components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card.js";
import { PRIORITY_EMOJI } from "../constants.js";
import type { BriefingPayload } from "../types.js";

/**
 * Sprint 3-A: renders a dismissable daily briefing card.
 * Three prop variants exercised in tests:
 *   - items present (typical)
 *   - empty-state (items: [], summary provided by generateTextBriefing)
 *   - LLM-failed fallback (summary is the plain-text briefing)
 */
export function BriefingCard({
  briefing,
  onDismiss,
  onSnooze,
}: {
  briefing: BriefingPayload;
  onDismiss: () => void;
  onSnooze: () => void;
}) {
  const generatedLabel = useMemo(() => {
    try {
      return new Date(briefing.generatedAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
    } catch {
      return briefing.generatedAt;
    }
  }, [briefing.generatedAt]);

  return (
    <Card data-testid="briefing-card" className="border-primary/40 bg-primary/5">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="text-sm">🗒️ 오늘의 브리핑</CardTitle>
            <CardDescription className="text-[11px]">{generatedLabel}</CardDescription>
          </div>
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={onSnooze}>1시간 뒤 다시</Button>
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onDismiss}>닫기</Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-2 pt-0">
        {briefing.summary && (
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{briefing.summary}</p>
        )}
        {briefing.items.length === 0 ? (
          <p className="text-xs text-muted-foreground">표시할 항목이 없습니다.</p>
        ) : (
          <ul className="space-y-1 text-xs">
            {briefing.items.slice(0, 8).map((it, idx) => (
              <li key={`${it.category}:${it.title}:${idx}`} className="flex gap-1.5">
                <span>{PRIORITY_EMOJI[it.priority] ?? "•"}</span>
                <span className="flex-1">
                  <span className="font-medium">{it.title}</span>
                  {it.detail ? <span className="text-muted-foreground"> — {it.detail}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
