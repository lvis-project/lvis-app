import React, { useCallback, useEffect, useState } from "react";
import { Badge } from "../../../components/ui/badge.js";
import { Button } from "../../../components/ui/button.js";
import { Input } from "../../../components/ui/input.js";
import { Label } from "../../../components/ui/label.js";
import { NativeSelect, NativeSelectOption } from "../../../components/ui/native-select.js";
import { Separator } from "../../../components/ui/separator.js";
import type { AuditEntry } from "../../../audit/audit-logger.js";
import { SettingsPageHeader } from "../components/SettingsPageHeader.js";
import { SettingsSection } from "../components/SettingsSection.js";

interface AuditStats {
  totalByType: Record<string, number>;
  totalByDay: Record<string, number>;
  sensitiveOps: number;
}

interface AuditSearchResult {
  entries: AuditEntry[];
  total: number;
}

function isoDateOffset(days: number): string {
  return new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
}

const PAGE_SIZE = 50;

const TYPE_BADGE: Record<string, string> = {
  turn: "bg-info/15 text-info",
  tool_call: "bg-success/15 text-success",
  approval: "bg-warning/15 text-warning",
  warn: "bg-warning/15 text-warning",
  error: "bg-destructive/15 text-destructive",
  mcp_connect: "bg-emphasis/15 text-emphasis",
  kill_switch: "bg-destructive/15 text-destructive",
};

