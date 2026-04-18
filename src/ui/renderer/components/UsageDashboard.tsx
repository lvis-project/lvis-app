import { useEffect, useState } from "react";
import { Button } from "../../../components/ui/button.js";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/card.js";
import { formatCost, formatTokens } from "../utils/cost-format.js";
import type { LvisApi, UsageSummaryShape } from "../types.js";
import { Sparkline } from "./Sparkline.js";

export function UsageDashboard({ api }: { api: LvisApi }) {
  const [summary, setSummary] = useState<UsageSummaryShape | null>(null);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState<7 | 30>(7);

  useEffect(() => {
    let active = true;
    setLoading(true);
    api.getUsageSummary(60).then((s) => { if (active) { setSummary(s); setLoading(false); } }).catch(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api]);

  if (loading) return <div className="py-6 text-center text-sm text-muted-foreground">로딩 중...</div>;
  if (!summary) return <div className="py-6 text-center text-sm text-muted-foreground">사용량 데이터를 불러올 수 없습니다.</div>;

  const trendSlice = summary.trend.slice(-range);
  const sparkPoints = trendSlice.map((p) => p.totalTokens);

  return (
    <div className="space-y-4 pt-4">
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
              <div className="text-xs font-medium">{formatCost(v.cost)}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader className="pb-1 pt-3 px-3 flex-row items-center justify-between">
          <CardTitle className="text-xs text-muted-foreground">토큰 추이</CardTitle>
          <div className="flex gap-1">
            <Button size="sm" variant={range === 7 ? "default" : "outline"} onClick={() => setRange(7)} className="h-6 px-2 text-[11px]">7d</Button>
            <Button size="sm" variant={range === 30 ? "default" : "outline"} onClick={() => setRange(30)} className="h-6 px-2 text-[11px]">30d</Button>
          </div>
        </CardHeader>
        <CardContent className="px-3 pb-3"><Sparkline points={sparkPoints} /></CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-1 pt-3 px-3"><CardTitle className="text-xs text-muted-foreground">벤더별 사용량</CardTitle></CardHeader>
        <CardContent className="px-3 pb-3">
          {summary.perVendor.length === 0 ? <div className="text-xs text-muted-foreground">데이터 없음</div> : (
            <table className="w-full text-xs">
              <thead><tr className="text-left text-muted-foreground"><th className="py-1">벤더</th><th>토큰</th><th>비용</th></tr></thead>
              <tbody>
                {summary.perVendor.map((v) => (
                  <tr key={v.vendor} className="border-t"><td className="py-1 font-mono">{v.vendor}</td><td>{formatTokens(v.totalTokens)}</td><td>{formatCost(v.cost)}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-1 pt-3 px-3"><CardTitle className="text-xs text-muted-foreground">비용 상위 대화 5</CardTitle></CardHeader>
        <CardContent className="px-3 pb-3">
          {summary.topConversations.length === 0 ? <div className="text-xs text-muted-foreground">데이터 없음</div> : (
            <table className="w-full text-xs">
              <thead><tr className="text-left text-muted-foreground"><th className="py-1">세션</th><th>턴</th><th>토큰</th><th>비용</th></tr></thead>
              <tbody>
                {summary.topConversations.map((c) => (
                  <tr key={c.sessionId} className="border-t">
                    <td className="py-1 max-w-[120px] truncate font-mono" title={c.firstInput ?? c.sessionId}>{c.sessionId.slice(0, 12)}</td>
                    <td>{c.turns}</td><td>{formatTokens(c.totalTokens)}</td><td>{formatCost(c.cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
