/**
 * SessionTodoPanel — collapsible chat-side checklist for the
 * `todo_session_write` LLM tool. Visually distinct from user TaskView
 * (dashed border, amber accent) so the user can tell at a glance this is
 * the assistant's running plan, not their persistent task list.
 */
import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, ListChecks } from "lucide-react";
import { Badge } from "../../../components/ui/badge.js";
import type { LvisApi } from "../types.js";

interface SessionTodoItem {
  id: string;
  content: string;
  status: string;
}

const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  pending: { label: "대기", cls: "bg-muted text-muted-foreground" },
  in_progress: { label: "진행", cls: "bg-amber-500/15 text-amber-600 dark:text-amber-400" },
  completed: { label: "완료", cls: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" },
  deleted: { label: "취소", cls: "bg-muted text-muted-foreground line-through" },
};

export function SessionTodoPanel({ api }: { api: LvisApi }) {
  const [items, setItems] = useState<SessionTodoItem[]>([]);
  const [open, setOpen] = useState(true);

  const refresh = useCallback(async () => {
    if (typeof api.listSessionTodos !== "function") return;
    const list = await api.listSessionTodos();
    setItems(list);
  }, [api]);

  useEffect(() => {
    void refresh();
    if (typeof api.onSessionTodoChanged !== "function") {
      return undefined;
    }
    const unsub = api.onSessionTodoChanged(({ items: next }) => {
      setItems(next);
    });
    return unsub;
  }, [api, refresh]);

  if (items.length === 0) return null;

  const visible = items.filter((i) => i.status !== "deleted");
  const completedCount = items.filter((i) => i.status === "completed").length;

  return (
    <div
      className="max-w-[85%] rounded-md border border-dashed border-amber-500/40 bg-amber-500/5 text-xs"
      data-testid="session-todo-panel"
    >
      <button
        className="flex w-full items-center gap-2 px-3 py-1.5 hover:bg-amber-500/10"
        onClick={() => setOpen((o) => !o)}
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <ListChecks className="h-3 w-3" />
        <span className="font-medium">어시스턴트 체크리스트</span>
        <Badge variant="outline" className="px-1 py-0 text-[10px]">
          {completedCount}/{visible.length}
        </Badge>
      </button>
      {open && (
        <ul className="space-y-1 border-t px-3 py-1.5">
          {items.map((it) => {
            const meta = STATUS_BADGE[it.status] ?? STATUS_BADGE.pending;
            return (
              <li key={it.id} className="flex items-start gap-2">
                <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${meta.cls}`}>
                  {meta.label}
                </span>
                <span className={`min-w-0 flex-1 ${it.status === "completed" ? "line-through opacity-70" : ""} ${it.status === "deleted" ? "line-through opacity-50" : ""}`}>
                  {it.content}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
