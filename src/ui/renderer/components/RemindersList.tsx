/**
 * RemindersList — sidebar surface for active reminders. Subscribes to
 * `lvis:reminder:fired` so newly-fired reminders flash a toast row, and
 * reads the persisted list on mount + after each mutation.
 */
import { useCallback, useEffect, useState } from "react";
import { Button } from "../../../components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card.js";
import { ScrollArea } from "../../../components/ui/scroll-area.js";
import type { LvisApi } from "../types.js";

interface ReminderRecord {
  id: string;
  at: string;
  title: string;
  body?: string;
  repeat: "daily" | "weekly" | "none";
  createdAt: string;
  lastFiredAt?: string;
  dismissedAt?: string;
}

export function RemindersList({ api }: { api: LvisApi }) {
  const [reminders, setReminders] = useState<ReminderRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [recentlyFired, setRecentlyFired] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    if (typeof api.listReminders !== "function") return;
    setLoading(true);
    try {
      const list = await api.listReminders();
      setReminders(list);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
    if (typeof api.onReminderFired !== "function") return undefined;
    const unsub = api.onReminderFired((r) => {
      setRecentlyFired((prev) => (prev.includes(r.id) ? prev : [...prev, r.id]));
      void refresh();
    });
    return unsub;
  }, [api, refresh]);

  return (
    <Card className="mx-auto flex min-h-0 min-w-0 flex-1 w-full max-w-3xl flex-col overflow-hidden" data-testid="reminders-list">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>리마인더</CardTitle>
          <Button size="sm" variant="outline" onClick={() => void refresh()}>
            새로고침
          </Button>
        </div>
        <CardDescription>설정된 알림과 반복 일정</CardDescription>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-3">
        <ScrollArea className="flex-1">
          {loading ? (
            <div className="py-8 text-center text-sm text-muted-foreground">로딩 중...</div>
          ) : reminders.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              등록된 리마인더가 없습니다.
            </div>
          ) : (
            <div className="space-y-2 pr-2">
              {reminders.map((r) => (
                <div
                  key={r.id}
                  className={`rounded-md border p-3 ${recentlyFired.includes(r.id) ? "border-amber-500/60 bg-amber-500/5" : ""}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium">{r.title}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {new Date(r.at).toLocaleString("ko-KR")} ·{" "}
                        {r.repeat === "none" ? "1회" : r.repeat === "daily" ? "매일" : "매주"}
                      </div>
                      {r.body && (
                        <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">
                          {r.body}
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-[11px]"
                        onClick={() => void api.dismissReminder(r.id).then(refresh)}
                      >
                        닫기
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-[11px] text-destructive"
                        onClick={() => void api.removeReminder(r.id).then(refresh)}
                      >
                        삭제
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
