import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "../../../components/ui/popover.js";
import { Calendar } from "../../../components/ui/calendar.js";

/**
 * DayDivider — inline horizontal-line + center date label that opens
 * a calendar popover on click. Absorbs the legacy `DateBadge` (header
 * single-today badge) and StackedChatView's `DaySeparator` (between-message
 * inline divider) into one component (issue #547 visual absorption).
 *
 * Renders the date as 오늘 / 어제 / YYYY-MM-DD; click → LVIS-styled calendar
 * (UI-only; selected date isn't wired to history navigation yet — same
 * status as the prior DateBadge).
 */
export function DayDivider({ dateKey }: { dateKey?: string }) {
  const [pickedDate, setPickedDate] = useState<Date | undefined>(undefined);
  const key = dateKey ?? new Date().toISOString().split("T")[0]!;
  const label = formatDayLabel(key);
  return (
    <div
      data-testid="day-divider"
      data-date={key}
      className="flex items-center gap-3 py-3"
    >
      <span className="h-px flex-1 bg-border/50" />
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="rounded-full bg-card border px-3 py-1 text-[11px] text-foreground/70 cursor-pointer hover:bg-muted"
          >
            🗓️ {label}
          </button>
        </PopoverTrigger>
        <PopoverContent align="center" className="w-auto p-2 shadow-none border border-[#E6E1D6] bg-[#F9F7F3]">
          <Calendar mode="single" selected={pickedDate} onSelect={setPickedDate} />
        </PopoverContent>
      </Popover>
      <span className="h-px flex-1 bg-border/50" />
    </div>
  );
}

function formatDayLabel(dateKey: string): string {
  const todayKey = new Date().toISOString().split("T")[0]!;
  if (dateKey === todayKey) return `${dateKey} (오늘)`;
  const y = new Date();
  y.setDate(y.getDate() - 1);
  const yKey = y.toISOString().split("T")[0]!;
  if (dateKey === yKey) return `${dateKey} (어제)`;
  return dateKey;
}
