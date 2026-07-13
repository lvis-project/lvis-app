import { Suspense, useEffect, useMemo, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, MessageSquareText, Pin, RefreshCw, X as XIcon } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { Badge } from "../../../components/ui/badge.js";
import { ScrollArea } from "../../../components/ui/scroll-area.js";
import type { LvisApi } from "../types.js";
import { useTranslation } from "../../../i18n/react.js";
import type { SessionSummary } from "../hooks/use-sessions.js";
import type { ProjectIdentity } from "../../../shared/project-identity.js";
import { projectLabelForSession } from "../utils/insights-project-groups.js";
import { CalendarFallback, LazyCalendar } from "./LazyCalendar.js";

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

const KOREA_DATE_KEY_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function koreaDateKey(date: Date): string {
  const parts = KOREA_DATE_KEY_FORMATTER.formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function dateFromKey(dateKey: string): Date {
  const [year = "0", month = "1", day = "1"] = dateKey.split("-");
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 12));
}

function formatTokenCount(value: number | undefined): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(Math.max(0, value ?? 0));
}

function formatCost(value: number | undefined): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 4 }).format(Math.max(0, value ?? 0));
}

function formatSessionTime(value: string): string {
  return new Date(value).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
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
    const dateKey = day.toISOString().slice(0, 10);
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
    () => Number(koreaDateKey(new Date()).slice(0, 4)),
  );
  const [dailyUsage, setDailyUsage] = useState<UsageTotals | null>(null);
  const [dailyUsageConversations, setDailyUsageConversations] = useState<UsageConversation[]>([]);
  const [discoveredSessions, setDiscoveredSessions] = useState<SessionSummary[]>([]);
  const [yearlyUsageByDate, setYearlyUsageByDate] = useState<Map<string, number>>(() => new Map());
  const [llmSummary, setLlmSummary] = useState<string | null>(null);
  const [llmSummaryState, setLlmSummaryState] = useState<"idle" | "loading" | "error">("idle");
  const selectedKey = koreaDateKey(selectedDate);
  const todayKey = koreaDateKey(new Date());
  const currentYear = Number(todayKey.slice(0, 4));

  const allSessions = useMemo(() => {
    const byId = new Map(discoveredSessions.map((session) => [session.id, session]));
    for (const session of sessions) byId.set(session.id, session);
    return Array.from(byId.values());
  }, [discoveredSessions, sessions]);
  const sessionsForDay = useMemo(
    () => allSessions.filter((session) => koreaDateKey(new Date(session.modifiedAt)) === selectedKey),
    [allSessions, selectedKey],
  );
  const starredForDay = useMemo(
    () => starred.filter((item) => koreaDateKey(new Date(item.starredAt)) === selectedKey),
    [selectedKey, starred],
  );
  const activityDateKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const session of allSessions) keys.add(koreaDateKey(new Date(session.modifiedAt)));
    for (const item of starred) keys.add(koreaDateKey(new Date(item.starredAt)));
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
    const getUsageRange = (api as Partial<LvisApi>).getUsageRange;
    if (!getUsageRange) {
      setDailyUsage(null);
      setDailyUsageConversations([]);
      return;
    }
    void getUsageRange({ dateFrom: selectedKey, dateTo: selectedKey }).then((summary) => {
      if (cancelled) return;
      setDailyUsage(usageForDate(summary, selectedKey));
      setDailyUsageConversations(usageConversations(summary));
    }).catch(() => {
      if (!cancelled) {
        setDailyUsage(null);
        setDailyUsageConversations([]);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [api, selectedKey]);

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
        tokens: formatTokenCount(dailyUsage?.totalTokens),
      })
    : t("starredView.dailySummaryEmpty", { date: selectedKey });
  const summaryPayload = useMemo(() => ({
    date: selectedKey,
    locale: typeof navigator === "undefined" ? "ko-KR" : navigator.language,
    sessions: conversationsForDay.slice(0, 12).map((conversation) => ({
      title: conversation.title,
      projectName: conversation.projectName,
    })),
    starred: starredForDay.slice(0, 12).map((item) => ({
      role: item.role,
      text: item.text,
    })),
    usage: dailyUsage,
  }), [conversationsForDay, dailyUsage, selectedKey, starredForDay]);

  useEffect(() => {
    let cancelled = false;
    const getUsageDailySummary = (api as Partial<LvisApi>).getUsageDailySummary;
    if (!getUsageDailySummary || !hasDailySignal) {
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
  }, [api, hasDailySignal, summaryPayload]);

  const summaryText = llmSummary ?? localSummaryText;

  return (
    <div data-testid="insights-scroll-root" className="mx-auto flex min-h-0 min-w-0 flex-1 w-full max-w-6xl flex-col overflow-y-auto [scrollbar-gutter:stable] pb-8">
      <div className="flex shrink-0 flex-col gap-3 pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold tracking-normal text-foreground">{t("starredView.title")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t("starredView.description")}</p>
        </div>
        <Button size="sm" variant="outline" className="gap-1.5" onClick={() => void refreshStarred()}>
          <RefreshCw className="h-3.5 w-3.5" />
          {t("starredView.refresh")}
        </Button>
      </div>
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
              timeZone="Asia/Seoul"
              selected={selectedDate}
              month={calendarMonth}
              onMonthChange={(month) => {
                setCalendarMonth(month);
                setVisibleYear(Number(koreaDateKey(month).slice(0, 4)));
              }}
              onSelect={(date) => {
                if (!date) return;
                setSelectedDate(date);
                setCalendarMonth(date);
                setVisibleYear(Number(koreaDateKey(date).slice(0, 4)));
              }}
              disabled={(date) => {
                const dateKey = koreaDateKey(date);
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
            <p className="mt-3 text-2xl font-semibold text-foreground">{formatTokenCount(dailyUsage?.totalTokens)}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {formatTokenCount(dailyUsage?.inputTokens)} / {formatTokenCount(dailyUsage?.outputTokens)} · {formatCost(dailyUsage?.cost)}
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
                    title={t("starredView.heatmapDay", { date: cell.dateKey, tokens: formatTokenCount(cell.tokens) })}
                    aria-label={t("starredView.heatmapDay", { date: cell.dateKey, tokens: formatTokenCount(cell.tokens) })}
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

      <div data-testid="insights-lists-grid" className="mt-4 grid shrink-0 gap-4 lg:h-[22rem] lg:min-h-[22rem] lg:grid-cols-2">
        <section data-testid="insights-conversations-panel" className="flex h-[22rem] min-h-0 flex-col overflow-hidden rounded-md border bg-background lg:h-full">
          <div className="flex items-center justify-between border-b px-3 py-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t("starredView.sessionsTitle")}</h3>
            <span className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-muted px-1.5 text-[10px] font-semibold text-muted-foreground">
              {conversationsForDay.length}
            </span>
          </div>
          <ScrollArea className="min-h-0 flex-1">
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
                        <span className="shrink-0">{formatTokenCount(conversation.totalTokens)} {t("starredView.tokensTitle")}</span>
                      ) : conversation.modifiedAt ? (
                        <span className="shrink-0">{formatSessionTime(conversation.modifiedAt)}</span>
                      ) : null}
                      <span className="ml-auto shrink-0 font-mono opacity-60" title={conversation.sessionId}>
                        #{conversation.sessionId.slice(0, 8)}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </ScrollArea>
        </section>

        <section data-testid="insights-pins-panel" className="flex h-[22rem] min-h-0 flex-col overflow-hidden rounded-md border bg-background lg:h-full">
          <div className="flex items-center justify-between border-b px-3 py-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t("starredView.starredTitle")}</h3>
            <span className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-muted px-1.5 text-[10px] font-semibold text-muted-foreground">
              {starredForDay.length}
            </span>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            {starredForDay.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">{t("starredView.emptyState")}</div>
            ) : (
              <div className="space-y-2 p-2">
                {starredForDay.map((s) => (
                  <div key={s.id} className="rounded-md border bg-muted/(--opacity-light) transition-colors hover:border-border">
                    <div className="flex items-center gap-2 border-b px-3 py-1.5 text-[11px] text-muted-foreground">
                      <Badge variant="outline" className="text-[10px]">{s.role}</Badge>
                      <span>{new Date(s.starredAt).toLocaleString("ko-KR")}</span>
                      <span className="font-mono opacity-60">#{s.sessionId.slice(0, 8)}</span>
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
