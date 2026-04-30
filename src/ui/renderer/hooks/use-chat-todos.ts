/**
 * use-chat-todos — encapsulates pending task list, expand/collapse state,
 * localStorage persistence, and polling refresh for ChatTodoPanel.
 *
 * Refresh strategy: no `onTaskUpdated` IPC event exists, so we poll every 5s
 * while expanded. Collapse stops the interval to avoid unnecessary IPC calls
 * when the panel is hidden.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { LvisApi, Task } from "../types.js";

const STORAGE_KEY = "lvis.chatTodoExpanded";
const POLL_INTERVAL_MS = 5_000;

export interface UseChatTodosResult {
  tasks: Task[];
  expanded: boolean;
  loading: boolean;
  toggle: () => void;
  refresh: () => Promise<void>;
}

export function useChatTodos(api: LvisApi): UseChatTodosResult {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<boolean>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  });

  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.queryTasks({ status: "pending" });
      setTasks(result);
    } finally {
      setLoading(false);
    }
  }, [api]);

  // Initial fetch + polling while expanded
  useEffect(() => {
    if (!expanded) return;
    void refresh();
    const id = setInterval(() => {
      void refresh();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [expanded, refresh]);

  const toggle = useCallback(() => {
    setExpanded((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(STORAGE_KEY, String(next));
      } catch {
        // ignore storage errors (e.g. private mode)
      }
      return next;
    });
  }, []);

  return { tasks, expanded, loading, toggle, refresh };
}
