import type { BriefingItem, CachedCalendarEvent } from "./routine-engine.js";

export type RoutineEventPriority = BriefingItem["priority"];
export type RoutineEventCategory = BriefingItem["category"];

export interface RoutineMailActionItem {
  subject: string;
  sender?: string;
  deadline?: string;
  intent?: string;
  priority?: RoutineEventPriority;
}

export interface RoutineItemCreatedEvent {
  type: "routine.item.created";
  item: BriefingItem;
}

export interface RoutineSignalUpcomingEvent {
  type: "routine.signal.upcoming";
  category: RoutineEventCategory;
  title: string;
  detail?: string;
  priority?: RoutineEventPriority;
}

export interface RoutineSignalActionNeededEvent {
  type: "routine.signal.action-needed";
  category: Exclude<RoutineEventCategory, "calendar">;
  title: string;
  detail?: string;
  priority?: RoutineEventPriority;
}

export interface RoutineSnapshotCalendarEvent {
  type: "routine.snapshot.calendar";
  events: CachedCalendarEvent[];
}

export interface RoutineSnapshotCalendarInvalidatedEvent {
  type: "routine.snapshot.calendar.invalidated";
  reason?: string;
}

export interface RoutineSnapshotMailEvent {
  type: "routine.snapshot.mail";
  items: RoutineMailActionItem[];
}

export interface RoutineSnapshotMailInvalidatedEvent {
  type: "routine.snapshot.mail.invalidated";
  reason?: string;
}

export type RoutineEvent =
  | RoutineItemCreatedEvent
  | RoutineSignalUpcomingEvent
  | RoutineSignalActionNeededEvent
  | RoutineSnapshotCalendarEvent
  | RoutineSnapshotCalendarInvalidatedEvent
  | RoutineSnapshotMailEvent
  | RoutineSnapshotMailInvalidatedEvent;

function isRoutinePriority(value: unknown): value is RoutineEventPriority {
  return value === "high" || value === "medium" || value === "low";
}

function isRoutineCategory(value: unknown): value is RoutineEventCategory {
  return (
    value === "task" ||
    value === "note" ||
    value === "session" ||
    value === "meeting" ||
    value === "email" ||
    value === "calendar" ||
    value === "system"
  );
}

function isBriefingItem(value: unknown): value is BriefingItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    isRoutineCategory(item.category) &&
    isRoutinePriority(item.priority) &&
    typeof item.title === "string" &&
    (item.detail === undefined || typeof item.detail === "string")
  );
}

function isCachedCalendarEvent(value: unknown): value is CachedCalendarEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.subject === "string" &&
    typeof event.start === "string" &&
    typeof event.end === "string" &&
    (event.isAllDay === undefined || typeof event.isAllDay === "boolean") &&
    (event.location === undefined || typeof event.location === "string") &&
    (event.isOnlineMeeting === undefined || typeof event.isOnlineMeeting === "boolean")
  );
}

function isRoutineMailActionItem(value: unknown): value is RoutineMailActionItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.subject === "string" &&
    (item.sender === undefined || typeof item.sender === "string") &&
    (item.deadline === undefined || typeof item.deadline === "string") &&
    (item.intent === undefined || typeof item.intent === "string") &&
    (item.priority === undefined || isRoutinePriority(item.priority))
  );
}

export function parseRoutineEvent(type: string, data: unknown): RoutineEvent | undefined {
  if (type === "routine.item.created") {
    if (
      data &&
      typeof data === "object" &&
      "item" in (data as Record<string, unknown>) &&
      isBriefingItem((data as { item?: unknown }).item)
    ) {
      return { type, item: (data as { item: BriefingItem }).item };
    }
    return undefined;
  }

  if (type === "routine.signal.upcoming" || type === "routine.signal.action-needed") {
    if (!data || typeof data !== "object") return undefined;
    const payload = data as Record<string, unknown>;
    if (!isRoutineCategory(payload.category) || typeof payload.title !== "string") {
      return undefined;
    }
    const detail = typeof payload.detail === "string" ? payload.detail : undefined;
    const priority = isRoutinePriority(payload.priority) ? payload.priority : undefined;
    if (type === "routine.signal.upcoming") {
      return {
        type,
        category: payload.category,
        title: payload.title,
        detail,
        priority,
      };
    }
    if (payload.category === "calendar") return undefined;
    return {
      type,
      category: payload.category,
      title: payload.title,
      detail,
      priority,
    };
  }

  if (type === "routine.snapshot.calendar") {
    if (
      data &&
      typeof data === "object" &&
      Array.isArray((data as { events?: unknown[] }).events) &&
      (data as { events: unknown[] }).events.every(isCachedCalendarEvent)
    ) {
      return { type, events: (data as { events: CachedCalendarEvent[] }).events };
    }
    return undefined;
  }

  if (type === "routine.snapshot.calendar.invalidated") {
    if (!data) return { type };
    if (typeof data !== "object") return undefined;
    const payload = data as Record<string, unknown>;
    if (payload.reason !== undefined && typeof payload.reason !== "string") {
      return undefined;
    }
    return { type, reason: typeof payload.reason === "string" ? payload.reason : undefined };
  }

  if (type === "routine.snapshot.mail") {
    if (
      data &&
      typeof data === "object" &&
      Array.isArray((data as { items?: unknown[] }).items) &&
      (data as { items: unknown[] }).items.every(isRoutineMailActionItem)
    ) {
      return { type, items: (data as { items: RoutineMailActionItem[] }).items };
    }
    return undefined;
  }

  if (type === "routine.snapshot.mail.invalidated") {
    if (!data) return { type };
    if (typeof data !== "object") return undefined;
    const payload = data as Record<string, unknown>;
    if (payload.reason !== undefined && typeof payload.reason !== "string") {
      return undefined;
    }
    return { type, reason: typeof payload.reason === "string" ? payload.reason : undefined };
  }

  return undefined;
}
