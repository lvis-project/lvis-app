import { Suspense, useEffect, useMemo, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, MessageSquareText, Pin, RefreshCw, X as XIcon } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { Badge } from "../../../components/ui/badge.js";
import { ScrollArea } from "../../../components/ui/scroll-area.js";
import type { LvisApi, UsageSummaryShape } from "../types.js";
import { useTranslation } from "../../../i18n/react.js";
import type { SessionSummary } from "../hooks/use-sessions.js";
import type { ProjectIdentity } from "../../../shared/project-identity.js";
import { projectLabelForSession } from "../utils/insights-project-groups.js";
import { CalendarFallback, LazyCalendar } from "./LazyCalendar.js";
import { localDateKey, localDayStart, utcDateKey } from "../../../shared/local-date.js";
import { formatCost, formatTokensExact } from "../../../lib/cost-format.js";
import { formatHhMm, formatMediumDateTime, formatMonthYear } from "../../../shared/format-time.js";
import { InsightsUsageBreakdown } from "./InsightsUsageBreakdown.js";
import { shortSessionId } from "../../../shared/session-lookup.js";
import { usePaneActions } from "./PaneFrame.js";

export interface StarredItem {
  id: string;
  sessionId: string;
  messageIndex: number;
  role: string;
  text: string;
  starredAt: string;
}

export interface StarredViewProps {
  api: LvisApi;
  starred: StarredItem[];
  sessions?: SessionSummary[];
  workspaceProjects?: readonly ProjectIdentity[];
  currentSessionId: string;
  refreshStarred: () => void | Promise<void>;
  onJumpToSession: (sessionId: string) => boolean | void | Promise<boolean | void>;
  onActivateHome: () => void;
}

interface UsageTotals {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  cost?: number;
}

interface DailyUsageResult {
  source: Partial<LvisApi>["getUsageRange"];
  dateKey: string;
  usage: UsageTotals | null;
  conversations: UsageConversation[];
}

interface MonthlyUsageResult {
  source: Partial<LvisApi>["getUsageRange"];
  monthKey: string;
  summary: Partial<UsageSummaryShape> | null;
  error: boolean;
}

interface HeatmapCell {
  key: string;
  dateKey?: string;
  tokens?: number;
  level?: number;
}

interface UsageConversation extends UsageTotals {
  sessionId: string;
  turns: number;
  firstInput?: string;
}

const EMPTY_USAGE_CONVERSATIONS: UsageConversation[] = [];

interface InsightConversation {
  sessionId: string;
  title: string;
  projectName?: string;
  modifiedAt?: string;
  totalTokens?: number;
  turns?: number;
}

interface HeatmapMonthLabel {
  column: number;
  label: string;
}


/**
 * Add the civil day of `timestamp` to `keys`, skipping a timestamp that is not
 * an instant at all.
 *
 * `modifiedAt` and `starredAt` are read back off disk, so a truncated or
 * hand-edited record can carry a string `Date` cannot parse. `localDateKey` of
 * an Invalid Date is the string `"0NaN-NaN-NaN"`, which is not a day — it would
 * flow into the calendar's activity matchers and reach `dateFromKey`. Rejecting
 * it here keeps the bad value out at the boundary it enters, rather than making
 * `dateFromKey` tolerant of input that means nothing.
 */
function addDayKey(keys: Set<string>, timestamp: string): void {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return;
  keys.add(localDateKey(parsed));
}

/**
 * A `YYYY-MM-DD` key as the local `Date` the calendar and its month label read.
 *
 * Local, not UTC noon: the calendar reads the `Date` with local getters, and a
 * midpoint only happens to land on the right day for offsets inside ±12h.
 * Every key reaching here came from `localDateKey` or `monthRange`, so the
 * throw is an assertion about that, not a case to handle.
 */
function dateFromKey(dateKey: string): Date {
  const start = localDayStart(dateKey);
  if (start === null) throw new Error(`[starred-view] not a date key: ${dateKey}`);
  return start;
}

function monthRange(date: Date): { monthKey: string; dateFrom: string; dateTo: string } {
  const monthKey = localDateKey(date).slice(0, 7);
  const [year = 0, month = 1] = monthKey.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    monthKey,
    dateFrom: `${monthKey}-01`,
    dateTo: `${monthKey}-${String(lastDay).padStart(2, "0")}`,
  };
}

