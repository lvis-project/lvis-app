export const SESSION_TASK_ITEM_STATUSES = [
  "pending",
  "in_progress",
  "completed",
] as const;

export const SESSION_TASK_UPDATE_STATUSES = [
  ...SESSION_TASK_ITEM_STATUSES,
  "deleted",
] as const;

export type SessionTaskStatus = (typeof SESSION_TASK_ITEM_STATUSES)[number];
export type SessionTaskUpdateStatus = (typeof SESSION_TASK_UPDATE_STATUSES)[number];

export interface SessionTaskItem {
  id: string;
  content: string;
  status: SessionTaskStatus;
}

export interface SessionTaskUpdate {
  id?: string;
  content?: string;
  status: SessionTaskUpdateStatus;
  /** Insert or move this item before another item id. Wins over afterId. */
  beforeId?: string;
  /** Insert or move this item after another item id. Appends if target missing. */
  afterId?: string;
}

export function isSessionTaskStatus(value: unknown): value is SessionTaskStatus {
  return typeof value === "string" && SESSION_TASK_ITEM_STATUSES.includes(value as SessionTaskStatus);
}

export function isSessionTaskUpdateStatus(value: unknown): value is SessionTaskUpdateStatus {
  return typeof value === "string" && SESSION_TASK_UPDATE_STATUSES.includes(value as SessionTaskUpdateStatus);
}
