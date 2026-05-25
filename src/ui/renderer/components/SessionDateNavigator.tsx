import { memo, useEffect, useState } from "react";
import { CalendarDays } from "lucide-react";
import { Popover, PopoverTrigger } from "../../../components/ui/popover.js";
import type { SessionSummary } from "../hooks/use-sessions.js";
import { preloadCalendar } from "./LazyCalendar.js";
import {
  SessionCalendarPopover,
  dateFromKey,
  getKoreaDateKey,
} from "./SessionCalendarPopover.js";

/**
 * SessionDateNavigator — inline horizontal-rule + center date label that opens
 * a SessionCalendarPopover on click. Supersedes the legacy day divider (issue #547).
 *
 * Renders the date as YYYY-MM-DD (오늘) / YYYY-MM-DD (어제) / YYYY-MM-DD;
 * clicking opens a themed calendar with session shortcuts for the picked day
 * and in-session day-jump capability when currentSessionEntries are provided.
 *
 * Edge case 6: KST normalization via getKoreaDateKey (in SessionCalendarPopover).
 * Edge case 7: fork/backtrack — entry positions are index-based, not date-sorted.
 * Edge case 5: streaming && !isCurrent guard lives in SessionCalendarPopover session buttons.
 */
function SessionDateNavigatorImpl({
  dateKey,
  sessionMarkerId,
  sessions = [],
  currentSessionId = "",
  streaming = false,
  currentSessionEntries = [],
  onLoadSession,
  onJumpToEntry,
  onRefreshSessions,
}: {
  dateKey?: string;
  sessionMarkerId?: string;
  sessions?: SessionSummary[];
  currentSessionId?: string;
  streaming?: boolean;
  /** Visible entries of the CURRENT session for in-session day jumping. */
  currentSessionEntries?: ReadonlyArray<{ createdAt?: number; idx: number }>;
  onLoadSession?: (sessionId: string) => void | boolean | Promise<void | boolean>;
  /** Called when user picks a date that has messages in the current session. */
  onJumpToEntry?: (entryIndex: number) => void;
  onRefreshSessions?: () => void | Promise<void>;
}) {
  // Edge case 6: KST normalization — getKoreaDateKey kept unchanged (Step 6).
  const key = dateKey ?? getKoreaDateKey(new Date());
  const [pickedDate, setPickedDate] = useState<Date | undefined>(() => dateFromKey(key));
  const [popoverOpen, setPopoverOpen] = useState(false);

  useEffect(() => {
    // Edge case 7: update picked date when dateKey prop changes (fork/backtrack).
    setPickedDate(dateFromKey(key));
  }, [key]);

  const label = formatDayLabel(key);

  const handlePopoverOpenChange = (open: boolean) => {
    setPopoverOpen(open);
    if (open) {
      void preloadCalendar();
      void onRefreshSessions?.();
    }
  };

  return (
    <div
      data-testid="session-date-navigator"
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
        <SessionCalendarPopover
          sessions={sessions}
          currentSessionId={currentSessionId}
          streaming={streaming}
          currentSessionEntries={currentSessionEntries}
          onLoadSession={onLoadSession}
          onJumpToEntry={onJumpToEntry}
          onRefreshSessions={onRefreshSessions}
          initialDate={pickedDate}
          onOpenChange={handlePopoverOpenChange}
          align="center"
        />
      </Popover>
      <span className="h-px flex-1 bg-border/50" />
    </div>
  );
}

export const SessionDateNavigator = memo(SessionDateNavigatorImpl);

/** Formats a YYYY-MM-DD key as a human-readable label with 오늘/어제 annotation. */
function formatDayLabel(dateKey: string): string {
  const todayKey = getKoreaDateKey(new Date());
  if (dateKey === todayKey) return `${dateKey} (오늘)`;
  const y = new Date();
  y.setDate(y.getDate() - 1);
  const yKey = getKoreaDateKey(y);
  if (dateKey === yKey) return `${dateKey} (어제)`;
  return dateKey;
}
