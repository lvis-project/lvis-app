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
  const [activeIndex, setActiveIndex] = useState(0);
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

  useEffect(() => {
    setActiveIndex((current) => {
      if (pending.length === 0) return 0;
      return Math.min(current, pending.length - 1);
    });
  }, [pending.length]);

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
  const activeEntry = pending[activeIndex] ?? pending[0];
  const activeLevel = activeEntry?.verdict.level ?? "low";
  const queueBadge = hasPending
    ? activeLevel.toUpperCase()
    : "대기 없음";
  const badgeClassName = levelBadgeClass(activeLevel);

  return (
    <section className="min-w-0 space-y-3" data-testid="deferred-queue-panel">
      <header className="flex min-w-0 flex-wrap items-center gap-2">
        <Badge variant="outline" className={`${badgeClassName} shrink-0`}>
          {queueBadge}
        </Badge>
        <h3 className="min-w-0 flex-1 text-sm font-medium">
          {hasPending
            ? "백그라운드 변경 승인"
            : "보류된 승인 요청 없음"}
        </h3>
        {hasPending && (
          <Badge variant="outline" className="shrink-0 text-[11px] text-muted-foreground">
            {pending.length} pending · {activeIndex + 1} / {pending.length}
          </Badge>
        )}
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
        <ul className="min-w-0">
          {activeEntry && (
            <li
              key={activeEntry.id}
              className="min-w-0 overflow-hidden rounded-lg border bg-background text-sm shadow-sm"
              data-testid={`deferred-entry-${activeEntry.id}`}
            >
              <div className="flex min-w-0 items-start border-b px-3 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <h4 className="min-w-0 text-sm font-semibold">
                      <code>{activeEntry.toolName}</code>
                    </h4>
                    <Badge variant="outline" className={`${levelBadgeClass(activeEntry.verdict.level)} shrink-0`}>
                      {activeEntry.verdict.level.toUpperCase()}
                    </Badge>
                  </div>
                </div>
              </div>
              <div className="space-y-3 px-3 py-3">
                <div className="grid min-w-0 gap-2 sm:grid-cols-2">
                  <SummaryTile label="도구 / 출처">
                    <code>{activeEntry.toolName}</code>
                    <br />
                    source={activeEntry.source}
                  </SummaryTile>
                  <SummaryTile label="권한 category">
                    {activeEntry.category}
                    <br />
                    {categoryLabel(activeEntry.category)}
                  </SummaryTile>
                </div>
                <div className={`min-w-0 overflow-hidden rounded-md border ${reviewBoxClass(activeEntry.verdict.level)}`}>
                  <h4 className="border-b px-3 py-2 text-xs font-semibold">
                    {reviewTitle(activeEntry)}
                  </h4>
                  <ReviewRow label="사유">
                    {activeEntry.verdict.level.toUpperCase()} · {activeEntry.verdict.reason}
                  </ReviewRow>
                  <ReviewRow label={activeEntry.category === "shell" ? "명령/인자" : "입력"}>
                    <pre
                      className="max-h-24 max-w-full overflow-hidden whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed"
                      data-testid="deferred-entry-input"
                    >
                      {activeEntry.inputSummary}
                    </pre>
                  </ReviewRow>
                </div>
                <details className="min-w-0 rounded-md border bg-muted/20">
                  <summary className="cursor-pointer px-3 py-2 text-xs font-semibold">
                    전체 입력 보기
                  </summary>
                  <pre className="max-h-56 max-w-full overflow-auto border-t px-3 py-2 whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed">
                    {activeEntry.inputSummary}
                  </pre>
                </details>
              </div>
              <div className="flex flex-wrap justify-end gap-2 border-t px-3 py-3">
                <Button
                  size="sm"
                  variant="outline"
                  className="border-red-500 text-red-700 hover:bg-red-500/10 dark:text-red-400"
                  disabled={busy}
                  onClick={() => handle(activeEntry.id, "rejected")}
                >
                  거부
                </Button>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => handle(activeEntry.id, "approved")}
                >
                  허용
                </Button>
              </div>
            </li>
          )}
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
