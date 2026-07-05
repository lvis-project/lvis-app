import React, { useCallback, useEffect, useState } from "react";
import { Badge } from "../../../components/ui/badge.js";
import { Button } from "../../../components/ui/button.js";
import { Input } from "../../../components/ui/input.js";
import { Label } from "../../../components/ui/label.js";
import { NativeSelect, NativeSelectOption } from "../../../components/ui/native-select.js";
import type { AuditEntry } from "../../../audit/audit-logger.js";
import { SettingsPageHeader } from "../components/SettingsPageHeader.js";
import { SettingsSection } from "../components/SettingsSection.js";
import { useTranslation } from "../../../i18n/react.js";
import { DiagnosticsSection } from "./DiagnosticsSection.js";

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
  // Telemetry AuditEntry types (src/audit/audit-logger.ts:85)
  turn: "bg-info/(--opacity-soft) text-info",
  tool_call: "bg-success/(--opacity-soft) text-success",
  approval: "bg-warning/(--opacity-soft) text-warning",
  warn: "bg-warning/(--opacity-soft) text-warning",
  error: "bg-destructive/(--opacity-soft) text-destructive",
  mcp_connect: "bg-emphasis/(--opacity-soft) text-emphasis",
  kill_switch: "bg-destructive/(--opacity-soft) text-destructive",
  // Permission HMAC-chain AuditCommon decisions (src/audit/audit-schema.ts:85+).
  // Rows in the permission-audit jsonl have no `type` field; the row
  // normalize step falls back to `decision`. Without these keys every
  // permission row used to render the neutral muted badge — code-reviewer
  // round-3 MAJOR finding. Color-coded so allow/ask/deny are visually
  // distinct at a glance.
  allow: "bg-success/(--opacity-soft) text-success",
  ask: "bg-warning/(--opacity-soft) text-warning",
  deny: "bg-destructive/(--opacity-soft) text-destructive",
  deferred: "bg-info/(--opacity-soft) text-info",
  deferred_resolve: "bg-info/(--opacity-soft) text-info",
  mode_change: "bg-emphasis/(--opacity-soft) text-emphasis",
  manifest_violation: "bg-destructive/(--opacity-soft) text-destructive",
};

