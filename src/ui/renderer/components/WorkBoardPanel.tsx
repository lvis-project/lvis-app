/**
 * WorkBoardPanel — native personal work board (kanban) for the host app.
 *
 * Mirrors RoutinePanel's structure (outer Card + CardHeader action + a
 * scrollable body) but lays the body out as a 3-column kanban over the
 * WorkItem lifecycle: 예정(planned) / 진행 중(in_progress) / 완료(completed).
 *
 * State source: `window.lvisApi` (passed in as `api`). The panel lists items
 * once on mount and then refreshes on every `onWorkBoardItemChanged` event so
 * the board stays live without polling. Create + detail editing happen through
 * a host shadcn `Dialog` built from the host design system (Card / Button /
 * Badge / Dialog + tailwind tokens).
 *
 * `status_resolved` carries the locally-derived `overdue` projection — an item
 * with status ∈ {planned, in_progress} whose `due_at` is in the past. We render
 * it as an overdue badge inside whichever lifecycle column the stored status
 * places it in.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, Play, XCircle } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { t } from "../../../i18n/runtime.js";
import { MARKDOWN_REMARK_PLUGINS } from "../utils/markdown-plugins.js";
import { Badge } from "../../../components/ui/badge.js";
import { Button } from "../../../components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card.js";
import { Checkbox } from "../../../components/ui/checkbox.js";
import { Input } from "../../../components/ui/input.js";
import { Label } from "../../../components/ui/label.js";
import { ScrollArea } from "../../../components/ui/scroll-area.js";
import { Textarea } from "../../../components/ui/textarea.js";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog.js";
import type { LvisApi } from "../types.js";
import type {
  RunProgressEventPayload,
  RunTranscriptEvent,
  WorkBoardReportResult,
  WorkItemCreateInput,
  WorkItemPriority,
  WorkItemResolved,
  WorkItemStatusStored,
  WorkItemUpdateInput,
} from "../../../shared/work-board-types.js";
import { MAX_ITEMS } from "../../../shared/work-board-types.js";

export interface WorkBoardPanelProps {
  api: LvisApi;
}

const TITLE_MAX = 256;
const DESCRIPTION_MAX = 16384;
const DEFAULT_PRIORITY: WorkItemPriority = "medium";

// ─── Priority chips ──────────────────────────────────────────────────────────
//
// Domain priority (high/medium/low) is surfaced as P0/P1/P2 chips. The chip
// variant maps severity to the host token palette: high → destructive accent,
// medium → default, low → muted outline.

const PRIORITY_CHIP_LABEL: Record<WorkItemPriority, string> = {
  high: "priorityHigh",
  medium: "priorityMedium",
  low: "priorityLow",
};

const PRIORITY_FULL_LABEL: Record<WorkItemPriority, string> = {
  high: "priorityHighLabel",
  medium: "priorityMediumLabel",
  low: "priorityLowLabel",
};

const PRIORITY_OPTIONS: WorkItemPriority[] = ["high", "medium", "low"];

function PriorityChip({ priority }: { priority: WorkItemPriority }) {
  const cls =
    priority === "high"
      ? "border-destructive/40 bg-destructive/10 text-destructive"
      : priority === "medium"
        ? "border-primary/40 bg-primary/10 text-primary"
        : "text-muted-foreground";
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold leading-none border ${cls}`}
      title={t(`workBoard.${PRIORITY_FULL_LABEL[priority]}`)}
    >
      {t(`workBoard.${PRIORITY_CHIP_LABEL[priority]}`)}
    </span>
  );
}

// ─── Date helpers (KST-anchored, matches the store + plugin contract) ─────────

/** Project a Date to YYYY-MM-DD in Asia/Seoul (board due dates are KST-anchored). */
function kstYmd(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function isoToKstDate(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return kstYmd(d);
}

function formatDue(iso: string | undefined): string {
  const date = isoToKstDate(iso);
  return date ? t("workBoard.dueLabel", { date }) : t("workBoard.noDueDate");
}

// ─── Agent-orchestration run state ─────────────────────────────────────────────
//
// Live per-item run state derived ENTIRELY from the host run events — there is
// no second source of truth in the renderer. `phase` mirrors the engine's
// WorkBoardRunEvent phases; `busy` is the coarse "a run is in flight" marker
// driven by runStarted/runFinished/runFailed so the indicator survives the gap
// before the first progress event AND the moment after the terminal one.
//
// `awaiting_approval` is intentionally surfaced as a passive notice: the engine
// drives plan approval through the host ApprovalGate (`requestAndWait`), which
// already renders the standard §8 approval dialog. The board does NOT fork a
// second approve/reject control — doing so would mean two competing gates for
// one decision. The notice points the user at the surfaced approval prompt.

type RunPhase = RunProgressEventPayload["phase"];

interface WorkItemRunState {
  /** A run is in flight (between runStarted and runFinished/runFailed). */
  busy: boolean;
  /** Latest phase from the engine progress stream. Undefined until the first event. */
  phase?: RunPhase;
  /** Latest child-agent turn text for the active (planning/executing) phase. */
  liveText?: string;
  /** Terminal failure / denial reason (error / denied phase or runFailed). */
  reason?: string;
  /** Execute child's session id, set on the terminal `done` event. */
  runSessionId?: string;
}

type RunStateMap = Record<number, WorkItemRunState | undefined>;

/** Phases that should show an active spinner. */
function isActivePhase(phase: RunPhase | undefined): boolean {
  return phase === "planning" || phase === "executing";
}

/** True while the run is in flight (no terminal phase reached yet). */
function isRunInFlight(run: WorkItemRunState | undefined): boolean {
  if (!run) return false;
  if (run.phase === "done" || run.phase === "denied" || run.phase === "error") return false;
  return run.busy || run.phase !== undefined;
}

/**
 * Subscribe to the four host run channels in ONE effect with a single cleanup.
 * Returns the per-item run state map plus a `runItem` launcher. The launcher
 * optimistically seeds `busy` so the card shows a starting indicator instantly,
 * even before the `runStarted` broadcast lands.
 */
function useWorkBoardRun(api: LvisApi): {
  runState: RunStateMap;
  runItem: (id: number) => void;
} {
  const [runState, setRunState] = useState<RunStateMap>({});
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const patch = useCallback((id: number, next: Partial<WorkItemRunState>) => {
    if (!mountedRef.current) return;
    setRunState((prev) => {
      const cur = prev[id] ?? { busy: false };
      return { ...prev, [id]: { ...cur, ...next } };
    });
  }, []);

  useEffect(() => {
    const unsubs: Array<() => void> = [];
    if (typeof api.onWorkBoardRunProgress === "function") {
      unsubs.push(
        api.onWorkBoardRunProgress((ev: RunProgressEventPayload) => {
          patch(ev.itemId, {
            phase: ev.phase,
            // Only active phases carry live turn text; clear it on transition.
            liveText: ev.phase === "planning" || ev.phase === "executing" ? ev.text : undefined,
            reason: ev.phase === "error" || ev.phase === "denied" ? ev.message : undefined,
            runSessionId: ev.runSessionId,
            // A terminal phase ends the in-flight window even if runFinished is late.
            busy: ev.phase !== "done" && ev.phase !== "denied" && ev.phase !== "error",
          });
        }),
      );
    }
    if (typeof api.onWorkBoardRunStarted === "function") {
      unsubs.push(
        api.onWorkBoardRunStarted(({ itemId }) => {
          patch(itemId, { busy: true, phase: undefined, liveText: undefined, reason: undefined });
        }),
      );
    }
    if (typeof api.onWorkBoardRunFinished === "function") {
      unsubs.push(
        api.onWorkBoardRunFinished(({ itemId, status }) => {
          patch(itemId, {
            busy: false,
            phase: status === "completed" ? "done" : status === "denied" ? "denied" : status === "error" ? "error" : undefined,
          });
        }),
      );
    }
    if (typeof api.onWorkBoardRunFailed === "function") {
      unsubs.push(
        api.onWorkBoardRunFailed(({ itemId, reason }) => {
          patch(itemId, { busy: false, phase: "error", reason });
        }),
      );
    }
    return () => {
      for (const u of unsubs) u();
    };
  }, [api, patch]);

  const runItem = useCallback(
    (id: number) => {
      if (typeof api.runWorkBoardItem !== "function") return;
      // Optimistic: show a starting indicator before runStarted lands.
      patch(id, { busy: true, phase: undefined, liveText: undefined, reason: undefined, runSessionId: undefined });
      void api.runWorkBoardItem(id).then((result) => {
        if (!mountedRef.current) return;
        if (result && "ok" in result && result.ok === false) {
          patch(id, { busy: false, phase: "error", reason: result.error });
          return;
        }
        if (result && "status" in result) {
          patch(id, {
            busy: false,
            phase:
              result.status === "completed"
                ? "done"
                : result.status === "denied"
                  ? "denied"
                  : result.status === "error" || result.status === "not_found"
                    ? "error"
                    : undefined,
            reason: result.reason,
            runSessionId: result.runSessionId,
          });
        }
      }).catch((err: unknown) => {
        if (!mountedRef.current) return;
        patch(id, { busy: false, phase: "error", reason: (err as Error).message });
      });
    },
    [api, patch],
  );

  return { runState, runItem };
}

// ─── Run indicator (live phase badge + spinner) ────────────────────────────────

function RunIndicator({ run }: { run: WorkItemRunState | undefined }) {
  if (!run) return null;
  const inFlight = isRunInFlight(run);
  const phase = run.phase;

  // Terminal states — only render error/denied; `done` is reflected by the
  // item's stored output in the detail modal, not a persistent card badge.
  if (!inFlight) {
    if (phase === "denied") {
      return (
        <span
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium border border-destructive/40 bg-destructive/10 text-destructive"
          data-testid="work-board-run-denied"
        >
          <XCircle className="h-3 w-3" />
          {t("workBoard.runDenied")}
        </span>
      );
    }
    if (phase === "error") {
      return (
        <span
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium border border-destructive/40 bg-destructive/10 text-destructive"
          title={run.reason}
          data-testid="work-board-run-error"
        >
          <AlertTriangle className="h-3 w-3" />
          {t("workBoard.runError")}
        </span>
      );
    }
    return null;
  }

  const label =
    phase === "planning"
      ? t("workBoard.runPlanning")
      : phase === "awaiting_approval"
        ? t("workBoard.runAwaitingApproval")
        : phase === "executing"
          ? t("workBoard.runExecuting")
          : t("workBoard.runStartingLabel");

  // `awaiting_approval` uses the accent (primary) token with a ring so it reads
  // as "needs you" without reaching for a raw palette color (theme-token rule).
  // The standard host ApprovalGate dialog renders the actual approve/reject; the
  // label here points the user at that surfaced prompt.
  const awaiting = phase === "awaiting_approval";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium border border-primary/40 bg-primary/10 text-primary ${
        awaiting ? "ring-1 ring-primary/40" : ""
      }`}
      data-testid="work-board-run-indicator"
      data-phase={phase ?? "starting"}
    >
      {awaiting ? (
        <CheckCircle2 className="h-3 w-3" />
      ) : (
        <Loader2 className="h-3 w-3 animate-spin" />
      )}
      {label}
    </span>
  );
}

// ─── Card for a single work item ──────────────────────────────────────────────

interface WorkItemCardProps {
  item: WorkItemResolved;
  run: WorkItemRunState | undefined;
  onStart: (id: number) => void;
  onComplete: (id: number) => void;
  onReopen: (id: number) => void;
  onRun: (id: number) => void;
  onOpenDetail: (id: number) => void;
}

function WorkItemCard({ item, run, onStart, onComplete, onReopen, onRun, onOpenDetail }: WorkItemCardProps) {
  const overdue = item.status_resolved === "overdue";
  const isCompleted = item.status === "completed";
  const busy = isRunInFlight(run);
  return (
    <button
      type="button"
      className={`w-full rounded-lg border bg-background p-3 text-left shadow-sm transition-all hover:border-border hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        overdue ? "border-destructive/50 bg-destructive/5" : "border-border/60"
      }`}
      data-testid="work-board-card"
      onClick={() => onOpenDetail(item.id)}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <PriorityChip priority={item.priority} />
            <span className={`truncate text-sm font-semibold leading-snug ${isCompleted ? "text-muted-foreground line-through" : "text-foreground"}`}>
              {item.title}
            </span>
          </div>
          {item.detail && (
            <p className="mt-1.5 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">{item.detail}</p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {overdue && (
              <Badge variant="outline" className="border-destructive/50 text-destructive">
                {t("workBoard.overdueBadge")}
              </Badge>
            )}
            <span className="text-[11px] text-muted-foreground">{formatDue(item.due_at)}</span>
            <RunIndicator run={run} />
          </div>
        </div>
      </div>
      {/* Inline lifecycle actions. stopPropagation so the card's open-detail
          click does not also fire when the user only wanted to transition. */}
      <div className="mt-2.5 flex justify-end gap-1">
        {!isCompleted && (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[11px]"
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation();
              onRun(item.id);
            }}
            data-testid="work-board-run"
          >
            {busy ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            ) : (
              <Play className="mr-1 h-3 w-3" />
            )}
            {busy ? t("workBoard.runBusyShort") : t("workBoard.runButton")}
          </Button>
        )}
        {item.status === "planned" && (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[11px]"
            onClick={(e) => {
              e.stopPropagation();
              onStart(item.id);
            }}
            data-testid="work-board-start"
          >
            {t("workBoard.startButton")}
          </Button>
        )}
        {(item.status === "planned" || item.status === "in_progress") && (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[11px]"
            onClick={(e) => {
              e.stopPropagation();
              onComplete(item.id);
            }}
            data-testid="work-board-complete"
          >
            {t("workBoard.completeButton")}
          </Button>
        )}
        {item.status === "completed" && (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[11px]"
            onClick={(e) => {
              e.stopPropagation();
              onReopen(item.id);
            }}
            data-testid="work-board-reopen"
          >
            {t("workBoard.reopenButton")}
          </Button>
        )}
      </div>
    </button>
  );
}

// ─── A single kanban column ────────────────────────────────────────────────────

interface BoardColumnProps {
  heading: string;
  items: WorkItemResolved[];
  runState: RunStateMap;
  emptyLabel: string;
  loading: boolean;
  onStart: (id: number) => void;
  onComplete: (id: number) => void;
  onReopen: (id: number) => void;
  onRun: (id: number) => void;
  onOpenDetail: (id: number) => void;
  testId: string;
}

function BoardColumn({
  heading,
  items,
  runState,
  emptyLabel,
  loading,
  onStart,
  onComplete,
  onReopen,
  onRun,
  onOpenDetail,
  testId,
}: BoardColumnProps) {
  return (
    <section className="flex min-h-0 flex-col gap-2 rounded-lg border bg-muted/20 shadow-sm" data-testid={testId}>
      <div className="flex items-center justify-between rounded-t-lg border-b bg-muted/40 px-3 py-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{heading}</h3>
        <span className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-muted px-1.5 text-[10px] font-semibold text-muted-foreground">
          {items.length}
        </span>
      </div>
      <ScrollArea className="min-h-[200px] flex-1 px-2 pb-2">
        {loading ? (
          <div className="py-8 text-center text-sm text-muted-foreground">{t("workBoard.loadingLabel")}</div>
        ) : items.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">{emptyLabel}</div>
        ) : (
          <div className="space-y-2">
            {items.map((item) => (
              <WorkItemCard
                key={item.id}
                item={item}
                run={runState[item.id]}
                onStart={onStart}
                onComplete={onComplete}
                onReopen={onReopen}
                onRun={onRun}
                onOpenDetail={onOpenDetail}
              />
            ))}
          </div>
        )}
      </ScrollArea>
    </section>
  );
}

// ─── Priority picker (shared by create + detail dialogs) ───────────────────────

function PriorityPicker({
  value,
  onChange,
  disabled,
}: {
  value: WorkItemPriority;
  onChange: (p: WorkItemPriority) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex gap-1" role="radiogroup" aria-label={t("workBoard.priorityLabel")}>
      {PRIORITY_OPTIONS.map((opt) => {
        const active = opt === value;
        return (
          <button
            key={opt}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(opt)}
            className={`flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors disabled:opacity-50 ${
              active ? "border-primary bg-primary/10 font-medium" : "text-muted-foreground hover:bg-muted/60"
            }`}
            data-testid={`work-board-priority-${opt}`}
          >
            <PriorityChip priority={opt} />
            <span>{t(`workBoard.${PRIORITY_FULL_LABEL[opt]}`)}</span>
          </button>
        );
      })}
    </div>
  );
}

// ─── Create dialog ─────────────────────────────────────────────────────────────

interface CreateDialogProps {
  api: LvisApi;
  onClose: () => void;
  onCreated: () => void;
}

function defaultDueIso(): string {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  return kstYmd(d);
}

export function WorkItemCreateDialog({ api, onClose, onCreated }: CreateDialogProps) {
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [dueDate, setDueDate] = useState(defaultDueIso());
  const [noDeadline, setNoDeadline] = useState(false);
  const [priority, setPriority] = useState<WorkItemPriority>(DEFAULT_PRIORITY);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async () => {
    const titleTrimmed = title.trim();
    if (!titleTrimmed) {
      setError(t("workBoard.errorTitleRequired"));
      return;
    }
    const input: WorkItemCreateInput = { title: titleTrimmed };
    if (detail.trim()) input.detail = detail.trim();
    // KST-anchored midnight so the store's due_at matches the calendar day the
    // user picked, independent of OS timezone.
    if (!noDeadline && dueDate) input.due_at = `${dueDate}T00:00:00+09:00`;
    if (priority !== DEFAULT_PRIORITY) input.priority = priority;

    setSubmitting(true);
    setError("");
    try {
      const result = await api.addWorkBoardItem(input);
      if ("status" in result && result.status === "created") {
        onCreated();
        onClose();
      } else {
        const reason = "reason" in result ? result.reason : "error" in result ? result.error : undefined;
        setError(reason ?? t("workBoard.errorAddFailed"));
      }
    } catch (err) {
      setError((err as Error).message ?? t("workBoard.errorAddFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent size="md" data-testid="work-board-create-dialog">
        <DialogHeader className="flex flex-row items-center justify-between space-y-0">
          <DialogTitle className="text-base">{t("workBoard.createTitle")}</DialogTitle>
          <DialogClose asChild>
            <Button size="sm" variant="ghost" className="-mr-2 h-7 w-7 p-0" aria-label={t("workBoard.closeAriaLabel")}>✕</Button>
          </DialogClose>
        </DialogHeader>

        <div className="space-y-3">
          <Label className="space-y-1">
            <div className="text-xs font-medium text-muted-foreground">{t("workBoard.titleRequiredLabel")}</div>
            <Input
              value={title}
              maxLength={TITLE_MAX}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("workBoard.titlePlaceholder")}
              data-testid="work-board-create-title"
              autoFocus
            />
          </Label>
          <Label className="space-y-1">
            <div className="text-xs font-medium text-muted-foreground">{t("workBoard.detailFieldLabel")}</div>
            <Textarea
              value={detail}
              maxLength={DESCRIPTION_MAX}
              onChange={(e) => setDetail(e.target.value)}
              rows={3}
              data-testid="work-board-create-detail"
            />
          </Label>
          <div className="grid gap-3 sm:grid-cols-2">
            <Label className="space-y-1">
              <div className="text-xs font-medium text-muted-foreground">{t("workBoard.dueDateLabel")}</div>
              <Input
                type="date"
                value={dueDate}
                disabled={noDeadline}
                onChange={(e) => setDueDate(e.target.value)}
                data-testid="work-board-create-due"
              />
            </Label>
            <Label className="flex items-end gap-2 pb-1.5 text-xs">
              <Checkbox
                checked={noDeadline}
                onCheckedChange={(c) => setNoDeadline(c === true)}
                data-testid="work-board-create-no-deadline"
              />
              <span>{t("workBoard.noDeadlineLabel")}</span>
            </Label>
          </div>
          <Label className="space-y-1">
            <div className="text-xs font-medium text-muted-foreground">{t("workBoard.priorityLabel")}</div>
            <PriorityPicker value={priority} onChange={setPriority} disabled={submitting} />
          </Label>
          <p className="text-[11px] text-muted-foreground">{t("workBoard.createHint")}</p>
          {error && <p className="text-sm text-destructive" data-testid="work-board-create-error">{error}</p>}
        </div>

        <DialogFooter>
          <Button size="sm" variant="outline" onClick={onClose}>{t("workBoard.cancelButton")}</Button>
          <Button
            size="sm"
            disabled={submitting || !title.trim()}
            onClick={() => void handleSubmit()}
            data-testid="work-board-create-submit"
          >
            {submitting ? t("workBoard.submittingLabel") : t("workBoard.submitButton")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Detail dialog ─────────────────────────────────────────────────────────────

interface DetailDialogProps {
  api: LvisApi;
  itemId: number;
  run: WorkItemRunState | undefined;
  onClose: () => void;
  onChanged: () => void;
  onRun: (id: number) => void;
}

// ─── Run output panel (live + persisted plan/result) ───────────────────────────
//
// Renders the captured plan + execution result. Source precedence: the live run
// state's terminal session id / liveText (current run) layered over the item's
// persisted `plan` / `output` fields (last completed run). A monospace,
// scrollable block keeps long agent output readable inside the modal.

function RunOutputPanel({
  item,
  run,
}: {
  item: WorkItemResolved;
  run: WorkItemRunState | undefined;
}) {
  const inFlight = isRunInFlight(run);
  const plan = item.plan;
  const output = item.output;
  const liveText = inFlight && isActivePhase(run?.phase) ? run?.liveText : undefined;
  const sessionId = run?.runSessionId ?? item.runSessionId;

  // Nothing to show: never run AND no live activity.
  if (!plan && !output && !liveText && !run) return null;

  return (
    <div className="space-y-2 rounded-md border bg-muted/20 p-2.5" data-testid="work-board-run-output">
      <div className="flex items-center justify-between">
        <RunIndicator run={run} />
        {sessionId && (
          <span className="text-[10px] text-muted-foreground" title={sessionId}>
            {t("workBoard.runSessionLabel", { id: sessionId.slice(0, 8) })}
          </span>
        )}
      </div>
      {liveText && (
        <div data-testid="work-board-run-live">
          <div className="text-[11px] font-medium text-muted-foreground">{t("workBoard.runLiveHeading")}</div>
          <div className="mt-1 max-h-32 overflow-auto rounded bg-background/60 p-3">
            <div className="prose prose-sm lvis-prose max-w-none break-words [overflow-wrap:anywhere]">
              <ReactMarkdown remarkPlugins={MARKDOWN_REMARK_PLUGINS}>{liveText}</ReactMarkdown>
            </div>
          </div>
        </div>
      )}
      {plan && (
        <div data-testid="work-board-run-plan">
          <div className="text-[11px] font-medium text-muted-foreground">{t("workBoard.runPlanHeading")}</div>
          <div className="mt-1 max-h-48 overflow-auto rounded bg-background/60 p-3">
            <div className="prose prose-sm lvis-prose max-w-none break-words [overflow-wrap:anywhere]">
              <ReactMarkdown remarkPlugins={MARKDOWN_REMARK_PLUGINS}>{plan}</ReactMarkdown>
            </div>
          </div>
        </div>
      )}
      {output && (
        <div data-testid="work-board-run-result">
          <div className="text-[11px] font-medium text-muted-foreground">{t("workBoard.runOutputHeading")}</div>
          <div className="mt-1 max-h-48 overflow-auto rounded bg-background/60 p-3">
            <div className="prose prose-sm lvis-prose max-w-none break-words [overflow-wrap:anywhere]">
              <ReactMarkdown remarkPlugins={MARKDOWN_REMARK_PLUGINS}>{output}</ReactMarkdown>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const STATUS_LABEL: Record<WorkItemResolved["status_resolved"], string> = {
  planned: "columnPlanned",
  in_progress: "columnInProgress",
  completed: "columnCompleted",
  overdue: "overdueBadge",
};

// ─── Run history (accumulated past runs + their transcripts) ────────────────
//
// `item.runHistory` is the board-persisted index (newest last); each entry's
// transcript (the plan+execute conversation) is fetched on demand from
// `sessions/<id>/<runId>.jsonl` via getWorkBoardRunTranscript. This makes the
// accumulation visible — re-runs add rows here instead of wiping prior work.
function RunHistorySection({ api, item }: { api: LvisApi; item: WorkItemResolved }) {
  const history = item.runHistory ?? [];
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [events, setEvents] = useState<RunTranscriptEvent[]>([]);
  const [loading, setLoading] = useState(false);
  if (history.length === 0) return null;

  const toggle = async (runId: string) => {
    if (openRun === runId) {
      setOpenRun(null);
      return;
    }
    setOpenRun(runId);
    setEvents([]);
    if (typeof api.getWorkBoardRunTranscript !== "function") return;
    setLoading(true);
    try {
      const r = await api.getWorkBoardRunTranscript(item.id, runId);
      if ("events" in r) setEvents(r.events);
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="rounded-lg border bg-muted/20 shadow-sm" data-testid="work-board-run-history">
      <div className="flex items-center justify-between rounded-t-lg border-b bg-muted/40 px-3 py-2">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t("workBoard.runHistoryHeading")}
        </h4>
        <span className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-muted px-1.5 text-[10px] font-semibold text-muted-foreground">
          {history.length}
        </span>
      </div>
      <ul className="space-y-1 p-2.5">
        {[...history].reverse().map((h) => (
          <li key={h.runId} className="text-[11px]">
            <button
              type="button"
              onClick={() => void toggle(h.runId)}
              className="flex w-full items-center justify-between gap-2 rounded px-1 py-0.5 text-left hover:bg-muted"
            >
              <span className="truncate">
                {t(`workBoard.run_${h.status}`)} · {isoToKstDate(h.startedAt)}
              </span>
              <span className="text-muted-foreground">{openRun === h.runId ? "▲" : "▼"}</span>
            </button>
            {openRun === h.runId && (
              <div className="mt-1 rounded bg-background/60 p-2">
                {loading ? (
                  <span className="text-muted-foreground">…</span>
                ) : events.length === 0 ? (
                  <span className="text-muted-foreground">{t("workBoard.runHistoryEmpty")}</span>
                ) : (
                  <div className="max-h-48 overflow-auto">
                    <div className="prose prose-sm lvis-prose max-w-none break-words [overflow-wrap:anywhere]">
                      <ReactMarkdown remarkPlugins={MARKDOWN_REMARK_PLUGINS}>
                        {events
                          .map((e) => `[${e.phase}${e.turn ? `#${e.turn}` : ""}] ${e.text ?? e.message ?? ""}`)
                          .join("\n\n")}
                      </ReactMarkdown>
                    </div>
                  </div>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function WorkItemDetailDialog({ api, itemId, run, onClose, onChanged, onRun }: DetailDialogProps) {
  const [item, setItem] = useState<WorkItemResolved | null>(null);
  const [loadError, setLoadError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [noDeadline, setNoDeadline] = useState(false);
  const [priority, setPriority] = useState<WorkItemPriority>(DEFAULT_PRIORITY);

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setItem(null);
    setLoadError("");
    setActionError("");
    void (async () => {
      try {
        const result = await api.getWorkBoardItem(itemId);
        if (cancelled) return;
        if ("status" in result && result.status === "found") {
          const it = result.item;
          setItem(it);
          setTitle(it.title);
          setDetail(it.detail ?? "");
          const due = isoToKstDate(it.due_at);
          setDueDate(due);
          setNoDeadline(!it.due_at);
          setPriority(it.priority);
        } else {
          const reason = "error" in result ? result.error : undefined;
          setLoadError(reason ?? t("workBoard.errorLoadFailed"));
        }
      } catch (err) {
        if (cancelled) return;
        setLoadError((err as Error).message ?? t("workBoard.errorLoadFailed"));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, itemId, reloadKey]);

  // When the in-flight run reaches a terminal phase, re-fetch so the persisted
  // `plan` / `output` / `runSessionId` written by the engine land in the item.
  const terminalPhase =
    run?.phase === "done" || run?.phase === "denied" || run?.phase === "error";
  useEffect(() => {
    if (terminalPhase) setReloadKey((k) => k + 1);
  }, [terminalPhase]);

  const dirty = useMemo(() => {
    if (!item) return false;
    if (title.trim() !== item.title.trim()) return true;
    if ((detail.trim() || "") !== (item.detail?.trim() ?? "")) return true;
    if (noDeadline !== !item.due_at) return true;
    if (!noDeadline && dueDate !== isoToKstDate(item.due_at)) return true;
    if (priority !== item.priority) return true;
    return false;
  }, [item, title, detail, dueDate, noDeadline, priority]);

  const canSave = !!item && dirty && title.trim().length > 0 && !busy;

  const handleSave = async () => {
    if (!item || !canSave) return;
    const patch: WorkItemUpdateInput = {};
    const titleTrimmed = title.trim();
    if (titleTrimmed !== item.title.trim()) patch.title = titleTrimmed;
    const newDetail = detail.trim();
    const oldDetail = item.detail?.trim() ?? "";
    if (newDetail !== oldDetail) patch.detail = newDetail ? newDetail : null;
    const origNoDeadline = !item.due_at;
    if (noDeadline !== origNoDeadline || (!noDeadline && isoToKstDate(item.due_at) !== dueDate)) {
      patch.due_at = noDeadline || !dueDate ? null : `${dueDate}T00:00:00+09:00`;
    }
    if (priority !== item.priority) patch.priority = priority;

    setBusy(true);
    setActionError("");
    try {
      const result = await api.updateWorkBoardItem(item.id, patch);
      if ("status" in result && result.status === "updated") {
        onChanged();
        onClose();
      } else {
        const reason = "reason" in result ? result.reason : "error" in result ? result.error : undefined;
        setActionError(reason ?? t("workBoard.errorSaveFailed"));
      }
    } catch (err) {
      setActionError((err as Error).message ?? t("workBoard.errorSaveFailed"));
    } finally {
      setBusy(false);
    }
  };

  const runLifecycle = async (op: "complete" | "reopen" | "delete") => {
    if (!item) return;
    setBusy(true);
    setActionError("");
    try {
      const result =
        op === "complete"
          ? await api.completeWorkBoardItem(item.id)
          : op === "reopen"
            ? await api.reopenWorkBoardItem(item.id)
            : await api.removeWorkBoardItem(item.id);
      const ok =
        "status" in result &&
        (result.status === "completed" || result.status === "reopened" || result.status === "deleted");
      if (ok) {
        onChanged();
        onClose();
      } else {
        const reason = "reason" in result ? result.reason : "error" in result ? result.error : undefined;
        setActionError(reason ?? t("workBoard.errorSaveFailed"));
      }
    } catch (err) {
      setActionError((err as Error).message ?? t("workBoard.errorSaveFailed"));
    } finally {
      setBusy(false);
    }
  };

  const isCompleted = item?.status === "completed";

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent size="md" data-testid="work-board-detail-dialog">
        <DialogHeader className="flex flex-row items-center justify-between space-y-0">
          <DialogTitle className="text-base">{t("workBoard.detailTitle")}</DialogTitle>
          <DialogClose asChild>
            <Button size="sm" variant="ghost" className="-mr-2 h-7 w-7 p-0" aria-label={t("workBoard.closeAriaLabel")}>✕</Button>
          </DialogClose>
        </DialogHeader>

        {loadError ? (
          <p className="text-sm text-destructive" data-testid="work-board-detail-load-error">{loadError}</p>
        ) : !item ? (
          <div className="py-8 text-center text-sm text-muted-foreground" data-testid="work-board-detail-loading">
            {t("workBoard.loadingLabel")}
          </div>
        ) : (
          <div className="space-y-3">
            <Label className="space-y-1">
              <div className="text-xs font-medium text-muted-foreground">{t("workBoard.titleLabel")}</div>
              <Input
                value={title}
                maxLength={TITLE_MAX}
                disabled={busy}
                onChange={(e) => setTitle(e.target.value)}
                data-testid="work-board-detail-title"
              />
            </Label>
            <Label className="space-y-1">
              <div className="text-xs font-medium text-muted-foreground">{t("workBoard.detailFieldLabel")}</div>
              <Textarea
                value={detail}
                maxLength={DESCRIPTION_MAX}
                disabled={busy}
                onChange={(e) => setDetail(e.target.value)}
                rows={3}
                data-testid="work-board-detail-detail"
              />
            </Label>
            <div className="grid gap-3 sm:grid-cols-2">
              <Label className="space-y-1">
                <div className="text-xs font-medium text-muted-foreground">{t("workBoard.dueDateLabel")}</div>
                <Input
                  type="date"
                  value={dueDate}
                  disabled={busy || noDeadline}
                  onChange={(e) => setDueDate(e.target.value)}
                  data-testid="work-board-detail-due"
                />
              </Label>
              <Label className="flex items-end gap-2 pb-1.5 text-xs">
                <Checkbox
                  checked={noDeadline}
                  disabled={busy}
                  onCheckedChange={(c) => setNoDeadline(c === true)}
                  data-testid="work-board-detail-no-deadline"
                />
                <span>{t("workBoard.noDeadlineLabel")}</span>
              </Label>
            </div>
            <Label className="space-y-1">
              <div className="text-xs font-medium text-muted-foreground">{t("workBoard.priorityLabel")}</div>
              <PriorityPicker value={priority} onChange={setPriority} disabled={busy} />
            </Label>
            <div className="flex flex-wrap items-center justify-between gap-1 text-[11px] text-muted-foreground">
              <span>
                {t("workBoard.statusLabel")}: <strong>{t(`workBoard.${STATUS_LABEL[item.status_resolved]}`)}</strong>
              </span>
              <span>
                {t("workBoard.metaCreated", { date: isoToKstDate(item.created_at) })} ·{" "}
                {t("workBoard.metaUpdated", { date: isoToKstDate(item.updated_at) })}
              </span>
            </div>
            {actionError && <p className="text-sm text-destructive" data-testid="work-board-detail-error">{actionError}</p>}
            <RunOutputPanel item={item} run={run} />
            <RunHistorySection api={api} item={item} />
          </div>
        )}

        {item && (
          <DialogFooter className="sm:justify-between">
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive"
              disabled={busy}
              onClick={() => void runLifecycle("delete")}
              data-testid="work-board-detail-delete"
            >
              {t("workBoard.deleteButton")}
            </Button>
            <div className="flex gap-2">
              {!isCompleted && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || isRunInFlight(run)}
                  onClick={() => onRun(item.id)}
                  data-testid="work-board-detail-run"
                >
                  {isRunInFlight(run) ? (
                    <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                  ) : (
                    <Play className="mr-1 h-3 w-3" />
                  )}
                  {isRunInFlight(run) ? t("workBoard.runBusyShort") : t("workBoard.runButton")}
                </Button>
              )}
              <Button size="sm" variant="outline" disabled={busy} onClick={onClose}>
                {t("workBoard.cancelButton")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void runLifecycle(isCompleted ? "reopen" : "complete")}
                data-testid="work-board-detail-toggle"
              >
                {isCompleted ? t("workBoard.reopenButton") : t("workBoard.completeButton")}
              </Button>
              <Button
                size="sm"
                disabled={!canSave}
                onClick={() => void handleSave()}
                data-testid="work-board-detail-save"
              >
                {busy ? t("workBoard.submittingLabel") : t("workBoard.saveButton")}
              </Button>
            </div>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Reports section (daily / weekly generation) ───────────────────────────────
//
// Generates a personal work report on demand: the daily / weekly buttons call
// the `generate-report` IPC channel, which drives the host-native reporter
// (board state + activity log + learned memory → LLM → markdown). The returned
// markdown renders in a scrollable monospace block (mirroring the run-output
// panel). `empty` (no activity) and `error` (LLM failure / no reporter) both
// surface as a single discriminated result so the user always gets feedback.

function ReportsSection({ api }: { api: LvisApi }) {
  const [generating, setGenerating] = useState<"daily" | "weekly" | null>(null);
  const [result, setResult] = useState<
    WorkBoardReportResult | { ok: false; error: string } | null
  >(null);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const run = useCallback(
    async (kind: "daily" | "weekly") => {
      if (typeof api.generateWorkBoardReport !== "function") return;
      setGenerating(kind);
      setResult(null);
      try {
        const r = await api.generateWorkBoardReport(kind);
        if (mountedRef.current) setResult(r);
      } finally {
        if (mountedRef.current) setGenerating(null);
      }
    },
    [api],
  );

  return (
    <section className="rounded-lg border bg-muted/20 shadow-sm" data-testid="work-board-reports">
      <div className="flex items-center justify-between rounded-t-lg border-b bg-muted/40 px-4 py-2.5">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t("workBoard.reportsHeading")}</h3>
      </div>
      <div className="p-4">
      <p className="text-[11px] text-muted-foreground">{t("workBoard.reportPlaceholder")}</p>
      <div className="mt-3 flex gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={generating !== null}
          onClick={() => void run("daily")}
          data-testid="work-board-report-daily"
        >
          {generating === "daily" && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
          {t("workBoard.reportDaily")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={generating !== null}
          onClick={() => void run("weekly")}
          data-testid="work-board-report-weekly"
        >
          {generating === "weekly" && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
          {t("workBoard.reportWeekly")}
        </Button>
      </div>
      {result && <ReportResultBlock result={result} onClose={() => setResult(null)} />}
      </div>
    </section>
  );
}

// Render the discriminated report result: `ok` → period heading + markdown,
// `empty` → muted reason, `error` / `{ok:false}` → destructive reason.
function ReportResultBlock({
  result,
  onClose,
}: {
  result: WorkBoardReportResult | { ok: false; error: string };
  onClose: () => void;
}) {
  if ("ok" in result) {
    return (
      <p className="mt-2 text-[11px] text-destructive" data-testid="work-board-report-error">
        {t("workBoard.reportFailed")}: {result.error}
      </p>
    );
  }
  if (result.status === "error") {
    return (
      <p className="mt-2 text-[11px] text-destructive" data-testid="work-board-report-error">
        {t("workBoard.reportFailed")}: {result.reason}
      </p>
    );
  }
  if (result.status === "empty") {
    return (
      <p className="mt-2 text-[11px] text-muted-foreground" data-testid="work-board-report-empty">
        {result.reason}
      </p>
    );
  }
  return (
    <div className="mt-2 space-y-1" data-testid="work-board-report-result">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-muted-foreground">
          {t("workBoard.reportResultHeading")} · {result.period}
        </span>
        <Button size="sm" variant="ghost" className="h-5 px-1 text-[11px]" onClick={onClose}>
          {t("workBoard.reportClose")}
        </Button>
      </div>
      <div className="max-h-48 overflow-auto rounded bg-background/60 p-3">
        <div className="prose prose-sm lvis-prose max-w-none break-words [overflow-wrap:anywhere]">
          <ReactMarkdown remarkPlugins={MARKDOWN_REMARK_PLUGINS}>{result.markdown}</ReactMarkdown>
        </div>
      </div>
    </div>
  );
}

// ─── Main Panel ─────────────────────────────────────────────────────────────────

export function WorkBoardPanel({ api }: WorkBoardPanelProps) {
  const [items, setItems] = useState<WorkItemResolved[]>([]);
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const refresh = useCallback(async () => {
    if (typeof api.listWorkBoard !== "function") return;
    setLoading(true);
    try {
      const result = await api.listWorkBoard();
      if (!mountedRef.current) return;
      if ("status" in result && result.status === "ok") {
        setItems(result.items);
      } else {
        setItems([]);
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
    if (typeof api.onWorkBoardItemChanged !== "function") return undefined;
    const unsub = api.onWorkBoardItemChanged(() => {
      void refresh();
    });
    return unsub;
  }, [api, refresh]);

  const handleTransition = useCallback(
    async (id: number, to: WorkItemStatusStored) => {
      await api.transitionWorkBoardItem(id, to);
      await refresh();
    },
    [api, refresh],
  );

  const handleComplete = useCallback(
    async (id: number) => {
      await api.completeWorkBoardItem(id);
      await refresh();
    },
    [api, refresh],
  );

  const handleReopen = useCallback(
    async (id: number) => {
      await api.reopenWorkBoardItem(id);
      await refresh();
    },
    [api, refresh],
  );

  // Bucket by stored status. `overdue` is a projection over planned/in_progress
  // so those items stay in their lifecycle column with an overdue badge.
  const planned = useMemo(() => items.filter((i) => i.status === "planned"), [items]);
  const inProgress = useMemo(() => items.filter((i) => i.status === "in_progress"), [items]);
  const completed = useMemo(() => items.filter((i) => i.status === "completed"), [items]);

  const capReached = items.length >= MAX_ITEMS;

  // Agent-orchestration run state + launcher. Subscribes to the four host run
  // channels in a single effect (cleanup inside the hook).
  const { runState, runItem } = useWorkBoardRun(api);

  // A finished run may have written engine fields (plan/output/runStatus) onto
  // the item; re-list so the board view reflects the persisted run result.
  // The engine does NOT emit `itemChanged` for run-field writes (those are not
  // board-lifecycle mutations), so the run terminal markers drive this refresh.
  useEffect(() => {
    if (typeof api.onWorkBoardRunFinished !== "function") return undefined;
    const unsub = api.onWorkBoardRunFinished(() => {
      void refresh();
    });
    return unsub;
  }, [api, refresh]);

  const onStart = useCallback((id: number) => void handleTransition(id, "in_progress"), [handleTransition]);
  const onComplete = useCallback((id: number) => void handleComplete(id), [handleComplete]);
  const onReopen = useCallback((id: number) => void handleReopen(id), [handleReopen]);
  const onRun = useCallback((id: number) => runItem(id), [runItem]);
  const onOpenDetail = useCallback((id: number) => setDetailId(id), []);

  return (
    <>
      <Card
        className="mx-auto flex min-h-0 min-w-0 flex-1 w-full max-w-6xl flex-col overflow-hidden"
        data-testid="work-board-panel"
      >
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>{t("workBoard.panelTitle")}</CardTitle>
              <CardDescription>{t("workBoard.panelDescription")}</CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="outline" title={t("workBoard.panelTitle")}>
                {items.length}/{MAX_ITEMS}
              </Badge>
              {capReached && (
                <span className="text-xs text-destructive">{t("workBoard.capReachedLabel")}</span>
              )}
              <Button
                size="sm"
                variant="outline"
                disabled={capReached}
                onClick={() => setShowCreate(true)}
                data-testid="work-board-add"
              >
                {t("workBoard.addItemButton")}
              </Button>
              <Button size="sm" variant="outline" onClick={() => void refresh()}>
                {t("workBoard.refreshButton")}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
          <div className="grid min-h-0 gap-3 lg:grid-cols-3">
            <BoardColumn
              heading={t("workBoard.columnPlanned")}
              items={planned}
              runState={runState}
              emptyLabel={t("workBoard.emptyPlanned")}
              loading={loading}
              onStart={onStart}
              onComplete={onComplete}
              onReopen={onReopen}
              onRun={onRun}
              onOpenDetail={onOpenDetail}
              testId="work-board-column-planned"
            />
            <BoardColumn
              heading={t("workBoard.columnInProgress")}
              items={inProgress}
              runState={runState}
              emptyLabel={t("workBoard.emptyInProgress")}
              loading={loading}
              onStart={onStart}
              onComplete={onComplete}
              onReopen={onReopen}
              onRun={onRun}
              onOpenDetail={onOpenDetail}
              testId="work-board-column-in-progress"
            />
            <BoardColumn
              heading={t("workBoard.columnCompleted")}
              items={completed}
              runState={runState}
              emptyLabel={t("workBoard.emptyCompleted")}
              loading={loading}
              onStart={onStart}
              onComplete={onComplete}
              onReopen={onReopen}
              onRun={onRun}
              onOpenDetail={onOpenDetail}
              testId="work-board-column-completed"
            />
          </div>
          <div className="border-t pt-4">
            <ReportsSection api={api} />
          </div>
        </CardContent>
      </Card>

      {showCreate && (
        <WorkItemCreateDialog
          api={api}
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            void refresh();
          }}
        />
      )}
      {detailId !== null && (
        <WorkItemDetailDialog
          api={api}
          itemId={detailId}
          run={runState[detailId]}
          onClose={() => setDetailId(null)}
          onChanged={() => {
            setDetailId(null);
            void refresh();
          }}
          onRun={onRun}
        />
      )}
    </>
  );
}
