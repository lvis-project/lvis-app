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
import { SOURCE_BADGE } from "../../constants.js";
import type { DeferredQueueEntry } from "../../types.js";
import {
  SummaryTile,
  ReviewRow,
  categoryLabel,
  inputVolumeLabel,
  levelBadgeClass,
  parseInputSummary,
  payloadLabel,
  pickSummary,
  reviewBoxClass,
  reviewTitleForCategory,
  scopeLabel,
  sensitivityLabel,
  type ParsedSummary,
  type ReviewBasisRow,
} from "./PermissionDecisionCard.js";

export interface DeferredQueuePanelProps {
  showEmpty?: boolean;
  onClose?: () => void;
}

export function DeferredQueuePanel({ showEmpty = false, onClose }: DeferredQueuePanelProps): ReactElement | null {
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
      {!hasPending && (
        <header className="flex min-w-0 flex-wrap items-center gap-2 pb-1">
          <Badge variant="outline" className={`${badgeClassName} shrink-0`}>
            {queueBadge}
          </Badge>
          <h3 className="min-w-0 flex-1 text-base font-semibold">
            보류된 승인 요청 없음
          </h3>
        </header>
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
        <ul className="min-w-0">
          {activeEntry && (
            <li
              key={activeEntry.id}
              className="min-w-0 overflow-hidden text-sm"
              data-testid={`deferred-entry-${activeEntry.id}`}
            >
              <div className="flex min-w-0 items-start pb-3">
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <Badge variant="outline" className={`${badgeClassName} shrink-0`}>
                      {queueBadge}
                    </Badge>
                    <h4 className="min-w-0 flex-1 text-base font-semibold">
                      백그라운드 변경 승인
                    </h4>
                    <Badge variant="outline" className="shrink-0 text-[11px] text-muted-foreground">
                      {pending.length} 대기 · {activeIndex + 1} / {pending.length}
                    </Badge>
                  </div>
                </div>
              </div>
              <div className="space-y-3">
                <div className="grid min-w-0 gap-2 sm:grid-cols-2">
                  <SummaryTile label="도구 / 출처">
                    <code>{activeEntry.toolName}</code>
                    <br />
                    출처: {sourceLabel(activeEntry.source)}
                  </SummaryTile>
                  <SummaryTile label="권한 분류">
                    {categoryLabel(activeEntry.category)}
                    <br />
                    {activeEntry.category}
                  </SummaryTile>
                </div>
                <div className={`min-w-0 overflow-hidden rounded-md border ${reviewBoxClass(activeEntry.verdict.level)}`}>
                  <h4 className="border-b px-3 py-2 text-xs font-semibold">
                    {reviewTitleForCategory(activeEntry.category)}
                  </h4>
                  {reviewRows(activeEntry).map((row) => (
                    <ReviewRow key={row.label} label={row.label}>
                      {row.monospace ? (
                        <pre
                          className="max-h-24 max-w-full overflow-hidden whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed"
                          data-testid={row.testId}
                        >
                          {row.value}
                        </pre>
                      ) : (
                        row.value
                      )}
                    </ReviewRow>
                  ))}
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
              <div className="mt-4 flex flex-wrap justify-end gap-2 border-t pt-3">
                {onClose && (
                  <Button
                    size="sm"
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={onClose}
                  >
                    닫기
                  </Button>
                )}
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

function reviewRows(entry: DeferredQueueEntry): ReviewBasisRow[] {
  const parsed = parseInputSummary(entry.inputSummary);
  const verdict = `${entry.verdict.level.toUpperCase()} · ${entry.verdict.reason}`;
  const common = { label: "판단", value: verdict };
  if (entry.category === "read") {
    return [
      { label: "대상", value: pickSummary(parsed, ["path", "paths", "target", "targets", "file", "directory", "resource", "query", "url", "uri"], entry.inputSummary), monospace: true, testId: "deferred-entry-input" },
      { label: "범위", value: `${sourceLabel(entry.source)} · ${categoryLabel(entry.category)} · ${scopeLabel(parsed)}` },
      { label: "민감도", value: sensitivityLabel(parsed) },
      { label: "양", value: inputVolumeLabel(entry.inputSummary) },
      common,
      { label: "선택", value: "큐에서는 이번 항목 허용 또는 거부만 처리합니다." },
    ];
  }
  if (entry.category === "write") {
    return [
      { label: "대상", value: pickSummary(parsed, ["path", "paths", "target", "targets", "file", "configKey", "taskId", "id"], entry.inputSummary), monospace: true, testId: "deferred-entry-input" },
      { label: "변경", value: pickSummary(parsed, ["operation", "action", "mode", "patch", "content", "body", "text"], "변경 내용은 입력 요약 기준으로 확인합니다."), monospace: true },
      { label: "영향", value: `${sourceLabel(entry.source)} · ${categoryLabel(entry.category)} · 파일/설정/사용자 데이터 변경 가능성` },
      { label: "복구", value: pickSummary(parsed, ["diff", "backup", "rollback", "undo"], "복구 정보는 입력 요약에 명시되지 않음") },
      common,
      { label: "선택", value: "큐에서는 이번 항목 허용 또는 거부만 처리합니다." },
    ];
  }
  if (entry.category === "network") {
    return [
      { label: "엔드포인트", value: pickSummary(parsed, ["endpoint", "url", "uri", "host", "baseUrl"], "엔드포인트 정보는 입력 요약에 명시되지 않음"), monospace: true, testId: "deferred-entry-input" },
      { label: "메서드", value: pickSummary(parsed, ["method", "httpMethod"], "메서드 정보는 입력 요약에 명시되지 않음") },
      { label: "전송 내용", value: pickSummary(parsed, ["payload", "body", "message", "text", "input", "params", "args"], payloadLabel(entry.inputSummary)), monospace: true },
      { label: "인증 범위", value: pickSummary(parsed, ["auth", "scope", "scopes", "tenant", "account"], "인증 범위 정보는 입력 요약에 명시되지 않음") },
      common,
      { label: "선택", value: "큐에서는 이번 항목 허용 또는 거부만 처리합니다." },
    ];
  }
  if (entry.category === "shell") {
    return [
      { label: "명령", value: pickSummary(parsed, ["command", "cmd", "args", "script", "argv"], entry.inputSummary), monospace: true, testId: "deferred-entry-input" },
      { label: "작업 디렉토리/환경", value: pickSummary(parsed, ["cwd", "workingDirectory", "env", "environment"], "작업 디렉토리/환경 정보는 입력 요약에 명시되지 않음"), monospace: true },
      { label: "부작용", value: "파일 변경, 네트워크 호출, dependency install, background process 가능성을 명령 기준으로 확인합니다." },
      { label: "제한", value: pickSummary(parsed, ["timeout", "sandbox", "allowedDirectories", "allowedDir"], "제한 정보는 입력 요약에 명시되지 않음") },
      common,
      { label: "선택", value: "큐에서는 이번 항목 허용 또는 거부만 처리합니다." },
    ];
  }
  return [
    { label: "입력", value: entry.inputSummary, monospace: true, testId: "deferred-entry-input" },
    common,
    { label: "선택", value: "큐에서는 이번 항목 허용 또는 거부만 처리합니다." },
  ];
}

function sourceLabel(source: DeferredQueueEntry["source"]): string {
  return SOURCE_BADGE[source] ?? source;
}