export function AuditTab() {
  const [dateFrom, setDateFrom] = useState(isoDateOffset(7));
  const [dateTo, setDateTo] = useState(new Date().toISOString().slice(0, 10));
  const [typeFilter, setTypeFilter] = useState("");
  const [textSearch, setTextSearch] = useState("");
  const [page, setPage] = useState(0);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AuditSearchResult>({ entries: [], total: 0 });
  const [stats, setStats] = useState<AuditStats | null>(null);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  const fetchStats = useCallback(async () => {
    try {
      const s = await (window as unknown as { lvisApi: { audit: { getStats: (d: number) => Promise<AuditStats> } } }).lvisApi.audit.getStats(7);
      setStats(s);
    } catch {
      // stats are best-effort
    }
  }, []);

  const runSearch = useCallback(async (currentPage: number) => {
    setLoading(true);
    setError(null);
    try {
      const res = await (window as unknown as { lvisApi: { audit: { search: (f: unknown) => Promise<AuditSearchResult> } } }).lvisApi.audit.search({
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
        type: typeFilter || undefined,
        textSearch: textSearch || undefined,
        limit: PAGE_SIZE,
        offset: currentPage * PAGE_SIZE,
      });
      setResult(res);
    } catch (e) {
      setError((e as Error).message ?? "검색 실패");
    } finally {
      setLoading(false);
    }
  }, [dateFrom, dateTo, typeFilter, textSearch]);

  useEffect(() => {
    void fetchStats();
    void runSearch(0);
    setPage(0);
    setExpandedIdx(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSearch = () => {
    setPage(0);
    setExpandedIdx(null);
    void runSearch(0);
    void fetchStats();
  };

  const handlePage = (next: number) => {
    setPage(next);
    setExpandedIdx(null);
    void runSearch(next);
  };

  const totalPages = Math.ceil(result.total / PAGE_SIZE);

  // Top-3 types from stats
  const top3 = stats
    ? Object.entries(stats.totalByType)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
    : [];
  const maxCount = top3[0]?.[1] ?? 1;

  return (
    // No inner scroll wrapper — SettingsContent's right pane owns the
    // single dialog scroll (always-visible gutter for G2). Wrapping the
    // tab in its own ScrollArea here would create a double scrollbar.
    <div className="pr-1">
      <div className="space-y-5">
        <SettingsPageHeader
          title="감사"
          description="감사 로그를 조회하고 export 합니다"
        />

        {/* ── Stats Bar ── */}
        {stats && (
          <SettingsSection title="최근 7일 통계">
            <div className="flex flex-wrap gap-3">
              <div className="rounded-md border px-3 py-2 text-center">
                <p className="text-xs text-muted-foreground">총 항목</p>
                <p className="text-lg font-semibold tabular-nums">
                  {Object.values(stats.totalByType).reduce((a, b) => a + b, 0).toLocaleString()}
                </p>
              </div>
              <div className="rounded-md border px-3 py-2 text-center">
                <p className="text-xs text-muted-foreground">민감 작업</p>
                <p className={`text-lg font-semibold tabular-nums ${stats.sensitiveOps > 0 ? "text-destructive" : ""}`}>
                  {stats.sensitiveOps}
                </p>
              </div>
            </div>
            {top3.length > 0 && (
              <div className="space-y-1">
                <p className="text-[11px] text-muted-foreground">상위 유형</p>
                {top3.map(([t, count]) => (
                  <div key={t} className="flex items-center gap-2">
                    <span className="w-20 truncate text-[11px] font-mono">{t}</span>
                    <div className="flex-1 rounded-full bg-muted h-2 overflow-hidden">
                      <div
                        className="h-2 rounded-full bg-primary"
                        style={{ width: `${Math.round((count / maxCount) * 100)}%` }}
                      />
                    </div>
                    <span className="w-8 text-right text-[11px] tabular-nums">{count}</span>
                  </div>
                ))}
              </div>
            )}
          </SettingsSection>
        )}

        {/* ── Filters ── */}
        <SettingsSection title="검색 필터">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">시작 날짜</Label>
              <Input
                type="date"
                className="h-8 text-xs"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">종료 날짜</Label>
              <Input
                type="date"
                className="h-8 text-xs"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
              />
            </div>
          </div>
          <div className="flex gap-2">
            <NativeSelect
              size="sm"
              className="w-32 flex-shrink-0"
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
            >
              <NativeSelectOption value="">모든 유형</NativeSelectOption>
              <NativeSelectOption value="turn">turn</NativeSelectOption>
              <NativeSelectOption value="tool_call">tool_call</NativeSelectOption>
              <NativeSelectOption value="approval">approval</NativeSelectOption>
              <NativeSelectOption value="warn">warn</NativeSelectOption>
              <NativeSelectOption value="error">error</NativeSelectOption>
              <NativeSelectOption value="mcp_connect">mcp_connect</NativeSelectOption>
              <NativeSelectOption value="kill_switch">kill_switch</NativeSelectOption>
            </NativeSelect>
            <Input
              className="h-8 flex-1 text-xs"
              placeholder="텍스트 검색..."
              value={textSearch}
              onChange={(e) => setTextSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleSearch(); }}
            />
            <Button size="sm" className="h-8" onClick={handleSearch} disabled={loading}>
              {loading ? "..." : "검색"}
            </Button>
          </div>
        </SettingsSection>

        {/* ── Results ── */}
        <SettingsSection
          title={`결과 ${result.total > 0 ? `(${result.total.toLocaleString()}건)` : ""}`}
          actions={
            totalPages > 1 ? (
              <div className="flex items-center gap-1 text-[11px]">
                <button
                  className="rounded px-1 hover:bg-muted disabled:opacity-40"
                  disabled={page === 0}
                  onClick={() => handlePage(page - 1)}
                >
                  ‹
                </button>
                <span>{page + 1} / {totalPages}</span>
                <button
                  className="rounded px-1 hover:bg-muted disabled:opacity-40"
                  disabled={page >= totalPages - 1}
                  onClick={() => handlePage(page + 1)}
                >
                  ›
                </button>
              </div>
            ) : undefined
          }
        >
          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}

          {!loading && result.entries.length === 0 && !error && (
            <p className="py-4 text-center text-xs text-muted-foreground italic">항목이 없습니다.</p>
          )}

          {result.entries.length > 0 && (
            <div className="rounded-md border text-xs">
              <table className="w-full">
                <thead>
                  <tr className="border-b bg-muted/40">
                    <th className="px-3 py-2 text-left font-medium">시각</th>
                    <th className="px-3 py-2 text-left font-medium">유형</th>
                    <th className="px-3 py-2 text-left font-medium">소스 / 라우트</th>
                    <th className="px-3 py-2 text-left font-medium">메시지</th>
                  </tr>
                </thead>
                <tbody>
                  {result.entries.map((entry, i) => {
                    const isExpanded = expandedIdx === i;
                    const badgeClass = TYPE_BADGE[entry.type] ?? "bg-muted text-muted-foreground";
                    const preview = entry.input ?? entry.output ?? "";
                    return (
                      <React.Fragment key={i}>
                        <tr
                          className="cursor-pointer border-b last:border-0 hover:bg-muted/20"
                          onClick={() => setExpandedIdx(isExpanded ? null : i)}
                        >
                          <td className="px-3 py-1.5 font-mono text-[10px] text-muted-foreground whitespace-nowrap">
                            {entry.timestamp?.slice(0, 19).replace("T", " ")}
                          </td>
                          <td className="px-3 py-1.5">
                            <Badge className={`text-[10px] ${badgeClass}`}>{entry.type}</Badge>
                          </td>
                          <td className="px-3 py-1.5 text-muted-foreground font-mono">
                            {entry.route ?? entry.sessionId?.slice(0, 8) ?? "—"}
                          </td>
                          <td className="max-w-[200px] truncate px-3 py-1.5 text-muted-foreground">
                            {preview.slice(0, 80)}
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr className="border-b last:border-0 bg-muted/30">
                            <td colSpan={4} className="px-3 py-2">
                              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-background p-2 text-[10px]">
                                {JSON.stringify(entry, null, 2)}
                              </pre>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </SettingsSection>
      </div>
    </div>
  );
}
