import { useEffect, useState, useCallback } from "react";
import { Button } from "../../../components/ui/button.js";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/card.js";
import { Input } from "../../../components/ui/input.js";
import { formatCost, formatTokens } from "../utils/cost-format.js";
import type { LvisApi, UsageSummaryShape, UsageTrendPt } from "../types.js";
import { Sparkline } from "./Sparkline.js";
import { SettingsPageHeader } from "./SettingsPageHeader.js";

type Preset = "7d" | "30d" | "90d" | "all" | "custom";

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoKey(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function presetToDates(preset: Preset): { dateFrom: string; dateTo: string } {
  const to = todayKey();
  if (preset === "7d") return { dateFrom: daysAgoKey(6), dateTo: to };
  if (preset === "30d") return { dateFrom: daysAgoKey(29), dateTo: to };
  if (preset === "90d") return { dateFrom: daysAgoKey(89), dateTo: to };
  return { dateFrom: daysAgoKey(365 * 5), dateTo: to };
}

function sumUnknownCostTurns(rows: Array<{ unknownCostTurns?: number }>): number {
  return rows.reduce((sum, row) => sum + (row.unknownCostTurns ?? 0), 0);
}

function computeMonthlyProjection(trend: UsageTrendPt[]): { cost: number; hasUnknownCost: boolean } {
  if (trend.length === 0) return { cost: 0, hasUnknownCost: false };
  const total = trend.reduce((s, p) => s + p.cost, 0);
  return {
    cost: (total / trend.length) * 30,
    hasUnknownCost: sumUnknownCostTurns(trend) > 0,
  };
}

function formatCostWithUnknown(v: { cost: number; unknownCostTurns?: number }): string {
  const base = formatCost(v.cost);
  return v.unknownCostTurns ? `${base} + 미정 ${v.unknownCostTurns}턴` : base;
}

function formatProjectedCost(v: { cost: number; hasUnknownCost: boolean }): string {
  const base = formatCost(v.cost);
  return v.hasUnknownCost ? `${base} + 미정 포함` : base;
}

function formatCacheBreakdown(v: { cacheReadTokens?: number; cacheWriteTokens?: number }): string {
  return `cache r ${formatTokens(v.cacheReadTokens ?? 0)} / w ${formatTokens(v.cacheWriteTokens ?? 0)}`;
}

function buildCsvRows(summary: UsageSummaryShape): Array<Record<string, string | number>> {
  const rows: Array<Record<string, string | number>> = [];
  for (const pt of summary.trend) {
    rows.push({
      date: pt.date,
      vendor: "all",
      model: "all",
      inputTokens: pt.inputTokens,
      outputTokens: pt.outputTokens,
      cacheReadTokens: pt.cacheReadTokens ?? 0,
      cacheWriteTokens: pt.cacheWriteTokens ?? 0,
      totalTokens: pt.totalTokens,
      cost: pt.cost,
      unknownCostTurns: pt.unknownCostTurns ?? 0,
    });
  }
  for (const m of summary.perModel) {
    rows.push({
      date: "range-total",
      vendor: m.vendor,
      model: m.model,
      inputTokens: m.inputTokens,
      outputTokens: m.outputTokens,
      cacheReadTokens: m.cacheReadTokens ?? 0,
      cacheWriteTokens: m.cacheWriteTokens ?? 0,
      totalTokens: m.totalTokens,
      cost: m.cost,
      unknownCostTurns: m.unknownCostTurns ?? 0,
    });
  }
  return rows;
}

export function UsageDashboard({ api }: { api: LvisApi }) {
  const [summary, setSummary] = useState<UsageSummaryShape | null>(null);
  const [loading, setLoading] = useState(true);
  const [preset, setPreset] = useState<Preset>("30d");
  const [customFrom, setCustomFrom] = useState<string>(daysAgoKey(29));
  const [customTo, setCustomTo] = useState<string>(todayKey());
  const [exporting, setExporting] = useState(false);

  const load = useCallback(() => {
    let active = true;
    setLoading(true);
    const range = preset === "custom"
      ? { dateFrom: customFrom, dateTo: customTo }
      : presetToDates(preset);
    api.getUsageRange(range)
      .then((s) => { if (active) { setSummary(s); setLoading(false); } })
      .catch(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, preset, customFrom, customTo]);

  useEffect(() => {
    const cleanup = load();
    return cleanup;
  }, [load]);

  const handleExportCsv = useCallback(async () => {
    if (!summary) return;
    setExporting(true);
    try {
      await api.exportUsageCsv(buildCsvRows(summary));
    } finally {
      setExporting(false);
    }
  }, [api, summary]);

  const header = (
    <SettingsPageHeader
      title="사용량"
      description="기간별 토큰 사용량, 비용, 모델별 누적량을 확인합니다"
    />
  );

  if (loading) {
    return (
      <div className="space-y-5">
        {header}
        <div className="py-6 text-center text-sm text-muted-foreground">로딩 중...</div>
      </div>
    );
  }
  if (!summary) {
    return (
      <div className="space-y-5">
        {header}
        <div className="py-6 text-center text-sm text-muted-foreground">사용량 데이터를 불러올 수 없습니다.</div>
      </div>
    );
  }

  const sparkPoints = summary.trend.map((p) => p.totalTokens);
  const projection = computeMonthlyProjection(summary.trend);
  const averageDailyKnownCost = summary.trend.length
    ? summary.trend.reduce((s, p) => s + p.cost, 0) / summary.trend.length
    : 0;
  const averageDailyCost = {
    cost: averageDailyKnownCost,
    hasUnknownCost: sumUnknownCostTurns(summary.trend) > 0,
  };

  return (
    <div className="space-y-5" data-testid="usage-dashboard">
      {header}
      <Card>
        <CardHeader className="pb-1 pt-3 px-3 flex-row items-center justify-between">
          <CardTitle className="text-xs text-muted-foreground">기간 선택</CardTitle>
          <div className="flex gap-1 flex-wrap">
            {(["7d", "30d", "90d", "all", "custom"] as Preset[]).map((p) => (
              <Button key={p} size="sm" variant={preset === p ? "default" : "outline"} onClick={() => setPreset(p)} className="h-6 px-2 text-[11px]">
                {p === "all" ? "전체" : p === "custom" ? "직접" : p}
              </Button>
            ))}
          </div>
        </CardHeader>
        {preset === "custom" && (
          <CardContent className="px-3 pb-3 flex gap-2 items-center">
            <Input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} className="h-7 w-auto px-2 py-1 text-xs" aria-label="시작일" />
            <span className="text-xs text-muted-foreground">~</span>
            <Input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} className="h-7 w-auto px-2 py-1 text-xs" aria-label="종료일" />
            <Button size="sm" onClick={load} className="h-6 px-2 text-[11px]">조회</Button>
          </CardContent>
        )}
      </Card>

      <div className="grid grid-cols-3 gap-2">
        {([
          { label: "오늘", v: summary.today },
          { label: "이번 주", v: summary.thisWeek },
          { label: "이번 달", v: summary.thisMonth },
        ] as const).map(({ label, v }) => (
          <Card key={label}>
            <CardHeader className="pb-1 pt-3 px-3"><CardTitle className="text-xs text-muted-foreground">{label}</CardTitle></CardHeader>
            <CardContent className="space-y-0.5 px-3 pb-3">
              <div className="text-lg font-semibold">{formatTokens(v.totalTokens)}</div>
              <div className="text-xs text-muted-foreground">in {formatTokens(v.inputTokens)} / out {formatTokens(v.outputTokens)}</div>
              <div className="text-xs text-muted-foreground">{formatCacheBreakdown(v)}</div>
              <div className="text-xs font-medium">{formatCostWithUnknown(v)}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader className="pb-1 pt-3 px-3"><CardTitle className="text-xs text-muted-foreground">토큰 추이</CardTitle></CardHeader>
        <CardContent className="px-3 pb-3"><Sparkline points={sparkPoints} /></CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-1 pt-3 px-3"><CardTitle className="text-xs text-muted-foreground">월간 예상 비용</CardTitle></CardHeader>
        <CardContent className="px-3 pb-3">
          <div className="text-sm">이 속도로면 월 약 <span className="font-semibold">{formatProjectedCost(projection)}</span></div>
          <div className="text-xs text-muted-foreground mt-0.5">
            일평균 {formatProjectedCost(averageDailyCost)} × 30일
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-1 pt-3 px-3"><CardTitle className="text-xs text-muted-foreground">벤더별 사용량</CardTitle></CardHeader>
        <CardContent className="px-3 pb-3">
          {summary.perVendor.length === 0 ? <div className="text-xs text-muted-foreground">데이터 없음</div> : (
            <table className="w-full text-xs">
              <thead><tr className="text-left text-muted-foreground"><th className="py-1">벤더</th><th>토큰</th><th>캐시</th><th>비용</th></tr></thead>
              <tbody>
                {summary.perVendor.map((v) => (
                  <tr key={v.vendor} className="border-t">
                    <td className="py-1 font-mono">{v.vendor}</td>
                    <td>{formatTokens(v.totalTokens)}</td>
                    <td className="text-muted-foreground">{formatCacheBreakdown(v)}</td>
                    <td>{formatCostWithUnknown(v)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-1 pt-3 px-3"><CardTitle className="text-xs text-muted-foreground">모델별 사용량</CardTitle></CardHeader>
        <CardContent className="px-3 pb-3">
          {summary.perModel.length === 0 ? <div className="text-xs text-muted-foreground">데이터 없음</div> : (
            <table className="w-full text-xs">
              <thead><tr className="text-left text-muted-foreground"><th className="py-1">모델</th><th>토큰</th><th>캐시</th><th>비용</th></tr></thead>
              <tbody>
                {summary.perModel.map((m) => (
                  <tr key={`${m.vendor}:${m.model}`} className="border-t">
                    <td className="py-1 font-mono break-all">
                      <span className="text-muted-foreground">{m.vendor}/</span>{m.model}
                    </td>
                    <td>{formatTokens(m.totalTokens)}</td>
                    <td className="text-muted-foreground">{formatCacheBreakdown(m)}</td>
                    <td>{formatCostWithUnknown(m)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-1 pt-3 px-3"><CardTitle className="text-xs text-muted-foreground">세션별 비용 Top 5</CardTitle></CardHeader>
        <CardContent className="px-3 pb-3">
          {summary.topConversations.length === 0 ? <div className="text-xs text-muted-foreground">데이터 없음</div> : (
            <table className="w-full text-xs">
              <thead><tr className="text-left text-muted-foreground"><th className="py-1">세션</th><th>턴</th><th>토큰</th><th>캐시</th><th>비용</th></tr></thead>
              <tbody>
                {summary.topConversations.map((c) => (
                  <tr key={c.sessionId} className="border-t">
                    <td className="py-1 max-w-[120px] truncate font-mono" title={c.firstInput ?? c.sessionId}>{c.sessionId.slice(0, 12)}</td>
                    <td>{c.turns}</td>
                    <td>{formatTokens(c.totalTokens)}</td>
                    <td className="text-muted-foreground">{formatCacheBreakdown(c)}</td>
                    <td>{formatCostWithUnknown(c)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button size="sm" variant="outline" onClick={handleExportCsv} disabled={exporting || summary.trend.length === 0} className="h-7 px-3 text-[11px]">
          {exporting ? "내보내는 중..." : "CSV 내보내기"}
        </Button>
      </div>
    </div>
  );
}
