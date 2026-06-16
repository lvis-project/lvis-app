/**
 * PrivacyTab — DLP Hit Statistics panel
 *
 * Shows cumulative redaction stats: total hits, by-kind bar chart,
 * daily trend sparkline, and top 5 patterns.
 */
import { useCallback, useEffect, useState } from "react";
import { Checkbox } from "../../../components/ui/checkbox.js";
import { NativeSelect, NativeSelectOption } from "../../../components/ui/native-select.js";
import { useTranslation } from "../../../i18n/react.js";

interface DlpStats {
  totalHits: number;
  byKind: Record<string, number>;
  byDay: Record<string, number>;
  topPatterns: Array<{ kind: string; count: number }>;
}

type LvisApi = {
  dlp: { getStats: (days: number) => Promise<DlpStats> };
};

function getLvisApi(): LvisApi {
  return (window as unknown as { lvisApi: LvisApi }).lvisApi;
}

/** Simple inline SVG bar — width proportional to value/max */
function Bar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="flex-1 rounded-full bg-muted h-2 overflow-hidden">
      <div className="h-2 rounded-full bg-primary" style={{ width: `${pct}%` }} />
    </div>
  );
}

/** Inline SVG sparkline for daily hit trend */
function Sparkline({ byDay }: { byDay: Record<string, number> }) {
  const { t } = useTranslation();
  const days = Object.keys(byDay).sort();
  if (days.length < 2) {
    return <p className="text-[11px] text-muted-foreground italic">{t("privacyTab.sparklineInsufficientData")}</p>;
  }
  const values = days.map((d) => byDay[d] ?? 0);
  const maxVal = Math.max(...values, 1);
  const W = 240;
  const H = 40;
  const step = W / (values.length - 1);
  const pts = values
    .map((v, i) => `${i * step},${H - (v / maxVal) * (H - 4)}`)
    .join(" ");
  return (
    <svg width={W} height={H} className="overflow-visible">
      <polyline
        points={pts}
        fill="none"
        stroke="hsl(var(--primary))"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {values.map((v, i) => (
        <circle
          key={i}
          cx={i * step}
          cy={H - (v / maxVal) * (H - 4)}
          r={2.5}
          fill="hsl(var(--primary))"
        />
      ))}
    </svg>
  );
}

interface PrivacyTabProps {
  piiRedactEnabled: boolean;
  onToggle: () => void;
}

