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
import { useEffect, useState, useCallback, type ReactElement } from "react";
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
  const severityLabel = hasPending
    ? highest === "high"
      ? "HIGH/MEDIUM 위험"
      : "MEDIUM 위험"
    : "대기 없음";
  const panelClassName = hasPending || error
    ? "min-w-0 overflow-hidden rounded-lg border border-red-500/40 bg-red-500/5 p-3"
    : "min-w-0 overflow-hidden rounded-lg border bg-background p-3";
  const badgeClassName = hasPending || error
    ? "border-red-500 text-red-700 dark:text-red-400"
    : "text-muted-foreground";

  return (
    <section
      className={panelClassName}
      data-testid="deferred-queue-panel"
    >
      <header className="mb-2 flex min-w-0 flex-wrap items-center gap-2">
        <Badge variant="outline" className={`${badgeClassName} shrink-0`}>
          {severityLabel}
        </Badge>
        <h3 className="min-w-0 flex-1 text-sm font-medium">
          {hasPending
            ? `백그라운드에서 보류된 작업 (${pending.length})`
            : "보류된 승인 요청 없음"}
        </h3>
      </header>
      {hasPending && (
        <p className="mb-2 text-xs text-muted-foreground">
          사용자가 보지 않는 실행에서 리뷰어가 MEDIUM 이상으로 분류해 자동 실행을
          보류한 도구 호출입니다. 각 항목의 영향범위를 확인한 뒤 허용하거나 거부하세요.
        </p>
      )}
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
              className="min-w-0 overflow-hidden rounded border bg-background p-3 text-sm"
              data-testid={`deferred-entry-${entry.id}`}
            >
              <div className="mb-2 flex min-w-0 flex-wrap items-center gap-2">
                <code className="max-w-full truncate rounded bg-muted px-2 py-1 font-mono text-xs">
                  {entry.toolName}
                </code>
                <Badge variant="outline" className="shrink-0 text-[11px]">
                  {entry.source}
                </Badge>
                <Badge variant="outline" className="shrink-0 text-[11px]">
                  {entry.category}
                </Badge>
                <Badge variant="outline" className="shrink-0 text-[11px]">
                  {entry.verdict.level.toUpperCase()}
                </Badge>
                <time className="text-[11px] text-muted-foreground sm:ml-auto">
                  {entry.ts.slice(0, 19).replace("T", " ")}
                </time>
              </div>
              <p className="mb-2 break-words text-xs text-muted-foreground">
                {entry.verdict.reason}
              </p>
              <pre
                className="mb-3 max-w-full overflow-x-hidden whitespace-pre-wrap break-all rounded bg-muted/50 px-2 py-1 font-mono text-[11px] leading-relaxed"
                data-testid="deferred-entry-input"
              >
                {entry.inputSummary}
              </pre>
              <div className="flex justify-end gap-2">
                <Button
                  size="sm"
                  variant="ghost"
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
