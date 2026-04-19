/**
 * PrivacyTab — DLP Hit Statistics panel
 *
 * Shows cumulative redaction stats: total hits, by-kind bar chart,
 * daily trend sparkline, and top 5 patterns.
 */
import React, { useCallback, useEffect, useState } from "react";
import { Separator } from "../../../components/ui/separator.js";

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
  const days = Object.keys(byDay).sort();
  if (days.length < 2) {
    return <p className="text-[11px] text-muted-foreground italic">데이터 부족 (2일 이상 필요)</p>;
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
  const [stats, setStats] = useState<DlpStats | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [days, setDays] = useState(7);

  const fetchStats = useCallback(async (d: number) => {
    try {
      const s = await getLvisApi().dlp.getStats(d);
      setStats(s);
      setStatsError(null);
    } catch (e) {
      setStatsError((e as Error).message ?? "통계 로드 실패");
    }
  }, []);

  useEffect(() => {
    if (piiRedactEnabled) {
      void fetchStats(days);
    }
  }, [piiRedactEnabled, days, fetchStats]);

  const maxKind = stats ? Math.max(...Object.values(stats.byKind), 1) : 1;

  return (
    <div className="space-y-4 pt-4">
      {/* ── Toggle ── */}
      <div className="space-y-2">
        <div>
          <p className="text-sm font-medium">PII 리댁트</p>
          <p className="text-[11px] text-muted-foreground">
            활성화 시 LLM으로 전송 전에 이메일·전화·신용카드 등 개인정보를 [REDACTED:*]로 치환합니다. 기본값은 꺼짐.
          </p>
        </div>
        <div className="flex items-center gap-3 rounded-md border px-3 py-3">
          <button
            type="button"
            role="checkbox"
            aria-checked={piiRedactEnabled}
            aria-labelledby="pii-redact-toggle-label"
            className={`relative h-5 w-5 flex-shrink-0 rounded border-2 transition-colors ${
              piiRedactEnabled
                ? "border-primary bg-primary"
                : "border-muted-foreground"
            } cursor-pointer hover:border-primary/60`}
            onClick={onToggle}
          >
            {piiRedactEnabled && (
              <span className="absolute inset-0 flex items-center justify-center text-[10px] font-bold text-primary-foreground">
                ✓
              </span>
            )}
          </button>
          <div className="space-y-0.5">
            <p id="pii-redact-toggle-label" className="text-sm font-medium">
              PII 리댁트 활성화 (기본 OFF)
            </p>
            <p className="text-[11px] text-muted-foreground">
              전송 직전 이메일/전화번호/주민번호/카드번호를 `[REDACTED:*]`로 치환하고, 리댁트 발생 시 응답 영역에 🔒 알림을 잠시 표시합니다. 감사 로그에도 건수가 기록됩니다.
            </p>
          </div>
        </div>
      </div>

      {/* ── Stats (only shown when enabled) ── */}
      {piiRedactEnabled && (
        <>
          <Separator />
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">DLP 탐지 통계</p>
              <select
                className="h-7 rounded-md border bg-background px-2 text-xs"
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
              >
                <option value={7}>최근 7일</option>
                <option value={14}>최근 14일</option>
                <option value={30}>최근 30일</option>
              </select>
            </div>

            {statsError && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {statsError}
              </div>
            )}

            {stats && (
              <div className="space-y-4">
                {/* Total */}
                <div className="rounded-md border px-4 py-3 text-center">
                  <p className="text-[11px] text-muted-foreground">총 리댁션 ({days}일)</p>
                  <p className="text-2xl font-semibold tabular-nums">{stats.totalHits.toLocaleString()}</p>
                </div>

                {/* By Kind bar chart */}
                {Object.keys(stats.byKind).length > 0 ? (
                  <div className="space-y-1.5">
                    <p className="text-[11px] text-muted-foreground font-medium">유형별 분포</p>
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
                ) : (
                  <p className="text-[11px] text-muted-foreground italic">탐지 기록 없음</p>
                )}

                {/* Daily trend sparkline */}
                <div className="space-y-1.5">
                  <p className="text-[11px] text-muted-foreground font-medium">일별 트렌드</p>
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
                  <div className="space-y-1.5">
                    <p className="text-[11px] text-muted-foreground font-medium">상위 패턴 (Top 5)</p>
                    <div className="rounded-md border text-xs">
                      <table className="w-full">
                        <thead>
                          <tr className="border-b bg-muted/40">
                            <th className="px-3 py-1.5 text-left font-medium">패턴</th>
                            <th className="px-3 py-1.5 text-right font-medium">건수</th>
                          </tr>
                        </thead>
                        <tbody>
                          {stats.topPatterns.map(({ kind, count }, i) => (
                            <tr key={kind} className="border-b last:border-0">
                              <td className="px-3 py-1.5 font-mono">
                                <span className="mr-2 text-muted-foreground">{i + 1}.</span>
                                {kind}
                              </td>
                              <td className="px-3 py-1.5 text-right tabular-nums">{count}</td>
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
              <p className="text-[11px] text-muted-foreground italic">통계 로딩 중...</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
