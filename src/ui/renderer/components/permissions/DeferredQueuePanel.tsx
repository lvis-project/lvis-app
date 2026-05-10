/**
 * Renders the list of MED/HIGH-risk headless actions that the Layer 5
 * reviewer agent deferred during headless execution. Each entry has
 * "승인" / "거부" buttons; the user's click resolves the entry
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

  const highest = pending.some((entry) => entry.verdict.level === "high") ? "high" : "medium";
  const severityLabel = highest === "high" ? "HIGH/MEDIUM 위험" : "MEDIUM 위험";

  return (
    <section
      className="rounded-lg border border-red-500/40 bg-red-500/5 p-3"
      data-testid="deferred-queue-panel"
    >
      <header className="mb-2 flex items-center gap-2">
        <Badge variant="outline" className="border-red-500 text-red-700 dark:text-red-400">
          {severityLabel}
        </Badge>
        <h3 className="text-sm font-medium">
          백그라운드에서 보류된 작업 ({pending.length})
        </h3>
      </header>
      <p className="mb-2 text-xs text-muted-foreground">
        사용자가 보지 않는 실행에서 리뷰어가 MEDIUM 이상으로 분류해 자동 실행을
        보류한 도구 호출입니다. 각 항목의 영향범위를 확인한 뒤 승인하거나 거부하세요.
      </p>
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
        <ul className="space-y-2">
          {pending.map((entry) => (
            <li
              key={entry.id}
              className="rounded border bg-background p-2 text-sm"
              data-testid={`deferred-entry-${entry.id}`}
            >
              <div className="mb-1 flex items-center gap-2">
                <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono">
                  {entry.toolName}
                </code>
                <Badge variant="outline" className="text-[11px]">
                  {entry.source}
                </Badge>
                <Badge variant="outline" className="text-[11px]">
                  {entry.category}
                </Badge>
                <Badge variant="outline" className="text-[11px]">
                  {entry.verdict.level.toUpperCase()}
                </Badge>
                <time className="ml-auto text-[11px] text-muted-foreground">
                  {entry.ts.slice(0, 19).replace("T", " ")}
                </time>
              </div>
              <p className="mb-1 text-xs text-muted-foreground">
                {entry.verdict.reason}
              </p>
              <pre className="mb-2 overflow-x-auto rounded bg-muted/50 px-2 py-1 text-[11px]">
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
                  승인
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
