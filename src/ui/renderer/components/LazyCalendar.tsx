import { lazy, type ComponentType } from "react";
import type { CalendarProps } from "../../../components/ui/calendar.js";

let calendarModulePromise:
  | Promise<{ default: ComponentType<CalendarProps> }>
  | undefined;

export function preloadCalendar(): Promise<{ default: ComponentType<CalendarProps> }> {
  calendarModulePromise ??= import("../../../components/ui/calendar.js").then((mod) => ({
    default: mod.Calendar,
  }));
  return calendarModulePromise;
}

export const LazyCalendar = lazy(preloadCalendar);

export function CalendarFallback() {
  return <div className="h-[248px] w-[252px]" aria-label="달력 로딩 중" />;
}