function usageForDate(summary: unknown, dateKey: string): UsageTotals | null {
  const shaped = summary as { today?: UsageTotals; trend?: Array<UsageTotals & { date?: string }> } | null | undefined;
  const trendForDate = shaped?.trend?.find((point) => point.date === dateKey);
  return trendForDate ?? shaped?.today ?? null;
}

function usageTrendByDate(summary: unknown, year: number): Map<string, number> {
  const shaped = summary as { trend?: Array<UsageTotals & { date?: string }> } | null | undefined;
  const next = new Map<string, number>();
  const prefix = `${year}-`;
  for (const point of shaped?.trend ?? []) {
    if (!point.date?.startsWith(prefix)) continue;
    next.set(point.date, Math.max(0, point.totalTokens ?? 0));
  }
  return next;
}

function usageConversations(summary: unknown): UsageConversation[] {
  const shaped = summary as { topConversations?: UsageConversation[] } | null | undefined;
  return (shaped?.topConversations ?? []).filter((conversation) => Boolean(conversation.sessionId));
}

function buildYearHeatmap(year: number, usageByDate: Map<string, number>): HeatmapCell[] {
  const first = new Date(Date.UTC(year, 0, 1));
  const last = new Date(Date.UTC(year, 11, 31));
  const maxTokens = Math.max(0, ...usageByDate.values());
  const cells: HeatmapCell[] = Array.from({ length: first.getUTCDay() }, (_, index) => ({ key: `blank-${index}` }));
  for (const day = new Date(first); day <= last; day.setUTCDate(day.getUTCDate() + 1)) {
    const dateKey = utcDateKey(day);
    const tokens = usageByDate.get(dateKey) ?? 0;
    const ratio = maxTokens > 0 ? tokens / maxTokens : 0;
    const level = tokens <= 0 ? 0 : ratio >= 0.75 ? 4 : ratio >= 0.5 ? 3 : ratio >= 0.25 ? 2 : 1;
    cells.push({ key: dateKey, dateKey, tokens, level });
  }
  return cells;
}

function buildHeatmapMonthLabels(year: number, locale: string): HeatmapMonthLabel[] {
  const yearStart = Date.UTC(year, 0, 1);
  const firstDayOffset = new Date(yearStart).getUTCDay();
  const formatter = new Intl.DateTimeFormat(locale, { month: "short", timeZone: "UTC" });
  return Array.from({ length: 12 }, (_, month) => {
    const firstOfMonth = Date.UTC(year, month, 1);
    const dayOfYear = Math.round((firstOfMonth - yearStart) / 86_400_000);
    return {
      column: Math.floor((firstDayOffset + dayOfYear) / 7) + 1,
      label: formatter.format(new Date(firstOfMonth)),
    };
  });
}

function buildHeatmapWeekdays(locale: string): string[] {
  const formatter = new Intl.DateTimeFormat(locale, { weekday: "narrow", timeZone: "UTC" });
  return Array.from({ length: 7 }, (_, index) =>
    formatter.format(new Date(Date.UTC(2024, 0, 7 + index))),
  );
}

const TOKEN_HEAT_CLASS = [
  "bg-muted/(--opacity-light)",
  "bg-primary/(--opacity-faint)",
  "bg-primary/(--opacity-subtle)",
  "bg-primary/(--opacity-soft)",
  "bg-primary/(--opacity-intense)",
] as const;

