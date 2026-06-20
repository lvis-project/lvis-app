import { useCallback, useEffect, useState } from "react";
import { Button } from "../../../components/ui/button.js";
import type { LvisApi, PluginPerfStats } from "../types.js";
import { SettingsPageHeader } from "../components/SettingsPageHeader.js";
import { SettingsSection } from "../components/SettingsSection.js";
import { useTranslation } from "../../../i18n/react.js";

type Row = {
  pluginId: string;
  stats: PluginPerfStats;
};

function errorRate(stats: PluginPerfStats): number {
  if (stats.toolCallCount === 0) return 0;
  return (stats.errorCount / stats.toolCallCount) * 100;
}

function avgExecMs(stats: PluginPerfStats): number {
  if (stats.toolCallCount === 0) return 0;
  return stats.totalExecMs / stats.toolCallCount;
}

function errorRateBadgeClass(rate: number): string {
  if (rate > 5) return "text-destructive font-semibold";
  if (rate >= 1) return "text-warning font-semibold";
  return "text-success";
}

/** Simple SVG bar chart — avg exec ms per plugin (max width 80px). */
function BarChart({ rows }: { rows: Row[] }) {
  const maxAvg = Math.max(...rows.map((r) => avgExecMs(r.stats)), 1);
  return (
    <svg width="100%" height={rows.length * 20 + 8} aria-label="avg exec ms per plugin">
      {rows.map((r, i) => {
        const avg = avgExecMs(r.stats);
        const barWidth = (avg / maxAvg) * 80;
        return (
          <g key={r.pluginId} transform={`translate(0,${i * 20})`}>
            <rect x={0} y={4} width={Math.max(barWidth, 1)} height={12} fill="hsl(var(--chart-1))" rx={2} />
            <text x={barWidth + 4} y={14} fontSize={10} fill="currentColor">
              {avg.toFixed(1)}ms
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export function PluginPerfTab({ api }: { api: LvisApi }) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const stats = await api.plugins.getPerfStats();
      const next: Row[] = Object.entries(stats).map(([pluginId, s]) => ({ pluginId, stats: s }));
      setRows(next);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="space-y-6">
      <SettingsPageHeader
        title={t("pluginPerfTab.pageTitle")}
        description={t("pluginPerfTab.pageDescription")}
      />

      <SettingsSection
        title={t("pluginPerfTab.sectionTitle")}
        description={t("pluginPerfTab.sectionDescription")}
        actions={
          <Button size="sm" variant="outline" onClick={() => void refresh()} disabled={loading}>
            {loading ? t("pluginPerfTab.refreshing") : t("pluginPerfTab.refresh")}
          </Button>
        }
      >
        {error && (
          <p className="rounded-md border border-destructive px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        )}

        {rows.length === 0 && !loading && !error && (
          <p className="text-xs text-muted-foreground">{t("pluginPerfTab.emptyState")}</p>
        )}

        {rows.length > 0 && (
          <>
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-xs">
                <thead className="border-b bg-muted/(--opacity-medium)">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">{t("pluginPerfTab.colPlugin")}</th>
                    <th className="px-3 py-2 text-right font-medium">{t("pluginPerfTab.colStartupMs")}</th>
                    <th className="px-3 py-2 text-right font-medium">{t("pluginPerfTab.colCallCount")}</th>
                    <th className="px-3 py-2 text-right font-medium">{t("pluginPerfTab.colErrorCount")}</th>
                    <th className="px-3 py-2 text-right font-medium">{t("pluginPerfTab.colErrorRate")}</th>
                    <th className="px-3 py-2 text-right font-medium">{t("pluginPerfTab.colAvgMs")}</th>
                    <th className="px-3 py-2 text-left font-medium">{t("pluginPerfTab.colLastCall")}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const rate = errorRate(r.stats);
                    const avg = avgExecMs(r.stats);
                    return (
                      <tr key={r.pluginId} className="border-b last:border-b-0 hover:bg-muted/(--opacity-light)">
                        <td className="px-3 py-2 font-mono">{r.pluginId}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.stats.startupMs}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.stats.toolCallCount}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.stats.errorCount}</td>
                        <td className={`px-3 py-2 text-right tabular-nums ${errorRateBadgeClass(rate)}`}>
                          {rate.toFixed(1)}%
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{avg.toFixed(1)}</td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {r.stats.lastCallAt
                            ? new Date(r.stats.lastCallAt).toLocaleTimeString()
                            : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="space-y-1">
              <p className="text-xs font-medium">{t("pluginPerfTab.chartLabel")}</p>
              <BarChart rows={rows} />
            </div>
          </>
        )}
      </SettingsSection>
    </div>
  );
}
