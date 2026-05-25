export const SESSION_TODO_ITEM_STATUSES = [
  "pending",
  "in_progress",
  "completed",
] as const;

export const SESSION_TODO_UPDATE_STATUSES = [
  ...SESSION_TODO_ITEM_STATUSES,
  "deleted",
] as const;

export type SessionTodoStatus = (typeof SESSION_TODO_ITEM_STATUSES)[number];
export type SessionTodoUpdateStatus = (typeof SESSION_TODO_UPDATE_STATUSES)[number];

export interface SessionTodoItem {
  id: string;
  content: string;
  status: SessionTodoStatus;
}

export interface SessionTodoUpdate {
  id?: string;
  content?: string;
  status: SessionTodoUpdateStatus;
  /** Insert or move this item before another item id. Wins over afterId. */
  beforeId?: string;
  /** Insert or move this item after another item id. Appends if target missing. */
  afterId?: string;
}

export function isSessionTodoStatus(value: unknown): value is SessionTodoStatus {
  return typeof value === "string" && SESSION_TODO_ITEM_STATUSES.includes(value as SessionTodoStatus);
}

export function isSessionTodoUpdateStatus(value: unknown): value is SessionTodoUpdateStatus {
  return typeof value === "string" && SESSION_TODO_UPDATE_STATUSES.includes(value as SessionTodoUpdateStatus);
}
