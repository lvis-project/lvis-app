/**
 * ChatTodoPanel — compact pending-task list inline with the chat input area.
 *
 * Warp-inspired: shows only pending tasks, max 8 visible, "+N more" links to
 * full TaskView. Slides down/up using the existing fqp-slot-enter/exit-bottom
 * animation utilities from styles.css. Empty state shows a Korean message.
 *
 * Design tokens: bg-card / border-border to match the chat surface.
 */
import { Badge } from "../../../components/ui/badge.js";
import { PRIORITY_CLASS } from "../constants.js";
import type { LvisApi, Task } from "../types.js";

const MAX_VISIBLE = 8;

interface ChatTodoPanelProps {
  api: LvisApi;
  tasks: Task[];
  loading: boolean;
  onNavigateToTasks?: () => void;
}

function formatDue(dueAt: string | undefined): string | null {
  if (!dueAt) return null;
  try {
    const d = new Date(dueAt);
    const now = new Date();
    const diffMs = d.getTime() - now.getTime();
    const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
    if (diffDays < 0) return `${Math.abs(diffDays)}일 초과`;
    if (diffDays === 0) return "오늘 마감";
    if (diffDays === 1) return "내일 마감";
    return `${diffDays}일 후`;
  } catch {
    return null;
  }
}

export function ChatTodoPanel({
  tasks,
  loading,
  onNavigateToTasks,
}: ChatTodoPanelProps) {
  const visible = tasks.slice(0, MAX_VISIBLE);
  const overflow = tasks.length - MAX_VISIBLE;

  return (
    <div
      className="fqp-slot-enter-bottom border-x border-t bg-card text-xs"
      data-testid="chat-todo-panel"
    >
      {loading && tasks.length === 0 ? (
        <div className="px-3 py-2 text-center text-muted-foreground">
          로딩 중...
        </div>
      ) : tasks.length === 0 ? (
        <div
          className="px-3 py-2 text-center text-muted-foreground"
          data-testid="chat-todo-empty"
        >
          진행중인 TODO 가 없습니다.
        </div>
      ) : (
        <ul className="max-h-[28vh] divide-y overflow-y-auto" data-testid="chat-todo-list">
          {visible.map((task) => {
            const dueLabel = formatDue(task.dueAt);
            const isOverdue =
              task.dueAt != null && new Date(task.dueAt) < new Date();
            return (
              <li
                key={task.id}
                className="flex items-center gap-2 px-3 py-1.5"
                data-testid="chat-todo-item"
              >
                <span className="min-w-0 flex-1 truncate font-medium">
                  {task.title}
                </span>
                <span
                  className={`shrink-0 text-[10px] font-semibold ${PRIORITY_CLASS[task.priority]}`}
                >
                  {task.priority}
                </span>
                {dueLabel && (
                  <Badge
                    variant="outline"
                    className={`shrink-0 px-1 py-0 text-[10px] ${
                      isOverdue
                        ? "border-destructive/40 text-destructive"
                        : ""
                    }`}
                  >
                    {dueLabel}
                  </Badge>
                )}
              </li>
            );
          })}
          {overflow > 0 && (
            <li className="px-3 py-1.5">
              <button
                className="text-muted-foreground underline underline-offset-2 hover:text-foreground"
                onClick={onNavigateToTasks}
                data-testid="chat-todo-overflow-link"
              >
                +{overflow}개 더 보기
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
