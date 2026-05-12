/**
 * AuditPanel.
 *
 * Side panel surfacing the discriminated-union audit log + the HMAC
 * chain integrity verdict. Driven by:
 *   - `window.lvis.permission.auditShow(N)` — recent entries.
 *   - `window.lvis.permission.auditVerify()` — chain check.
 *
 * Spec ref: docs/architecture/permission-policy-design.md §3
 * Layer 7, §3 Layer 8 (`/permission audit show|verify`).
 *
 * The panel is filterable by decision type (allow/ask/deny/deferred/
 * mode_change/manifest_violation) and by tool name (substring). Each
 * row is collapsed to a single line with an expand toggle that shows
 * the full discriminated-union shape.
 *
 * Tamper-evidence indicator at the top:
 *   - Green check: chain intact + all daily seals match.
 *   - Yellow warning: chain ok but at least one seal is missing/null.
 *   - Red warning: chain broken — first broken file + line index shown.
 */
import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { Badge } from "../../../../components/ui/badge.js";
import { Button } from "../../../../components/ui/button.js";
import type { PermissionAuditEntrySummary } from "../../types.js";

type DecisionFilter = "all" | "allow" | "ask" | "deny" | "deferred" | "mode_change" | "manifest_violation";

interface VerifyResult {
  intact: boolean;
  totalFiles: number;
  totalEntries: number;
  firstBrokenFile?: string;
  perDay: Array<{
    file: string;
    totalLines: number;
    chainOk: boolean;
    firstBrokenLineIndex?: number;
    reason?: string;
    sealMatch: boolean | null;
  }>;
}

interface AuditPanelProps {
  /** When false, render nothing. Slash command toggles this. */
  open: boolean;
  /** Closer — propagates "X" button click. */
  onClose: () => void;
  /** Override fetcher for tests. Defaults to window.lvis.permission.* */
  fetcher?: {
    show: (last: number) => Promise<
      | { ok: true; entries: PermissionAuditEntrySummary[]; total: number; summary: { files: number; bytes: number } }
      | { ok: false; error: string }
    >;
    verify: () => Promise<
      | { ok: true; intact: boolean; totalFiles: number; totalEntries: number; firstBrokenFile?: string; perDay: VerifyResult["perDay"] }
      | { ok: false; error: string }
    >;
  };
  /** Initial fetch size (default 50, max 1000). */
  initialLast?: number;
}

