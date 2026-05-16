import { Suspense, useEffect, useState } from "react";
import { CalendarDays } from "lucide-react";
import type { Matcher } from "react-day-picker";
import { Popover, PopoverContent, PopoverTrigger } from "../../../components/ui/popover.js";
import type { SessionSummary } from "../hooks/use-sessions.js";
import { CalendarFallback, LazyCalendar, preloadCalendar } from "./LazyCalendar.js";

/**
 * DayDivider — inline horizontal-line + center date label that opens
 * a calendar popover on click. Absorbs the legacy `DateBadge` (header
 * single-today badge) and StackedChatView's `DaySeparator` (between-message
 * inline divider) into one component (issue #547 visual absorption).
 *
 * Renders the date as 오늘 / 어제 / YYYY-MM-DD; click → themed calendar and
 * session shortcuts for the selected day.
 */
export function DayDivider({
  dateKey,
  sessionMarkerId,
  sessions = [],
  currentSessionId = "",
  streaming = false,
  onLoadSession,
  onRefreshSessions,
}: {
  dateKey?: string;
  sessionMarkerId?: string;
  sessions?: SessionSummary[];
  currentSessionId?: string;
  streaming?: boolean;
  onLoadSession?: (sessionId: string) => void | boolean | Promise<void | boolean>;
  onRefreshSessions?: () => void | Promise<void>;
}) {
  const key = dateKey ?? getKoreaDateKey(new Date());
  const [pickedDate, setPickedDate] = useState<Date | undefined>(() => dateFromKey(key));
  const [popoverOpen, setPopoverOpen] = useState(false);
  useEffect(() => {
    setPickedDate(dateFromKey(key));
  }, [key]);
  useEffect(() => {
    void preloadCalendar();
  }, []);
  const label = formatDayLabel(key);
  const selectedKey = pickedDate ? getKoreaDateKey(pickedDate) : key;
  const sessionDateKeys = Array.from(
    new Set(sessions.map((session) => getKoreaDateKey(new Date(session.modifiedAt)))),
  );
  const sessionDateMatchers: Matcher[] = sessionDateKeys.map(dateFromKey);
  const sessionsForDate = sessions.filter((session) => getKoreaDateKey(new Date(session.modifiedAt)) === selectedKey);
  const selectToday = () => setPickedDate(new Date());
  const handlePopoverOpenChange = (open: boolean) => {
    setPopoverOpen(open);
    if (open) {
      void preloadCalendar();
      void onRefreshSessions?.();
    }
  };
  return (
    <div
      data-testid="day-divider"
      data-date={key}
      data-session-marker-id={sessionMarkerId}
      className="sticky top-0 z-10 -mx-3 flex items-center gap-3 bg-background/90 px-3 py-3 backdrop-blur"
    >
      <span className="h-px flex-1 bg-border/50" />
      <Popover open={popoverOpen} onOpenChange={handlePopoverOpenChange}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-full border bg-card px-3 py-1 text-[11px] text-foreground/70 cursor-pointer hover:bg-muted"
          >
            <CalendarDays className="h-3 w-3" />
            {label}
          </button>
        </PopoverTrigger>
        <PopoverContent align="center" className="w-[268px] border-border bg-popover p-2 text-popover-foreground shadow-lg">
          <Suspense fallback={<CalendarFallback />}>
            <LazyCalendar
              mode="single"
              selected={pickedDate}
              onSelect={setPickedDate}
              modifiers={{ hasSession: sessionDateMatchers }}
              modifiersClassNames={{
                hasSession:
                  "after:absolute after:bottom-0.5 after:left-1/2 after:h-1 after:w-1 after:-translate-x-1/2 after:rounded-full after:bg-primary/80 [&>button]:font-semibold",
              }}
            />
          </Suspense>
          <div className="border-t border-border/70 px-1 py-2">
            <div className="mb-1 flex items-center justify-between gap-2 px-1">
              <span className="min-w-0 truncate text-[10px] font-medium text-muted-foreground">
                {selectedKey} 대화
              </span>
              <button
                type="button"
                onClick={selectToday}
                className="shrink-0 rounded border border-border bg-muted/30 px-2 py-0.5 text-[10px] text-foreground/80 hover:bg-accent hover:text-accent-foreground"
              >
                오늘
              </button>
            </div>
            {sessionsForDate.length === 0 ? (
              <div className="px-1 py-1 text-[11px] text-muted-foreground">해당 날짜의 저장된 대화가 없습니다.</div>
            ) : (
              <div className="max-h-32 space-y-1 overflow-y-auto">
                {sessionsForDate.map((session) => {
                  const isCurrent = session.id === currentSessionId;
                  return (
                    <button
                      key={session.id}
                      type="button"
                      disabled={(streaming && !isCurrent) || !onLoadSession}
                      onClick={() => {
                        setPopoverOpen(false);
                        void onLoadSession?.(session.id);
                      }}
                      className={`block w-full rounded px-2 py-1.5 text-left text-[11px] hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50 ${isCurrent ? "bg-muted text-foreground" : "text-popover-foreground"}`}
                    >
                      <span className="block truncate">{session.title || "제목 없는 세션"}</span>
                      <span className="block text-[10px] text-muted-foreground">
                        {new Date(session.modifiedAt).toLocaleTimeString("ko-KR", {
                          timeZone: "Asia/Seoul",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                        {isCurrent ? " · 현재" : ""}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </PopoverContent>
      </Popover>
      <span className="h-px flex-1 bg-border/50" />
    </div>
  );
}

function getKoreaDateKey(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function dateFromKey(dateKey: string): Date {
  const [year = "0", month = "1", day = "1"] = dateKey.split("-");
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 12));
}

function formatDayLabel(dateKey: string): string {
  const todayKey = getKoreaDateKey(new Date());
  if (dateKey === todayKey) return `${dateKey} (오늘)`;
  const y = new Date();
  y.setDate(y.getDate() - 1);
  const yKey = getKoreaDateKey(y);
  if (dateKey === yKey) return `${dateKey} (어제)`;
  return dateKey;
}
