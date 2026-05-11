/**
 * Renders the list of MED/HIGH-risk headless actions that the Layer 5
 * reviewer agent deferred during headless execution. Each entry has
 * "허용" / "거부" buttons; the user's click resolves the entry
 * via IPC and writes an audit record on the main side.
 *
 * Spec ref: docs/architecture/permission-policy-design.md §3
 * Layer 5 — "MED/HIGH → deferred queue, user-opened queue surface".
 *
 * Mounting:
 *   - On mount: load via lvis.permission.deferredList().
 *   - On `lvis:permissions:deferred-pending` event: refresh.
 *   - User click: lvis.permission.deferredResolve(id, decision).
 *
 * Visual: severity border, monospace inputSummary, clear
 * "approved" / "rejected" terminal feedback (entry disappears from
 * pending; the underlying JSONL keeps the resolution record).
 */
import { useEffect, useState, useCallback, type ReactElement, type ReactNode } from "react";
import { Badge } from "../../../../components/ui/badge.js";
import { Button } from "../../../../components/ui/button.js";
import type { DeferredQueueEntry } from "../../types.js";

export interface DeferredQueuePanelProps {
  showEmpty?: boolean;
}

export function DeferredQueuePanel({ showEmpty = false }: DeferredQueuePanelProps): ReactElement | null {
  const [pending, setPending] = useState<DeferredQueueEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    const api = window.lvis?.permission?.deferredList;
    if (!api) return;
    try {
      const r = await api();
      if (r.ok) {
        setPending(r.pending);
      } else {
        setError(r.error);
      }
    } catch (err) {
      setPending([]);
      setError(err instanceof Error ? err.message : "deferred-list failed");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const sub = window.lvis?.permission?.onDeferredPending?.(() => {
      void refresh();
    });
    return () => {
      sub?.();
    };
  }, [refresh]);

  const handle = useCallback(
    async (id: string, decision: "approved" | "rejected") => {
      const api = window.lvis?.permission?.deferredResolve;
      if (!api) return;
      setBusy(true);
      try {
        const r = await api(id, decision);
        await refresh();
        if (!r.ok) setError(r.error);
      } catch (err) {
        await refresh();
        setError(err instanceof Error ? err.message : "deferred-resolve failed");
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  if (pending.length === 0 && !error && !showEmpty) return null;

  const hasPending = pending.length > 0;
  const highest = pending.some((entry) => entry.verdict.level === "high") ? "high" : "medium";
  const queueBadge = hasPending
    ? highest === "high"
      ? "HIGH/MEDIUM"
      : "MEDIUM"
    : "대기 없음";
  const badgeClassName = levelBadgeClass(highest);

  return (
    <section className="min-w-0 space-y-3" data-testid="deferred-queue-panel">
      <header className="flex min-w-0 flex-wrap items-center gap-2">
        <Badge variant="outline" className={`${badgeClassName} shrink-0`}>
          {queueBadge}
        </Badge>
        <h3 className="min-w-0 flex-1 text-sm font-medium">
          {hasPending
            ? `수동 검토 대기 (${pending.length})`
            : "보류된 승인 요청 없음"}
        </h3>
      </header>
      {error && (
        <p className="mb-2 rounded bg-red-500/10 px-2 py-1 text-xs text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
      {pending.length === 0 && !error ? (
        <div
          className="rounded border bg-background p-3 text-sm text-muted-foreground"
          data-testid="deferred-queue-empty"
        >
          보류된 승인 요청이 없습니다.
        </div>
      ) : (
        <ul className="min-w-0 space-y-2">
          {pending.map((entry) => (
            <li
              key={entry.id}
              className="min-w-0 overflow-hidden rounded-lg border bg-background text-sm shadow-sm"
              data-testid={`deferred-entry-${entry.id}`}
            >
              <div className="flex min-w-0 items-start border-b px-3 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <h4 className="min-w-0 text-sm font-semibold">
                      {entryTitle(entry)}
                    </h4>
                    <Badge variant="outline" className={`${levelBadgeClass(entry.verdict.level)} shrink-0`}>
                      {entry.verdict.level.toUpperCase()}
                    </Badge>
                  </div>
                  <p className="mt-1 break-words text-xs text-muted-foreground">
                    {entrySubtitle(entry)}
                  </p>
                </div>
              </div>
              <div className="space-y-3 px-3 py-3">
                <div className="grid min-w-0 gap-2 sm:grid-cols-3">
                  <SummaryTile label="도구 / 출처">
                    <code>{entry.toolName}</code>
                    <br />
                    source={entry.source}
                  </SummaryTile>
                  <SummaryTile label="권한 category">
                    {entry.category}
                    <br />
                    {categoryLabel(entry.category)}
                  </SummaryTile>
                  <SummaryTile label="큐 상태">
                    not executed
                    <br />
                    pending approval
                  </SummaryTile>
                </div>
                <div className={`min-w-0 overflow-hidden rounded-md border ${reviewBoxClass(entry.verdict.level)}`}>
                  <h4 className="border-b px-3 py-2 text-xs font-semibold">
                    {reviewTitle(entry)}
                  </h4>
                  <ReviewRow label="도구">
                    <code>{entry.toolName}</code> · source={entry.source} · category={entry.category}
                  </ReviewRow>
                  <ReviewRow label="Reviewer">
                    {entry.verdict.level.toUpperCase()}: {entry.verdict.reason}
                  </ReviewRow>
                  <ReviewRow label={entry.category === "shell" ? "명령/인자" : "입력 요약"}>
                    <pre
                      className="max-w-full overflow-x-hidden whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed"
                      data-testid="deferred-entry-input"
                    >
                      {entry.inputSummary}
                    </pre>
                  </ReviewRow>
                  <ReviewRow label="큐 처리">
                    허용 또는 거부하면 이 보류 항목과 audit 이 닫힙니다.
                  </ReviewRow>
                </div>
              </div>
              <div className="flex flex-wrap justify-end gap-2 border-t px-3 py-3">
                <Button
                  size="sm"
                  variant="outline"
                  className="border-red-500 text-red-700 hover:bg-red-500/10 dark:text-red-400"
                  disabled={busy}
                  onClick={() => handle(entry.id, "rejected")}
                >
                  거부
                </Button>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => handle(entry.id, "approved")}
                >
                  허용
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SummaryTile({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 rounded-md border bg-muted/20 px-3 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-1 break-words text-xs font-medium leading-relaxed">
        {children}
      </div>
    </div>
  );
}

function ReviewRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 grid-cols-[88px_minmax(0,1fr)] gap-3 border-b px-3 py-2 last:border-b-0">
      <b className="text-xs">{label}</b>
      <div className="min-w-0 break-words text-xs leading-relaxed">
        {children}
      </div>
    </div>
  );
}

function levelBadgeClass(level: "low" | "medium" | "high") {
  if (level === "high") return "border-red-500 text-red-700 dark:text-red-400";
  if (level === "medium") return "border-amber-500 text-amber-700 dark:text-amber-300";
  return "border-primary text-primary";
}

function reviewBoxClass(level: "low" | "medium" | "high") {
  if (level === "high") return "border-red-500/50 bg-red-500/5";
  if (level === "medium") return "border-amber-500/50 bg-amber-500/5";
  return "border-primary/40 bg-primary/5";
}

function entryTitle(entry: DeferredQueueEntry) {
  if (entry.category === "network") return "외부 서비스로 데이터 전송 승인 필요";
  if (entry.category === "shell") return "백그라운드 명령 실행 승인 필요";
  if (entry.category === "write") return "백그라운드 변경 작업 승인 필요";
  return "보류된 도구 호출 승인 필요";
}

function entrySubtitle(entry: DeferredQueueEntry) {
  if (entry.category === "network") {
    return "LLM reviewer 가 endpoint, payload class, auth scope, retention risk 를 평가했습니다.";
  }
  return "사용자가 보지 않는 실행에서 reviewer 가 MEDIUM 이상으로 분류해 자동 실행을 보류했습니다.";
}

function reviewTitle(entry: DeferredQueueEntry) {
  if (entry.category === "network") return "네트워크 영향범위";
  if (entry.category === "shell") return "명령 영향범위";
  return "작업 영향범위";
}

function categoryLabel(category: DeferredQueueEntry["category"]) {
  if (category === "network") return "external send";
  if (category === "shell") return "command";
  if (category === "write") return "mutation";
  if (category === "read") return "read access";
  return "policy";
}