export function StarredView({
  api,
  starred,
  sessions = [],
  workspaceProjects,
  currentSessionId,
  refreshStarred,
  onJumpToSession,
  onActivateHome,
}: StarredViewProps) {
  const { locale, t } = useTranslation();
  const [selectedDate, setSelectedDate] = useState<Date>(() => new Date());
  const [calendarMonth, setCalendarMonth] = useState<Date>(() => new Date());
  const [visibleYear, setVisibleYear] = useState<number>(
    () => Number(localDateKey(new Date()).slice(0, 4)),
  );
  const [dailyUsageResult, setDailyUsageResult] = useState<DailyUsageResult | null>(null);
  const [monthlyUsageResult, setMonthlyUsageResult] = useState<MonthlyUsageResult | null>(null);
  const [discoveredSessions, setDiscoveredSessions] = useState<SessionSummary[]>([]);
  const [yearlyUsageByDate, setYearlyUsageByDate] = useState<Map<string, number>>(() => new Map());
  const [llmSummary, setLlmSummary] = useState<string | null>(null);
  const [llmSummaryState, setLlmSummaryState] = useState<"idle" | "loading" | "error">("idle");
  const selectedKey = localDateKey(selectedDate);
  const todayKey = localDateKey(new Date());
  const currentYear = Number(todayKey.slice(0, 4));
  const getUsageRange = (api as Partial<LvisApi>).getUsageRange;
  const monthlyRange = useMemo(() => monthRange(calendarMonth), [calendarMonth]);
  const monthlyLabel = useMemo(
    () => formatMonthYear(dateFromKey(monthlyRange.dateFrom), locale),
    [locale, monthlyRange.dateFrom],
  );
  const currentMonthlyUsageResult = (
    monthlyUsageResult?.source === getUsageRange
      && monthlyUsageResult?.monthKey === monthlyRange.monthKey
  ) ? monthlyUsageResult : null;
  const currentDailyUsageResult = (
    dailyUsageResult?.source === getUsageRange && dailyUsageResult?.dateKey === selectedKey
  ) ? dailyUsageResult : null;
  const dailyUsageReady = !getUsageRange || currentDailyUsageResult !== null;
  const dailyUsage = currentDailyUsageResult?.usage ?? null;
  const dailyUsageConversations = currentDailyUsageResult?.conversations
    ?? EMPTY_USAGE_CONVERSATIONS;

  const allSessions = useMemo(() => {
    const byId = new Map(discoveredSessions.map((session) => [session.id, session]));
    for (const session of sessions) byId.set(session.id, session);
    return Array.from(byId.values());
  }, [discoveredSessions, sessions]);
  const sessionsForDay = useMemo(
    () => allSessions.filter((session) => localDateKey(new Date(session.modifiedAt)) === selectedKey),
    [allSessions, selectedKey],
  );
  const starredForDay = useMemo(
    () => starred.filter((item) => localDateKey(new Date(item.starredAt)) === selectedKey),
    [selectedKey, starred],
  );
  const activityDateKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const session of allSessions) addDayKey(keys, session.modifiedAt);
    for (const item of starred) addDayKey(keys, item.starredAt);
    // Usage keys are already `localDateKey` output over a validated instant —
    // `computeUsageSummary` skips an entry whose timestamp does not parse — so
    // they need no second check here.
    for (const [dateKey, tokens] of yearlyUsageByDate) if (tokens > 0) keys.add(dateKey);
    return keys;
  }, [allSessions, starred, yearlyUsageByDate]);
  const activityMatchers = useMemo(
    () => Array.from(activityDateKeys).map(dateFromKey),
    [activityDateKeys],
  );

  const conversationsForDay = useMemo<InsightConversation[]>(() => {
    const sessionById = new Map(allSessions.map((session) => [session.id, session]));
    const byId = new Map<string, InsightConversation>();
    for (const usage of dailyUsageConversations) {
      const session = sessionById.get(usage.sessionId);
      const projectName = session ? projectLabelForSession(session, workspaceProjects) : undefined;
      byId.set(usage.sessionId, {
        sessionId: usage.sessionId,
        title: session?.title?.trim() || usage.firstInput?.trim() || t("starredView.untitledSession"),
        ...(projectName ? { projectName } : {}),
        ...(session?.modifiedAt ? { modifiedAt: session.modifiedAt } : {}),
        totalTokens: usage.totalTokens,
        turns: usage.turns,
      });
    }
    for (const session of sessionsForDay) {
      if (byId.has(session.id)) continue;
      const projectName = projectLabelForSession(session, workspaceProjects);
      byId.set(session.id, {
        sessionId: session.id,
        title: session.title?.trim() || t("starredView.untitledSession"),
        ...(projectName ? { projectName } : {}),
        modifiedAt: session.modifiedAt,
      });
    }
    return Array.from(byId.values()).sort(
      (a, b) =>
        (b.totalTokens ?? -1) - (a.totalTokens ?? -1) ||
        (b.modifiedAt ?? "").localeCompare(a.modifiedAt ?? ""),
    );
  }, [allSessions, dailyUsageConversations, sessionsForDay, t, workspaceProjects]);

  const heatmapCells = useMemo(() => buildYearHeatmap(visibleYear, yearlyUsageByDate), [visibleYear, yearlyUsageByDate]);
  const heatmapMonthLabels = useMemo(
    () => buildHeatmapMonthLabels(visibleYear, locale),
    [locale, visibleYear],
  );
  const heatmapWeekdays = useMemo(() => buildHeatmapWeekdays(locale), [locale]);
  const heatmapWeekCount = Math.ceil(heatmapCells.length / 7);

  useEffect(() => {
    let cancelled = false;
    if (typeof api.chatSessions !== "function") return;
    void api.chatSessions({ kind: "main", limit: 100 }).then((result) => {
      if (!cancelled) setDiscoveredSessions(result.sessions);
    }).catch(() => {
      if (!cancelled) setDiscoveredSessions([]);
    });
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    let cancelled = false;
    if (!getUsageRange) {
      return;
    }
    void getUsageRange({ dateFrom: selectedKey, dateTo: selectedKey }).then((summary) => {
      if (cancelled) return;
      setDailyUsageResult({
        source: getUsageRange,
        dateKey: selectedKey,
        usage: usageForDate(summary, selectedKey),
        conversations: usageConversations(summary),
      });
    }).catch(() => {
      if (!cancelled) {
        setDailyUsageResult({
          source: getUsageRange,
          dateKey: selectedKey,
          usage: null,
          conversations: [],
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [getUsageRange, selectedKey]);

  useEffect(() => {
    let cancelled = false;
    if (!getUsageRange) return;
    void getUsageRange({
      dateFrom: monthlyRange.dateFrom,
      dateTo: monthlyRange.dateTo,
    }).then((summary) => {
      if (cancelled) return;
      setMonthlyUsageResult({
        source: getUsageRange,
        monthKey: monthlyRange.monthKey,
        summary,
        error: false,
      });
    }).catch(() => {
      if (cancelled) return;
      setMonthlyUsageResult({
        source: getUsageRange,
        monthKey: monthlyRange.monthKey,
        summary: null,
        error: true,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [getUsageRange, monthlyRange.dateFrom, monthlyRange.dateTo, monthlyRange.monthKey]);

  useEffect(() => {
    let cancelled = false;
    const getUsageRange = (api as Partial<LvisApi>).getUsageRange;
    if (!getUsageRange) {
      setYearlyUsageByDate(new Map());
      return;
    }
    void getUsageRange({
      dateFrom: `${visibleYear}-01-01`,
      dateTo: `${visibleYear}-12-31`,
    }).then((summary) => {
      if (cancelled) return;
      setYearlyUsageByDate(usageTrendByDate(summary, visibleYear));
    }).catch(() => {
      if (!cancelled) setYearlyUsageByDate(new Map());
    });
    return () => {
      cancelled = true;
    };
  }, [api, visibleYear]);

  const hasDailySignal = conversationsForDay.length > 0 || starredForDay.length > 0 || (dailyUsage?.totalTokens ?? 0) > 0;
  const localSummaryText = hasDailySignal
    ? t("starredView.dailySummary", {
        date: selectedKey,
        sessions: conversationsForDay.length,
        starred: starredForDay.length,
        tokens: formatTokensExact(dailyUsage?.totalTokens),
      })
    : t("starredView.dailySummaryEmpty", { date: selectedKey });
  const summaryPayload = useMemo(() => ({
    date: selectedKey,
    locale,
    sessions: conversationsForDay.slice(0, 12).map((conversation) => ({
      title: conversation.title,
      projectName: conversation.projectName,
    })),
    starred: starredForDay.slice(0, 12).map((item) => ({
      role: item.role,
      text: item.text,
    })),
    usage: dailyUsage,
  }), [conversationsForDay, dailyUsage, locale, selectedKey, starredForDay]);

  useEffect(() => {
    let cancelled = false;
    const getUsageDailySummary = (api as Partial<LvisApi>).getUsageDailySummary;
    if (!getUsageDailySummary || !hasDailySignal || !dailyUsageReady) {
      setLlmSummary(null);
      setLlmSummaryState("idle");
      return;
    }
    setLlmSummary(null);
    setLlmSummaryState("loading");
    void getUsageDailySummary(summaryPayload).then((result) => {
      if (cancelled) return;
      if (result?.ok && result.summary.trim()) {
        setLlmSummary(result.summary.trim());
        setLlmSummaryState("idle");
        return;
      }
      setLlmSummaryState("error");
    }).catch(() => {
      if (!cancelled) setLlmSummaryState("error");
    });
    return () => {
      cancelled = true;
    };
  }, [api, dailyUsageReady, hasDailySignal, summaryPayload]);

  const summaryText = llmSummary ?? localSummaryText;

  // The view's one global control, drawn by the pane header now that the
  // heading it stood beside is the header's own title.
  usePaneActions(useMemo(() => [
    {
      id: "insights-refresh",
      label: t("starredView.refresh"),
      icon: <RefreshCw className="h-4 w-4" />,
      onSelect: () => void refreshStarred(),
    },
  ], [t, refreshStarred]));

  return (
    <div data-testid="insights-scroll-root" className="mx-auto flex min-h-0 min-w-0 flex-1 w-full max-w-6xl flex-col overflow-y-auto [scrollbar-gutter:stable] pb-8">
      <p className="shrink-0 pb-4 text-sm text-muted-foreground">{t("starredView.description")}</p>
      <div data-testid="insights-overview-grid" className="grid min-h-0 shrink-0 gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <section className="min-h-0 rounded-md border bg-background p-2">
          <div className="mb-2 flex items-center gap-2 px-1 text-sm font-semibold text-foreground">
            <CalendarDays className="h-4 w-4 text-primary" />
            {t("starredView.calendarTitle")}
          </div>
          <Suspense fallback={<CalendarFallback />}>
            <LazyCalendar
              data-testid="insights-calendar"
              mode="single"
              selected={selectedDate}
              month={calendarMonth}
              onMonthChange={(month) => {
                setCalendarMonth(month);
                setVisibleYear(Number(localDateKey(month).slice(0, 4)));
              }}
              onSelect={(date) => {
                if (!date) return;
                setSelectedDate(date);
                setCalendarMonth(date);
                setVisibleYear(Number(localDateKey(date).slice(0, 4)));
              }}
              disabled={(date) => {
                const dateKey = localDateKey(date);
                return dateKey > todayKey || !activityDateKeys.has(dateKey);
              }}
              modifiers={{ hasActivity: activityMatchers }}
              modifiersClassNames={{
                hasActivity:
                  "after:absolute after:bottom-0.5 after:left-1/2 after:h-1 after:w-1 after:-translate-x-1/2 after:rounded-full after:bg-primary [&>button]:font-semibold",
              }}
            />
          </Suspense>
        </section>

        <div className="grid gap-4 md:grid-cols-3">
          <section className="rounded-md border bg-background p-3 md:col-span-3">
            <h3 className="mb-1 text-sm font-semibold text-foreground">{t("starredView.dailySummaryTitle")}</h3>
            <p className="text-sm leading-6 text-muted-foreground">{summaryText}</p>
            {llmSummaryState === "loading" && (
              <p className="mt-2 text-xs text-muted-foreground">{t("starredView.dailySummaryGenerating")}</p>
            )}
            {llmSummaryState === "error" && hasDailySignal && (
              <p className="mt-2 text-xs text-muted-foreground">{t("starredView.dailySummaryFallback")}</p>
            )}
          </section>
          <section className="rounded-md border bg-background p-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <MessageSquareText className="h-4 w-4 text-primary" />
              {t("starredView.sessionsTitle")}
            </div>
            <p className="mt-3 text-2xl font-semibold text-foreground">{conversationsForDay.length}</p>
          </section>
          <section className="rounded-md border bg-background p-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Pin className="h-4 w-4 text-primary" />
              {t("starredView.starredTitle")}
            </div>
            <p className="mt-3 text-2xl font-semibold text-foreground">{starredForDay.length}</p>
          </section>
          <section className="rounded-md border bg-background p-3">
            <h3 className="text-sm font-semibold text-foreground">{t("starredView.tokensTitle")}</h3>
            <p className="mt-3 text-2xl font-semibold text-foreground">{formatTokensExact(dailyUsage?.totalTokens)}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {formatTokensExact(dailyUsage?.inputTokens)} / {formatTokensExact(dailyUsage?.outputTokens)} · {formatCost(dailyUsage?.cost ?? 0)}
            </p>
          </section>
        </div>
      </div>

      <section data-testid="insights-heatmap" className="mt-4 shrink-0 rounded-md border bg-background p-3">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-foreground">{t("starredView.heatmapTitle")}</h3>
            <p className="text-xs text-muted-foreground">{t("starredView.heatmapYear", { year: visibleYear })}</p>
          </div>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              title={t("starredView.previousYear")}
              onClick={() => {
                const year = visibleYear - 1;
                setVisibleYear(year);
                setCalendarMonth(dateFromKey(`${year}-01-01`));
              }}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              title={t("starredView.nextYear")}
              disabled={visibleYear >= currentYear}
              onClick={() => {
                const year = visibleYear + 1;
                setVisibleYear(year);
                setCalendarMonth(dateFromKey(`${year}-01-01`));
              }}
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
        <div className="overflow-x-auto pb-1">
          <div className="min-w-max">
            <div
              data-testid="heatmap-month-labels"
              className="mb-1 grid h-4 gap-1 pl-7 text-[10px] leading-4 text-muted-foreground"
              style={{ gridTemplateColumns: `repeat(${heatmapWeekCount}, 0.625rem)` }}
            >
              {heatmapMonthLabels.map((month) => (
                <span
                  key={`${month.column}-${month.label}`}
                  className="whitespace-nowrap"
                  style={{ gridColumn: `${month.column} / span 4` }}
                >
                  {month.label}
                </span>
              ))}
            </div>
            <div className="flex gap-2">
              <div
                data-testid="heatmap-weekday-labels"
                className="grid w-5 shrink-0 grid-rows-7 gap-1 text-[10px] leading-[0.625rem] text-muted-foreground"
              >
                {heatmapWeekdays.map((weekday, index) => (
                  <span key={`${weekday}-${index}`}>{weekday}</span>
                ))}
              </div>
              <div className="grid grid-flow-col grid-rows-7 gap-1" style={{ gridAutoColumns: "0.625rem" }}>
                {heatmapCells.map((cell) => cell.dateKey ? (
                  <button
                    key={cell.key}
                    type="button"
                    className={`h-2.5 w-2.5 rounded-[2px] transition-transform hover:scale-125 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:hover:scale-100 ${TOKEN_HEAT_CLASS[cell.level ?? 0]} ${cell.dateKey === selectedKey ? "ring-1 ring-foreground" : ""}`}
                    title={t("starredView.heatmapDay", { date: cell.dateKey, tokens: formatTokensExact(cell.tokens) })}
                    aria-label={t("starredView.heatmapDay", { date: cell.dateKey, tokens: formatTokensExact(cell.tokens) })}
                    disabled={!activityDateKeys.has(cell.dateKey)}
                    onClick={() => {
                      const date = dateFromKey(cell.dateKey!);
                      setSelectedDate(date);
                      setCalendarMonth(date);
                    }}
                  />
                ) : (
                  <span key={cell.key} className="h-2.5 w-2.5" aria-hidden="true" />
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      <InsightsUsageBreakdown
        summary={currentMonthlyUsageResult?.summary ?? null}
        monthLabel={monthlyLabel}
        loading={Boolean(getUsageRange && !currentMonthlyUsageResult)}
        error={currentMonthlyUsageResult?.error ?? false}
      />

      <div data-testid="insights-lists-grid" className="mt-4 grid shrink-0 gap-4 lg:h-(--insights-panel-height) lg:min-h-(--insights-panel-height) lg:grid-cols-2">
        <section data-testid="insights-conversations-panel" className="flex h-(--insights-panel-height) min-h-0 flex-col overflow-hidden rounded-md border bg-background lg:h-full">
          <div className="flex items-center justify-between border-b px-3 py-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t("starredView.sessionsTitle")}</h3>
            <span className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-muted px-1.5 text-[10px] font-semibold text-muted-foreground">
              {conversationsForDay.length}
            </span>
          </div>
          <ScrollArea
            /* Radix wraps the viewport content in a `display: table` div that sizes to
               max-content, so a long unbreakable title makes the row wider than the
               panel and the viewport clips it — row-level `truncate` never gets to
               produce its ellipsis. Force that wrapper back to block, the same way
               the sidebar's session list does. */
            className="min-h-0 flex-1 [&_[data-radix-scroll-area-viewport]>div]:!block [&_[data-radix-scroll-area-viewport]>div]:!min-w-0"
          >
            {conversationsForDay.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">{t("starredView.projectChatsEmpty")}</div>
            ) : (
              <div className="space-y-1.5 p-2">
                {conversationsForDay.map((conversation) => (
                  <button
                    key={conversation.sessionId}
                    type="button"
                    className="w-full rounded-md border bg-muted/(--opacity-light) px-3 py-2 text-left transition-colors hover:border-border hover:bg-muted/(--opacity-muted) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={async () => {
                      if (conversation.sessionId !== currentSessionId) {
                        const jumped = await onJumpToSession(conversation.sessionId);
                        if (jumped === false) return;
                      }
                      onActivateHome();
                    }}
                  >
                    <span className="block truncate text-sm font-semibold text-foreground">{conversation.title}</span>
                    <span className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                      {conversation.projectName ? <span className="truncate">{conversation.projectName}</span> : null}
                      {conversation.totalTokens !== undefined ? (
                        <span className="shrink-0">{formatTokensExact(conversation.totalTokens)} {t("starredView.tokensTitle")}</span>
                      ) : conversation.modifiedAt ? (
                        <span className="shrink-0">{formatHhMm(conversation.modifiedAt)}</span>
                      ) : null}
                      <span className="ml-auto shrink-0 font-mono opacity-60" title={conversation.sessionId}>
                        #{shortSessionId(conversation.sessionId)}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </ScrollArea>
        </section>

        <section data-testid="insights-pins-panel" className="flex h-(--insights-panel-height) min-h-0 flex-col overflow-hidden rounded-md border bg-background lg:h-full">
          <div className="flex items-center justify-between border-b px-3 py-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t("starredView.starredTitle")}</h3>
            <span className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-muted px-1.5 text-[10px] font-semibold text-muted-foreground">
              {starredForDay.length}
            </span>
          </div>
          <ScrollArea
            /* Radix wraps the viewport content in a `display: table` div that sizes to
               max-content, so a long unbreakable title makes the row wider than the
               panel and the viewport clips it — row-level `truncate` never gets to
               produce its ellipsis. Force that wrapper back to block, the same way
               the sidebar's session list does. */
            className="min-h-0 flex-1 [&_[data-radix-scroll-area-viewport]>div]:!block [&_[data-radix-scroll-area-viewport]>div]:!min-w-0"
          >
            {starredForDay.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">{t("starredView.emptyState")}</div>
            ) : (
              <div className="space-y-2 p-2">
                {starredForDay.map((s) => (
                  <div key={s.id} className="rounded-md border bg-muted/(--opacity-light) transition-colors hover:border-border">
                    <div className="flex items-center gap-2 border-b px-3 py-1.5 text-[11px] text-muted-foreground">
                      <Badge variant="outline" className="text-[10px]">{s.role}</Badge>
                      <span>{formatMediumDateTime(s.starredAt)}</span>
                      <span className="font-mono opacity-60">#{shortSessionId(s.sessionId)}</span>
                      <Button variant="ghost" size="icon-xs" className="ml-auto hover:bg-muted" title={t("starredView.unstar")} onClick={() => { void api.starredRemove({ id: s.id }).then(() => refreshStarred()); }}>
                        <XIcon className="h-3 w-3" />
                      </Button>
                    </div>
                    <button
                      className="w-full whitespace-pre-wrap break-words p-3 text-left text-sm font-semibold leading-snug text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring hover:opacity-80"
                      onClick={async () => {
                        if (s.sessionId !== currentSessionId) {
                          const jumped = await onJumpToSession(s.sessionId);
                          if (jumped === false) return;
                        }
                        onActivateHome();
                      }}
                    >{s.text.slice(0, 300)}{s.text.length > 300 ? "…" : ""}</button>
                  </div>
                ))}
              </div>
            )}
          </ScrollArea>
        </section>
      </div>
    </div>
  );
}
