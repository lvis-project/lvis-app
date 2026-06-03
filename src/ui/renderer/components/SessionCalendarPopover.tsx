import { Suspense, useEffect, useState } from "react";
import type { Matcher } from "react-day-picker";
import { PopoverContent } from "../../../components/ui/popover.js";
import { useTranslation } from "../../../i18n/react.js";
import type { SessionSummary } from "../hooks/use-sessions.js";
import { formatHhMmKst } from "../utils/format-time.js";
import { CalendarFallback, LazyCalendar, preloadCalendar } from "./LazyCalendar.js";

const KOREA_DATE_KEY_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * Returns a YYYY-MM-DD date key normalized to Korea Standard Time (UTC+9).
 * Used so that sessions created after midnight UTC but before midnight KST
 * are attributed to the correct calendar day.
 * Edge case 6: KST/UTC normalization.
 */
function getKoreaDateKey(date: Date): string {
  const parts = KOREA_DATE_KEY_FORMATTER.formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * Parses a YYYY-MM-DD key into a Date anchored at UTC noon to avoid
 * timezone-edge rendering issues in react-day-picker.
 * Edge case 7: fork/backtrack — entries use index-based positioning, date key
 * is only used for calendar navigation, not entry reordering.
 */
export function dateFromKey(dateKey: string): Date {
  const [year = "0", month = "1", day = "1"] = dateKey.split("-");
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 12));
}

/**
 * Props for the reusable SessionCalendarPopover.
 * Designed so that a future Cmd+F search bar can embed the calendar without
 * the inline-divider chrome of SessionDateNavigator.
 */
export interface SessionCalendarPopoverProps {
  sessions?: SessionSummary[];
  currentSessionId?: string;
  streaming?: boolean;
  /**
   * Visible entries of the CURRENT session — used to compute messagesByDate
   * for in-session day jumping. Pass empty array if not in chat context.
   */
  currentSessionEntries?: ReadonlyArray<{ createdAt?: number; idx: number }>;
  onLoadSession?: (sessionId: string) => void | boolean | Promise<void | boolean>;
  /**
   * Called when user picks a date that has messages in the current session.
   * Receives the entry index of the FIRST message on that day. Caller is
   * responsible for scrolling.
   */
  onJumpToEntry?: (entryIndex: number) => void;
  onRefreshSessions?: () => void | Promise<void>;
  /** Controls the popover open state for embedded use cases. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** When true, the popover renders its TriggerButton; when false, just the content. */
  showTrigger?: boolean;
  /** Selected date initial value. */
  initialDate?: Date;
  align?: "start" | "center" | "end";
}

/**
 * SessionCalendarPopover — reusable popover that renders a themed calendar
 * and session shortcuts for the selected day.
 *
 * Enhancement steps implemented:
 * - Step 1: Per-message date index from currentSessionEntries[].createdAt
 * - Step 2: Disable future + empty dates in calendar
 * - Step 3: Legacy session warning when no createdAt on any entry
 * - Step 4: Multi-day current session jump button with re-click cycling
 * - Step 5: Primary-tone visual for current session rows + stronger dot
 */
