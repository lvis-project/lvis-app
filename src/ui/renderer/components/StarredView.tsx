import { Suspense, useEffect, useMemo, useState } from "react";
import { CalendarDays, MessageSquareText, RefreshCw, Star, X as XIcon } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { Badge } from "../../../components/ui/badge.js";
import { ScrollArea } from "../../../components/ui/scroll-area.js";
import type { LvisApi } from "../types.js";
import { useTranslation } from "../../../i18n/react.js";
import type { SessionSummary } from "../hooks/use-sessions.js";
import { CalendarFallback, LazyCalendar } from "./LazyCalendar.js";
import { dateFromKey } from "./SessionCalendarPopover.js";

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

function formatTokenCount(value: number | undefined): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(Math.max(0, value ?? 0));
}

function formatCost(value: number | undefined): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 4 }).format(Math.max(0, value ?? 0));
}

function usageForDate(summary: unknown, dateKey: string): UsageTotals | null {
  const shaped = summary as { today?: UsageTotals; trend?: Array<UsageTotals & { date?: string }> } | null | undefined;
  const trendForDate = shaped?.trend?.find((point) => point.date === dateKey);
  return trendForDate ?? shaped?.today ?? null;
}

export function StarredView({
  api,
  starred,
  sessions = [],
  currentSessionId,
  refreshStarred,
  onJumpToSession,
  onActivateHome,
}: StarredViewProps) {
  const { t } = useTranslation();
  const [selectedDate, setSelectedDate] = useState<Date>(() => new Date());
  const [dailyUsage, setDailyUsage] = useState<UsageTotals | null>(null);
  const [llmSummary, setLlmSummary] = useState<string | null>(null);
  const [llmSummaryState, setLlmSummaryState] = useState<"idle" | "loading" | "error">("idle");
  const selectedKey = koreaDateKey(selectedDate);

  const sessionsForDay = useMemo(
    () => sessions.filter((session) => koreaDateKey(new Date(session.modifiedAt)) === selectedKey),
    [selectedKey, sessions],
  );
  const starredForDay = useMemo(
    () => starred.filter((item) => koreaDateKey(new Date(item.starredAt)) === selectedKey),
    [selectedKey, starred],
  );
  const activityMatchers = useMemo(() => {
    const keys = new Set<string>();
    for (const session of sessions) keys.add(koreaDateKey(new Date(session.modifiedAt)));
    for (const item of starred) keys.add(koreaDateKey(new Date(item.starredAt)));
    return Array.from(keys).map(dateFromKey);
  }, [sessions, starred]);

  useEffect(() => {
    let cancelled = false;
    const getUsageRange = (api as Partial<LvisApi>).getUsageRange;
    if (!getUsageRange) {
      setDailyUsage(null);
      return;
    }
    void getUsageRange({ dateFrom: selectedKey, dateTo: selectedKey }).then((summary) => {
      if (cancelled) return;
      setDailyUsage(usageForDate(summary, selectedKey));
    }).catch(() => {
      if (!cancelled) setDailyUsage(null);
    });
    return () => {
      cancelled = true;
    };
  }, [api, selectedKey]);

  const hasDailySignal = sessionsForDay.length > 0 || starredForDay.length > 0 || (dailyUsage?.totalTokens ?? 0) > 0;
  const localSummaryText = hasDailySignal
    ? t("starredView.dailySummary", {
        date: selectedKey,
        sessions: sessionsForDay.length,
        starred: starredForDay.length,
        tokens: formatTokenCount(dailyUsage?.totalTokens),
      })
    : t("starredView.dailySummaryEmpty", { date: selectedKey });
  const summaryPayload = useMemo(() => ({
    date: selectedKey,
    locale: typeof navigator === "undefined" ? "ko-KR" : navigator.language,
    sessions: sessionsForDay.slice(0, 12).map((session) => ({
      title: session.title,
      projectName: session.projectName,
    })),
    starred: starredForDay.slice(0, 12).map((item) => ({
      role: item.role,
      text: item.text,
    })),
    usage: dailyUsage,
  }), [dailyUsage, selectedKey, sessionsForDay, starredForDay]);

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
    <div className="mx-auto flex min-h-0 min-w-0 flex-1 w-full max-w-6xl flex-col overflow-hidden">
      <div className="flex flex-col gap-3 pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold tracking-normal text-foreground">{t("starredView.title")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t("starredView.description")}</p>
        </div>
        <Button size="sm" variant="outline" className="gap-1.5" onClick={() => void refreshStarred()}>
          <RefreshCw className="h-3.5 w-3.5" />
          {t("starredView.refresh")}
        </Button>
      </div>
      <div className="grid min-h-0 gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <section className="min-h-0 rounded-md border bg-background p-2">
          <div className="mb-2 flex items-center gap-2 px-1 text-sm font-semibold text-foreground">
            <CalendarDays className="h-4 w-4 text-primary" />
            {t("starredView.calendarTitle")}
          </div>
          <Suspense fallback={<CalendarFallback />}>
            <LazyCalendar
              mode="single"
              selected={selectedDate}
              defaultMonth={selectedDate}
              onSelect={(date) => {
                if (date) setSelectedDate(date);
              }}
              disabled={(date) => date > new Date()}
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
            <p className="mt-3 text-2xl font-semibold text-foreground">{sessionsForDay.length}</p>
          </section>
          <section className="rounded-md border bg-background p-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Star className="h-4 w-4 text-primary" />
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

      <div className="mt-4 flex min-h-0 flex-1 flex-col">
        <section className="flex min-h-0 flex-col rounded-md border bg-background">
          <div className="flex items-center justify-between border-b px-3 py-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t("starredView.starredTitle")}</h3>
            <span className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-muted px-1.5 text-[10px] font-semibold text-muted-foreground">
              {starredForDay.length}
            </span>
          </div>
          <ScrollArea className="flex-1">
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
