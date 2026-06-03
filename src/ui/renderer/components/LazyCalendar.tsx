import { lazy, type ComponentType } from "react";
import type { CalendarProps } from "../../../components/ui/calendar.js";
import { useTranslation } from "../../../i18n/react.js";

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
  const { t } = useTranslation();
  return <div className="h-[248px] w-[252px]" aria-label={t("lazyCalendar.calendarLoading")} />;
}