export function AuditPanel({
  open,
  onClose,
  fetcher,
  initialLast = 50,
}: AuditPanelProps): ReactElement | null {
  const [entries, setEntries] = useState<PermissionAuditEntrySummary[]>([]);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState<{ files: number; bytes: number }>({ files: 0, bytes: 0 });
  const [verify, setVerify] = useState<VerifyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [last, setLast] = useState(initialLast);
  const [decisionFilter, setDecisionFilter] = useState<DecisionFilter>("all");
  const [toolFilter, setToolFilter] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const api = useMemo(
    () =>
      fetcher ?? {
        show: (n: number) => window.lvis!.permission!.auditShow(n),
        verify: () => window.lvis!.permission!.auditVerify(),
      },
    [fetcher],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.show(last);
      if (r.ok) {
        setEntries(r.entries);
        setTotal(r.total);
        setSummary(r.summary);
      } else {
        setError(r.error);
      }
    } finally {
      setLoading(false);
    }
  }, [api, last]);

  const runVerify = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.verify();
      if (r.ok) {
        const { ok: _ok, ...rest } = r;
        setVerify(rest);
      } else {
        setError(r.error);
      }
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    if (open) {
      void refresh();
      void runVerify();
    }
  }, [open, refresh, runVerify]);

  const filtered = useMemo(() => {
    return entries.filter((e) => {
      if (decisionFilter !== "all" && e.decision !== decisionFilter) return false;
      if (toolFilter.trim().length > 0) {
        const needle = toolFilter.trim().toLowerCase();
        const tool = typeof e.tool === "string" ? e.tool.toLowerCase() : "";
        const pluginId = typeof e.pluginId === "string" ? e.pluginId.toLowerCase() : "";
        if (!tool.includes(needle) && !pluginId.includes(needle)) return false;
      }
      return true;
    });
  }, [entries, decisionFilter, toolFilter]);

  const toggleExpand = useCallback((auditId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(auditId)) next.delete(auditId);
      else next.add(auditId);
      return next;
    });
  }, []);

  if (!open) return null;

  const integrityStatus = computeIntegrityStatus(verify);

  return (
    <aside
      className="fixed right-0 top-0 z-50 flex h-full w-[480px] flex-col border-l bg-background shadow-xl"
      data-testid="audit-panel"
      aria-label="Permission audit panel"
    >
      <header className="flex items-center justify-between border-b px-3 py-2">
        <h2 className="text-sm font-semibold">권한 감사 로그</h2>
        <Button
          variant="ghost"
          size="sm"
          onClick={onClose}
          aria-label="Close audit panel"
          data-testid="audit-panel-close"
        >
          ×
        </Button>
      </header>

      {/* Tamper-evidence indicator */}
      <section
        className={`flex items-center gap-2 border-b px-3 py-2 text-xs ${
          integrityStatus.severity === "ok"
            ? "bg-success/10 text-success"
            : integrityStatus.severity === "warn"
              ? "bg-warning/10 text-warning"
              : "bg-destructive/10 text-destructive"
        }`}
        data-testid="audit-integrity-banner"
        data-severity={integrityStatus.severity}
      >
        <span aria-hidden>{integrityStatus.icon}</span>
        <span>{integrityStatus.label}</span>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto h-6 px-2 text-[11px]"
          onClick={runVerify}
          disabled={loading}
          data-testid="audit-verify-button"
        >
          다시 검증
        </Button>
      </section>

      {/* Filters */}
      <section className="flex flex-col gap-2 border-b px-3 py-2 text-xs">
        <div className="flex items-center gap-2">
          <label htmlFor="audit-filter-decision" className="text-muted-foreground">
            결정
          </label>
          <select
            id="audit-filter-decision"
            value={decisionFilter}
            onChange={(e) => setDecisionFilter(e.target.value as DecisionFilter)}
            className="rounded border bg-background px-1 py-0.5"
            data-testid="audit-decision-filter"
          >
            <option value="all">전체</option>
            <option value="allow">allow</option>
            <option value="ask">ask</option>
            <option value="deny">deny</option>
            <option value="deferred">deferred</option>
            <option value="mode_change">mode_change</option>
            <option value="manifest_violation">manifest_violation</option>
          </select>
          <label htmlFor="audit-filter-tool" className="ml-2 text-muted-foreground">
            도구
          </label>
          <input
            id="audit-filter-tool"
            type="text"
            value={toolFilter}
            onChange={(e) => setToolFilter(e.target.value)}
            placeholder="이름 검색"
            className="flex-1 rounded border bg-background px-1 py-0.5"
            data-testid="audit-tool-filter"
          />
        </div>
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span>마지막 {last}개 / 총 {total}건 / 파일 {summary.files} ({Math.round(summary.bytes / 1024)} KB)</span>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto h-5 px-2 text-[10px]"
            onClick={() => {
              setLast((prev) => Math.min(1000, prev + 50));
            }}
            disabled={loading || last >= 1000}
            data-testid="audit-load-more"
          >
            더 보기
          </Button>
        </div>
      </section>

      {error && (
        <p className="border-b bg-destructive/10 px-3 py-1 text-xs text-destructive">
          {error}
        </p>
      )}

      {/* Entry list */}
      <ol className="flex-1 overflow-y-auto" data-testid="audit-entry-list">
        {filtered.length === 0 && (
          <li className="px-3 py-6 text-center text-xs text-muted-foreground">
            표시할 감사 기록이 없습니다.
          </li>
        )}
        {filtered.map((entry) => {
          const isOpen = expanded.has(entry.auditId);
          return (
            <li
              key={entry.auditId}
              className="border-b px-3 py-2 text-xs"
              data-testid={`audit-entry-${entry.auditId}`}
            >
              <button
                type="button"
                onClick={() => toggleExpand(entry.auditId)}
                className="flex w-full items-center gap-2 text-left"
                aria-expanded={isOpen}
              >
                <span aria-hidden>{isOpen ? "▾" : "▸"}</span>
                <Badge variant="outline" className={decisionBadgeClass(entry.decision)}>
                  {entry.decision}
                </Badge>
                <code className="flex-1 truncate rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
                  {decisionSummary(entry)}
                </code>
                <time className="text-[10px] text-muted-foreground">
                  {entry.ts.slice(11, 19)}
                </time>
              </button>
              {isOpen && (
                <pre
                  className="mt-1 overflow-x-auto rounded bg-muted/40 px-2 py-1 text-[11px]"
                  data-testid={`audit-entry-detail-${entry.auditId}`}
                >
                  {JSON.stringify(entry, null, 2)}
                </pre>
              )}
            </li>
          );
        })}
      </ol>
    </aside>
  );
}