export function PrivacyTab({ piiRedactEnabled, onToggle }: PrivacyTabProps) {
  const { t } = useTranslation();
  const [stats, setStats] = useState<DlpStats | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [days, setDays] = useState(7);

  const fetchStats = useCallback(async (d: number) => {
    try {
      const s = await getLvisApi().dlp.getStats(d);
      setStats(s);
      setStatsError(null);
    } catch (e) {
      setStatsError((e as Error).message ?? t("privacyTab.statsLoadFailed"));
    }
  }, [t]);

  useEffect(() => {
    if (piiRedactEnabled) {
      void fetchStats(days);
    }
  }, [piiRedactEnabled, days, fetchStats]);

  const maxKind = stats ? Math.max(...Object.values(stats.byKind), 1) : 1;

  return (
    <div className="space-y-4">
      {/* ── Toggle section ── */}
      <div className="rounded-lg border bg-background shadow-sm">
        {/* section header bar */}
        <div className="rounded-t-lg border-b bg-muted/40 px-3 py-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {t("privacyTab.piiRedactTitle")}
          </p>
        </div>
        <div className="p-3 space-y-3">
          <p className="text-[11px] text-muted-foreground">
            {t("privacyTab.piiRedactDescription")}
          </p>
          <div className="flex items-center gap-3 rounded-lg border bg-background px-3 py-3 shadow-sm focus-within:ring-2 focus-within:ring-ring">
            <Checkbox
              checked={piiRedactEnabled}
              aria-labelledby="pii-redact-toggle-label"
              className="size-5"
              onCheckedChange={onToggle}
            />
            <div className="space-y-0.5">
              <p id="pii-redact-toggle-label" className="text-sm font-semibold leading-snug text-foreground">
                {t("privacyTab.piiRedactToggleLabel")}
              </p>
              <p className="text-[11px] text-muted-foreground">
                {t("privacyTab.piiRedactToggleDescription")}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* ── Stats (only shown when enabled) ── */}
      {piiRedactEnabled && (
        <div className="border-t pt-4 space-y-4">
          {/* Stats section header bar with inline day picker */}
          <div className="rounded-lg border bg-background shadow-sm">
            <div className="rounded-t-lg border-b bg-muted/40 px-3 py-2 flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {t("privacyTab.dlpStatsTitle")}
              </p>
              <NativeSelect
                size="sm"
                className="w-28"
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
              >
                <NativeSelectOption value={7}>{t("privacyTab.last7Days")}</NativeSelectOption>
                <NativeSelectOption value={14}>{t("privacyTab.last14Days")}</NativeSelectOption>
                <NativeSelectOption value={30}>{t("privacyTab.last30Days")}</NativeSelectOption>
              </NativeSelect>
            </div>

            <div className="p-3 space-y-4">
              {statsError && (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {statsError}
                </div>
              )}

              {stats && (
                <div className="space-y-4">
                  {/* Total card */}
                  <div className="rounded-lg border bg-background shadow-sm px-4 py-3 text-center">
                    <p className="text-[11px] text-muted-foreground">{t("privacyTab.totalRedactions", { days })}</p>
                    <p className="text-2xl font-semibold tabular-nums text-foreground leading-snug">
                      {stats.totalHits.toLocaleString()}
                    </p>
                  </div>

                  {/* By Kind bar chart */}
                  {Object.keys(stats.byKind).length > 0 ? (
                    <div className="space-y-2 border-t pt-4">
                      <div className="flex items-center gap-2">
                        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                          {t("privacyTab.byKindTitle")}
                        </p>
                        <span className="inline-flex items-center rounded-full border bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground tabular-nums">
                          {Object.keys(stats.byKind).length}
                        </span>
                      </div>
                      <div className="space-y-1.5">
                        {Object.entries(stats.byKind)
                          .sort((a, b) => b[1] - a[1])
                          .map(([kind, count]) => (
                            <div key={kind} className="flex items-center gap-2">
                              <span className="w-24 truncate text-[11px] font-mono">{kind}</span>
                              <Bar value={count} max={maxKind} />
                              <span className="w-8 text-right text-[11px] tabular-nums">{count}</span>
                            </div>
                          ))}
                      </div>
                    </div>
                  ) : (
                    <p className="text-[11px] text-muted-foreground italic">{t("privacyTab.noDetectionRecords")}</p>
                  )}

                  {/* Daily trend sparkline */}
                  <div className="space-y-2 border-t pt-4">
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      {t("privacyTab.dailyTrendTitle")}
                    </p>
                    <div className="overflow-x-auto">
                      <Sparkline byDay={stats.byDay} />
                    </div>
                    {Object.keys(stats.byDay).length > 0 && (
                      <div className="flex justify-between text-[10px] text-muted-foreground" style={{ width: 240 }}>
                        <span>{Object.keys(stats.byDay).sort()[0]}</span>
                        <span>{Object.keys(stats.byDay).sort().at(-1)}</span>
                      </div>
                    )}
                  </div>

                  {/* Top 5 patterns */}
                  {stats.topPatterns.length > 0 && (
                    <div className="space-y-2 border-t pt-4">
                      <div className="flex items-center gap-2">
                        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                          {t("privacyTab.topPatternsTitle")}
                        </p>
                        <span className="inline-flex items-center rounded-full border bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground tabular-nums">
                          {stats.topPatterns.length}
                        </span>
                      </div>
                      <div className="rounded-lg border bg-background shadow-sm text-xs overflow-hidden">
                        <table className="w-full">
                          <thead>
                            <tr className="border-b bg-muted/40">
                              <th className="px-3 py-1.5 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                                {t("privacyTab.tableHeaderPattern")}
                              </th>
                              <th className="px-3 py-1.5 text-right text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                                {t("privacyTab.tableHeaderCount")}
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {stats.topPatterns.map(({ kind, count }, i) => (
                              <tr key={kind} className="border-b last:border-0 hover:bg-muted/40 transition-colors">
                                <td className="px-3 py-1.5 font-mono text-foreground">
                                  <span className="mr-2 text-muted-foreground">{i + 1}.</span>
                                  {kind}
                                </td>
                                <td className="px-3 py-1.5 text-right tabular-nums text-foreground">{count}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {!stats && !statsError && (
                <p className="text-[11px] text-muted-foreground italic">{t("privacyTab.statsLoading")}</p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
