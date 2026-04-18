import { useCallback, useEffect, useState } from "react";
import { Button } from "../../../components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card.js";
import { Badge } from "../../../components/ui/badge.js";
import { Tabs, TabsList, TabsTrigger } from "../../../components/ui/tabs.js";
import { ScrollArea } from "../../../components/ui/scroll-area.js";
import type { LvisApi, Task } from "../types.js";
import { PRIORITY_CLASS, formatTaskSource } from "../constants.js";

export function TaskView({ api }: { api: LvisApi }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [filter, setFilter] = useState<"pending"|"today"|"overdue"|"done">("pending");
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      let r: Task[];
      if (filter === "today") r = await api.getTodayTasks();
      else if (filter === "overdue") r = await api.getOverdueTasks();
      else if (filter === "done") r = await api.queryTasks({ status: "done" });
      else r = await api.queryTasks({ status: "pending" });
      setTasks(r);
    } catch { setTasks([]); } finally { setLoading(false); }
  }, [filter, api]);
  useEffect(() => { void load(); }, [load]);
  const isDone = filter === "done";
  return (
    <div className="flex min-h-0 flex-1 flex-col p-4">
      <Card className="flex h-full min-h-0 flex-col">
        <CardHeader>
          <div className="flex items-center justify-between"><CardTitle>태스크</CardTitle><Button size="sm" variant="outline" onClick={() => void load()}>새로고침</Button></div>
          <CardDescription>이메일·미팅에서 수집된 할 일 목록</CardDescription>
        </CardHeader>
        <CardContent className="flex min-h-0 flex-1 flex-col gap-3">
          <Tabs value={filter} onValueChange={(v) => setFilter(v as typeof filter)}>
            <TabsList className="w-full">
              <TabsTrigger value="pending" className="flex-1">진행중</TabsTrigger>
              <TabsTrigger value="today" className="flex-1">오늘 마감</TabsTrigger>
              <TabsTrigger value="overdue" className="flex-1">기한 초과</TabsTrigger>
              <TabsTrigger value="done" className="flex-1">완료됨</TabsTrigger>
            </TabsList>
          </Tabs>
          <ScrollArea className="flex-1">
            {loading ? <div className="py-8 text-center text-sm text-muted-foreground">로딩 중...</div> : tasks.length === 0 ? <div className="py-8 text-center text-sm text-muted-foreground">태스크가 없습니다.</div> : (
              <div className="space-y-2 pr-2">
                {tasks.map((t) => (
                  <div key={t.id} className={`flex items-start gap-2 rounded-md border p-3 ${isDone ? "opacity-60" : ""}`}>
                    <button className={`mt-0.5 h-4 w-4 flex-shrink-0 rounded border ${isDone ? "border-primary bg-primary" : "border-muted-foreground hover:border-primary"}`}
                      onClick={() => void api.updateTask(t.id, { status: isDone ? "pending" : "done" }).then(() => load())}>
                      {isDone ? <span className="flex h-full w-full items-center justify-center text-[8px] text-primary-foreground">✓</span> : null}
                    </button>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className={`text-sm font-medium ${isDone ? "line-through" : ""}`}>{t.title}</span>
                        <Badge variant="outline" className="text-[10px]">{formatTaskSource(t.source)}</Badge>
                        <span className={`text-[10px] font-semibold ${PRIORITY_CLASS[t.priority]}`}>{t.priority}</span>
                      </div>
                      {t.description ? <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{t.description}</p> : null}
                    </div>
                    <button className="flex-shrink-0 text-[10px] text-muted-foreground hover:text-destructive" onClick={() => void api.deleteTask(t.id).then(() => load())}>✕</button>
                  </div>
                ))}
              </div>
            )}
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}