function decisionBadgeClass(decision: string): string {
  switch (decision) {
    case "allow":
      return "border-success text-success";
    case "deny":
      return "border-destructive text-destructive";
    case "ask":
      return "border-info text-info";
    case "deferred":
      return "border-warning text-warning";
    case "mode_change":
      return "border-action-view text-action-view";
    case "manifest_violation":
      return "border-emphasis text-emphasis";
    default:
      return "";
  }
}

function decisionSummary(entry: PermissionAuditEntrySummary): string {
  const tool = typeof entry.tool === "string" ? entry.tool : "";
  if (entry.decision === "mode_change") {
    return `${entry.fromMode ?? ""} → ${entry.toMode ?? ""}${entry.durable ? " (durable)" : ""}`;
  }
  if (entry.decision === "manifest_violation") {
    return `${entry.pluginId ?? ""} :: ${entry.toolName ?? ""} (${entry.attemptedOperation ?? ""})`;
  }
  return tool;
}

interface IntegrityStatus {
  severity: "ok" | "warn" | "broken";
  icon: string;
  label: string;
}

function computeIntegrityStatus(verify: VerifyResult | null): IntegrityStatus {
  if (verify === null) {
    return { severity: "warn", icon: "⏳", label: "감사 무결성 확인 중…" };
  }
  if (!verify.intact) {
    if (verify.firstBrokenFile) {
      const broken = verify.perDay.find((d) => d.file === verify.firstBrokenFile);
      const lineHint =
        broken && broken.firstBrokenLineIndex !== undefined
          ? ` — line ${broken.firstBrokenLineIndex}`
          : "";
      return {
        severity: "broken",
        icon: "⚠",
        label: `감사 체인 손상: ${verify.firstBrokenFile}${lineHint}`,
      };
    }
    // Chain ok but seal mismatch
    const sealMismatch = verify.perDay.find((d) => d.sealMatch === false);
    if (sealMismatch) {
      return {
        severity: "broken",
        icon: "⚠",
        label: `일별 봉인 불일치: ${sealMismatch.file}`,
      };
    }
    return { severity: "broken", icon: "⚠", label: "감사 무결성 손상 감지됨" };
  }
  // intact === true — check if any seal is missing
  const sealMissing = verify.perDay.some((d) => d.sealMatch === null && d.totalLines > 0);
  if (sealMissing) {
    return {
      severity: "warn",
      icon: "○",
      label: `체인 OK · 봉인 미생성 일자 있음 (${verify.totalFiles}일 / ${verify.totalEntries}건)`,
    };
  }
  return {
    severity: "ok",
    icon: "✓",
    label: `감사 체인 정상 — ${verify.totalFiles}일 / ${verify.totalEntries}건 검증됨`,
  };
}
