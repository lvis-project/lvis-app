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
import { useTranslation } from "../../../../i18n/react.js";
import { t } from "../../../../i18n/runtime.js";
import {
  SummaryTile,
  ReviewRow,
  categoryLabel,
  inputVolumeLabel,
  levelBadgeClass,
  riskLevelKoLabel,
  parseInputSummary,
  payloadLabel,
  pickSummary,
  reviewBoxClass,
  reviewTitleForCategory,
  scopeLabel,
  sensitivityLabel,
  type ReviewBasisRow,
} from "./PermissionDecisionCard.js";
import {
  formatEvaluationLimits,
  PermissionEvaluationContextPanel,
} from "./PermissionEvaluationContextPanel.js";

export interface DeferredQueuePanelProps {
  showEmpty?: boolean;
  onClose?: () => void;
}

export function DeferredQueuePanel({ showEmpty = false, onClose }: DeferredQueuePanelProps): ReactElement | null {
  const { t } = useTranslation();
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
        const r = await api(id, decision, undefined, "button");
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
  // Round-7 architect MAJOR — Korean risk label (was raw English
  // `activeLevel.toUpperCase()` → `LOW`/`MEDIUM`/`HIGH` leaking into UI).
  const queueBadge = hasPending ? riskLevelKoLabel(activeLevel) : t("deferredQueuePanel.noQueue");
  const badgeClassName = levelBadgeClass(activeLevel);

  return (
    <section className="min-w-0 space-y-3" data-testid="deferred-queue-panel">
      {!hasPending && (
        <header className="flex min-w-0 flex-wrap items-center gap-2 pb-1">
          <Badge variant="outline" className={`${badgeClassName} shrink-0`}>
            {queueBadge}
          </Badge>
          <h3 className="min-w-0 flex-1 text-base font-semibold">
            {t("deferredQueuePanel.noPendingTitle")}
          </h3>
        </header>
      )}
      {error && (
        <p className="mb-2 rounded bg-destructive/10 px-2 py-1 text-xs text-destructive">
          {error}
        </p>
      )}
      {pending.length === 0 && !error ? (
        <div
          className="rounded border bg-background p-3 text-sm text-muted-foreground"
          data-testid="deferred-queue-empty"
        >
          {t("deferredQueuePanel.emptyState")}
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
                      {t("deferredQueuePanel.approvalTitle")}
                    </h4>
                    <Badge variant="outline" className="shrink-0 text-[11px] text-muted-foreground">
                      {t("deferredQueuePanel.pendingBadge", { count: pending.length, current: activeIndex + 1 })}
                    </Badge>
                  </div>
                </div>
              </div>
              <div className="space-y-3">
                <div className="grid min-w-0 gap-2 sm:grid-cols-2">
                  <SummaryTile label={t("deferredQueuePanel.toolSourceLabel")}>
                    <code>{activeEntry.toolName}</code>
                    <br />
                    {t("deferredQueuePanel.sourceWithValue", { source: sourceLabel(activeEntry.source) })}
                  </SummaryTile>
                  <SummaryTile label={t("deferredQueuePanel.categoryLabel")}>
                    {categoryLabel(activeEntry.category)}
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
                          className="max-h-40 max-w-full overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed"
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
                <PermissionEvaluationContextPanel context={activeEntry.evaluationContext} />
                <details className="min-w-0 rounded-md border bg-muted/20">
                  <summary className="cursor-pointer px-3 py-2 text-xs font-semibold">
                    {t("deferredQueuePanel.showFullInput")}
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
                    {t("deferredQueuePanel.closeButton")}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  className="border-destructive text-destructive hover:bg-destructive/15"
                  disabled={busy}
                  onClick={() => handle(activeEntry.id, "rejected")}
                >
                  {t("deferredQueuePanel.rejectButton")}
                </Button>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => handle(activeEntry.id, "approved")}
                >
                  {t("deferredQueuePanel.approveButton")}
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
  // Round-7 architect MAJOR — Korean risk label in the review row.
  const verdict = `${riskLevelKoLabel(entry.verdict.level)} · ${entry.verdict.reason}`;
  const common = { label: t("deferredQueuePanel.rowLabelVerdict"), value: verdict };
  if (entry.category === "read") {
    return [
      { label: t("deferredQueuePanel.rowLabelTarget"), value: pickSummary(parsed, ["path", "paths", "target", "targets", "file", "directory", "resource", "query", "url", "uri"], entry.inputSummary), monospace: true, testId: "deferred-entry-input" },
      { label: t("deferredQueuePanel.rowLabelScope"), value: `${sourceLabel(entry.source)} · ${categoryLabel(entry.category)} · ${scopeLabel(parsed)}` },
      { label: t("deferredQueuePanel.rowLabelSensitivity"), value: sensitivityLabel(parsed) },
      { label: t("deferredQueuePanel.rowLabelVolume"), value: inputVolumeLabel(entry.inputSummary) },
      common,
      { label: t("deferredQueuePanel.rowLabelChoice"), value: t("deferredQueuePanel.choiceQueueOnly") },
    ];
  }
  if (entry.category === "write") {
    return [
      { label: t("deferredQueuePanel.rowLabelTarget"), value: pickSummary(parsed, ["path", "paths", "target", "targets", "file", "configKey", "taskId", "id"], entry.inputSummary), monospace: true, testId: "deferred-entry-input" },
      { label: t("deferredQueuePanel.rowLabelChange"), value: pickSummary(parsed, ["operation", "action", "mode", "patch", "content", "body", "text"], t("deferredQueuePanel.writeChangeFallback")), monospace: true },
      { label: t("deferredQueuePanel.rowLabelImpact"), value: `${sourceLabel(entry.source)} · ${categoryLabel(entry.category)} · ${t("deferredQueuePanel.writeImpactSuffix")}` },
      { label: t("deferredQueuePanel.rowLabelRecovery"), value: pickSummary(parsed, ["diff", "backup", "rollback", "undo"], t("deferredQueuePanel.recoveryFallback")) },
      common,
      { label: t("deferredQueuePanel.rowLabelChoice"), value: t("deferredQueuePanel.choiceQueueOnly") },
    ];
  }
  if (entry.category === "network") {
    return [
      { label: t("deferredQueuePanel.rowLabelEndpoint"), value: pickSummary(parsed, ["endpoint", "url", "uri", "host", "baseUrl"], t("deferredQueuePanel.endpointFallback")), monospace: true, testId: "deferred-entry-input" },
      { label: t("deferredQueuePanel.rowLabelMethod"), value: pickSummary(parsed, ["method", "httpMethod"], t("deferredQueuePanel.methodFallback")) },
      { label: t("deferredQueuePanel.rowLabelPayload"), value: pickSummary(parsed, ["payload", "body", "message", "text", "input", "params", "args"], payloadLabel(entry.inputSummary)), monospace: true },
      { label: t("deferredQueuePanel.rowLabelAuthScope"), value: pickSummary(parsed, ["auth", "scope", "scopes", "tenant", "account"], t("deferredQueuePanel.authScopeFallback")) },
      common,
      { label: t("deferredQueuePanel.rowLabelChoice"), value: t("deferredQueuePanel.choiceQueueOnly") },
    ];
  }
  if (entry.category === "shell") {
    return [
      { label: t("deferredQueuePanel.rowLabelCommand"), value: pickSummary(parsed, ["command", "cmd", "args", "script", "argv"], entry.inputSummary), monospace: true, testId: "deferred-entry-input" },
      { label: t("deferredQueuePanel.rowLabelWorkDir"), value: pickSummary(parsed, ["cwd", "workingDirectory", "env", "environment"], t("deferredQueuePanel.workDirFallback")), monospace: true },
      { label: t("deferredQueuePanel.rowLabelSideEffects"), value: t("deferredQueuePanel.shellSideEffects") },
      { label: t("deferredQueuePanel.rowLabelLimits"), value: formatEvaluationLimits(entry.evaluationContext) },
      common,
      { label: t("deferredQueuePanel.rowLabelChoice"), value: t("deferredQueuePanel.choiceQueueOnly") },
    ];
  }
  return [
    { label: t("deferredQueuePanel.rowLabelInput"), value: entry.inputSummary, monospace: true, testId: "deferred-entry-input" },
    common,
    { label: t("deferredQueuePanel.rowLabelChoice"), value: t("deferredQueuePanel.choiceQueueOnly") },
  ];
}

function sourceLabel(source: DeferredQueueEntry["source"]): string {
  return SOURCE_BADGE[source] ?? source;
}