export function SessionCalendarPopover({
  sessions = [],
  currentSessionId = "",
  streaming = false,
  currentSessionEntries = [],
  onLoadSession,
  onJumpToEntry,
  onRefreshSessions: _onRefreshSessions,
  onOpenChange,
  initialDate,
  align = "center",
}: SessionCalendarPopoverProps) {
  const { t } = useTranslation();
  const today = new Date();
  const todayKey = getKoreaDateKey(today);

  const [pickedDate, setPickedDate] = useState<Date | undefined>(initialDate);
  // Sync the calendar's selected date when the parent supplies a new
  // initialDate (e.g. SessionDateNavigator re-renders with a different
  // dateKey, or the search bar re-opens with a different anchor). Without
  // this, the popover would stay pinned to the date captured at first mount.
  useEffect(() => {
    setPickedDate(initialDate);
  }, [initialDate]);
  // Step 4: track cycle index for multi-hit same-date jumping; resets on date change.
  const [jumpCycleIdx, setJumpCycleIdx] = useState(0);
  const [lastJumpedKey, setLastJumpedKey] = useState<string | undefined>(undefined);

  const selectedKey = pickedDate ? getKoreaDateKey(pickedDate) : todayKey;

  // Step 1: Build Map<dateKey, entryIndex[]> from currentSessionEntries.createdAt.
  // Entries without createdAt are skipped.
  const messagesByDate = new Map<string, number[]>();
  for (const entry of currentSessionEntries) {
    if (entry.createdAt === undefined) continue;
    const dk = getKoreaDateKey(new Date(entry.createdAt));
    const arr = messagesByDate.get(dk);
    if (arr) {
      arr.push(entry.idx);
    } else {
      messagesByDate.set(dk, [entry.idx]);
    }
  }

  // Step 3: Detect legacy sessions (entries present but none have createdAt).
  const isLegacySession =
    currentSessionEntries.length > 0 &&
    currentSessionEntries.every((e) => e.createdAt === undefined);

  // Session date matchers for calendar dots.
  const sessionDateKeys = Array.from(
    new Set(sessions.map((s) => getKoreaDateKey(new Date(s.modifiedAt)))),
  );
  const sessionDateMatchers: Matcher[] = sessionDateKeys.map(dateFromKey);

  // Current-session message date matchers (stronger dot — Step 5).
  const currentSessionDateKeys = Array.from(messagesByDate.keys());
  const currentSessionDateMatchers: Matcher[] = currentSessionDateKeys.map(dateFromKey);

  const sessionsForDate = sessions.filter(
    (s) => getKoreaDateKey(new Date(s.modifiedAt)) === selectedKey,
  );

  // Step 4: Current-session entries on the selected date.
  const currentSessionEntriesForDate = messagesByDate.get(selectedKey) ?? [];

  const handleDateSelect = (date: Date | undefined) => {
    setPickedDate(date);
    // Reset jump cycle when date changes.
    if (date && getKoreaDateKey(date) !== lastJumpedKey) {
      setJumpCycleIdx(0);
    }
  };

  /** Step 4: Jump to the current-session message for the selected date, cycling on re-click. */
  const handleJumpToCurrentSession = () => {
    const indices = currentSessionEntriesForDate;
    if (indices.length === 0) return;
    const idx = jumpCycleIdx % indices.length;
    onJumpToEntry?.(indices[idx]!);
    setLastJumpedKey(selectedKey);
    setJumpCycleIdx(idx + 1);
    // Close popover after jump (first hit only; subsequent cycles stay open for UX feedback).
    if (idx === 0) onOpenChange?.(false);
  };

  return (
    <PopoverContent
      align={align}
      className="w-[268px] border-border bg-popover p-2 text-popover-foreground shadow-lg"
      onOpenAutoFocus={() => void preloadCalendar()}
    >
      <Suspense fallback={<CalendarFallback />}>
        <LazyCalendar
          mode="single"
          selected={pickedDate}
          // Open the calendar on the selected date's month. Without this,
          // react-day-picker v10 defaults the displayed month to *today*, so
          // picking a divider from a previous month would open the calendar on
          // the current month with the selection off-screen.
          defaultMonth={pickedDate}
          onSelect={handleDateSelect}
          // Step 2: Disable future dates only. Past dates with no activity
          // remain selectable so the user can see the empty-state copy
          // ("해당 날짜의 저장된 대화가 없습니다.") rather than have the
          // click silently ignored. `hasActivityOnDate` still drives the dot
          // indicator below so users see at-a-glance which dates have data.
          disabled={(date) => date > today}
          modifiers={{
            hasSession: sessionDateMatchers,
            // Step 5: Current-session message dates get a stronger dot.
            hasCurrentSessionMessage: currentSessionDateMatchers,
          }}
          modifiersClassNames={{
            // Other-session dates: subdued dot (edge case 5 — streaming guard lives on buttons below).
            hasSession:
              "after:absolute after:bottom-0.5 after:left-1/2 after:h-1 after:w-1 after:-translate-x-1/2 after:rounded-full after:bg-primary/80 [&>button]:font-semibold",
            // Step 5: Current-session message dates: stronger primary dot.
            hasCurrentSessionMessage:
              "after:absolute after:bottom-0.5 after:left-1/2 after:h-1 after:w-1 after:-translate-x-1/2 after:rounded-full after:bg-primary [&>button]:font-semibold",
          }}
        />
      </Suspense>

      {/* Step 3: Legacy session warning — no createdAt on any entry. */}
      {isLegacySession && (
        <div className="px-2 py-1 text-[10px] text-muted-foreground border-b border-border/60">
          {t("sessionCalendarPopover.legacySessionWarning")}
        </div>
      )}

      <div className="border-t border-border/70 px-1 py-2">
        <div className="mb-1 flex items-center justify-between gap-2 px-1">
          <span className="min-w-0 truncate text-[10px] font-medium text-muted-foreground">
            {t("sessionCalendarPopover.dateConversationsLabel", { date: selectedKey })}
          </span>
          <button
            type="button"
            onClick={() => setPickedDate(new Date())}
            className="shrink-0 rounded border border-border bg-muted/30 px-2 py-0.5 text-[10px] text-foreground/80 hover:bg-accent hover:text-accent-foreground"
          >
            {t("sessionCalendarPopover.todayButton")}
          </button>
        </div>

        {/* Step 4: Jump button for current-session messages on this date.
            Edge case 2: hidden when no current-session messages on date.
            Edge case 3: hidden for legacy sessions (no createdAt).
            Edge case 5: streaming guard is NOT applied here — jumping within
            the current session is always allowed regardless of streaming state. */}
        {!isLegacySession && currentSessionEntriesForDate.length > 0 && onJumpToEntry && (
          <button
            type="button"
            onClick={handleJumpToCurrentSession}
            className="mb-1 block w-full rounded px-2 py-1.5 text-left text-[11px] bg-primary/10 text-primary hover:bg-primary/20"
          >
            {t("sessionCalendarPopover.jumpToCurrentSession", { count: currentSessionEntriesForDate.length })}
            {currentSessionEntriesForDate.length > 1 && jumpCycleIdx > 0 && (
              <span className="ml-1 text-[10px] text-muted-foreground">
                ({(jumpCycleIdx % currentSessionEntriesForDate.length) + 1}/{currentSessionEntriesForDate.length})
              </span>
            )}
          </button>
        )}

        {sessionsForDate.length === 0 ? (
          <div className="px-1 py-1 text-[11px] text-muted-foreground">
            {t("sessionCalendarPopover.noSessionsForDate")}
          </div>
        ) : (
          <div className="max-h-32 space-y-1 overflow-y-auto">
            {sessionsForDate.map((session) => {
              const isCurrent = session.id === currentSessionId;
              return (
                <button
                  key={session.id}
                  type="button"
                  // Edge case 5: streaming && !isCurrent guard preserved (Step 6).
                  // Loading a DIFFERENT session mid-stream is blocked.
                  disabled={(streaming && !isCurrent) || !onLoadSession}
                  onClick={() => {
                    onOpenChange?.(false);
                    void onLoadSession?.(session.id);
                  }}
                  className={`block w-full rounded px-2 py-1.5 text-left text-[11px] hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50 ${
                    isCurrent
                      ? // Step 5: primary tone for current session row.
                        "bg-primary/15 text-foreground ring-1 ring-primary/30"
                      : "text-popover-foreground"
                  }`}
                >
                  <span className="block truncate">{session.title || t("sessionCalendarPopover.untitledSession")}</span>
                  <span className="block text-[10px] text-muted-foreground">
                    {formatHhMmKst(new Date(session.modifiedAt).getTime())}
                    {isCurrent ? ` · ${t("sessionCalendarPopover.currentSessionIndicator")}` : ""}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </PopoverContent>
  );
}

export { getKoreaDateKey };