export function AuditTab() {
  const { t } = useTranslation();
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
      setError((e as Error).message ?? t("auditTab.searchFailed"));
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
      <div className="space-y-6">
        <SettingsPageHeader
          title={t("auditTab.pageTitle")}
          description={t("auditTab.pageDescription")}
        />

        {/* ── Stats Bar ── */}
        {stats && (
          <SettingsSection title={t("auditTab.statsTitle")}>
            <div className="flex flex-wrap gap-3">
              <div className="rounded-md border px-3 py-2 text-center">
                <p className="text-xs text-muted-foreground">{t("auditTab.statsTotalItems")}</p>
                <p className="text-lg font-semibold tabular-nums">
                  {Object.values(stats.totalByType).reduce((a, b) => a + b, 0).toLocaleString()}
                </p>
              </div>
              <div className="rounded-md border px-3 py-2 text-center">
                <p className="text-xs text-muted-foreground">{t("auditTab.statsSensitiveOps")}</p>
                <p className={`text-lg font-semibold tabular-nums ${stats.sensitiveOps > 0 ? "text-destructive" : ""}`}>
                  {stats.sensitiveOps}
                </p>
              </div>
            </div>
            {top3.length > 0 && (
              <div className="space-y-1">
                <p className="text-[11px] text-muted-foreground">{t("auditTab.statsTopTypes")}</p>
                {top3.map(([typeName, count]) => (
                  <div key={typeName} className="flex items-center gap-2">
                    <span className="w-20 truncate text-[11px] font-mono">{typeName}</span>
                    <div className="flex-1 rounded-full bg-muted h-2 overflow-hidden">
                      {/* Runtime fill ratio flows through the --progress CSS
                          variable so the bar geometry stays in classes. */}
                      <div
                        className="h-2 w-[var(--progress)] rounded-full bg-primary"
                        style={{ "--progress": `${Math.round((count / maxCount) * 100)}%` } as React.CSSProperties}
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
        <SettingsSection title={t("auditTab.filterTitle")}>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">{t("auditTab.filterDateFrom")}</Label>
              <Input
                type="date"
                className="h-8 text-xs"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">{t("auditTab.filterDateTo")}</Label>
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
              <NativeSelectOption value="">{t("auditTab.filterAllTypes")}</NativeSelectOption>
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
              placeholder={t("auditTab.filterTextPlaceholder")}
              value={textSearch}
              onChange={(e) => setTextSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleSearch(); }}
            />
            <Button size="sm" className="h-8" onClick={handleSearch} disabled={loading}>
              {loading ? "..." : t("auditTab.searchButton")}
            </Button>
          </div>
        </SettingsSection>

        {/* ── Results ── */}
        <SettingsSection
          title={result.total > 0 ? t("auditTab.resultsWithCount", { count: result.total.toLocaleString() }) : t("auditTab.resultsTitle")}
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
            <div className="rounded-md border border-destructive/(--opacity-medium) bg-destructive/(--opacity-subtle) px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}

          {!loading && result.entries.length === 0 && !error && (
            <p className="py-4 text-center text-xs text-muted-foreground italic">{t("auditTab.emptyState")}</p>
          )}

          {result.entries.length > 0 && (
            <div className="rounded-md border text-xs">
              <table className="w-full">
                <thead>
                  <tr className="border-b bg-muted/(--opacity-medium)">
                    <th className="px-3 py-2 text-left font-medium">{t("auditTab.colTimestamp")}</th>
                    <th className="px-3 py-2 text-left font-medium">{t("auditTab.colType")}</th>
                    <th className="px-3 py-2 text-left font-medium">{t("auditTab.colSourceRoute")}</th>
                    <th className="px-3 py-2 text-left font-medium">{t("auditTab.colMessage")}</th>
                  </tr>
                </thead>
                <tbody>
                  {result.entries.map((entry, i) => {
                    const isExpanded = expandedIdx === i;
                    // Audit results mix two record shapes in a single stream:
                    // (1) telemetry AuditEntry (timestamp/type/route/input/output)
                    // (2) permission HMAC-chain AuditCommon (ts/auditId/trustOrigin/
                    //     decision/prevHash/tool). The row used to read only (1)'s
                    // fields, so every (2) row rendered as blank skeleton cells.
                    // Normalize once per row with a small fallback chain — the
                    // expanded JSON view below still shows the raw entry so power
                    // users see everything.
                    const e = entry as unknown as Record<string, unknown>;
                    const ts = (e.timestamp ?? e.ts) as string | undefined;
                    const rowType = (e.type ?? e.decision ?? "—") as string;
                    const sessionPreview = typeof e.sessionId === "string" ? (e.sessionId as string).slice(0, 8) : undefined;
                    const routeOrTool = (e.route ?? e.tool ?? e.trustOrigin ?? sessionPreview) as string | undefined;
                    const previewRaw = (e.input ?? e.output ?? e.reason ?? "") as string;
                    const preview = typeof previewRaw === "string" ? previewRaw : String(previewRaw);
                    const badgeClass = TYPE_BADGE[rowType] ?? "bg-muted text-muted-foreground";
                    return (
                      <React.Fragment key={i}>
                        <tr
                          className="cursor-pointer border-b last:border-0 hover:bg-muted/(--opacity-light)"
                          onClick={() => setExpandedIdx(isExpanded ? null : i)}
                        >
                          <td className="px-3 py-1.5 font-mono text-[10px] text-muted-foreground whitespace-nowrap">
                            {ts?.slice(0, 19).replace("T", " ") ?? "—"}
                          </td>
                          <td className="px-3 py-1.5">
                            <Badge className={`text-[10px] ${badgeClass}`}>{rowType}</Badge>
                          </td>
                          <td className="px-3 py-1.5 text-muted-foreground font-mono">
                            {routeOrTool ?? "—"}
                          </td>
                          <td className="max-w-[200px] truncate px-3 py-1.5 text-muted-foreground">
                            {preview.slice(0, 80)}
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr className="border-b last:border-0 bg-muted/(--opacity-muted)">
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

        {/* ── Diagnostics (#1499 E2): bundle export + log tail + crash list ── */}
        <DiagnosticsSection defaultDateFrom={dateFrom} defaultDateTo={dateTo} />
      </div>
    </div>
  );
}
