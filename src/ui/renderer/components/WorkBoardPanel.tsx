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
import { t } from "../../../i18n/runtime.js";
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

// ─── Card for a single work item ──────────────────────────────────────────────

interface WorkItemCardProps {
  item: WorkItemResolved;
  onStart: (id: number) => void;
  onComplete: (id: number) => void;
  onReopen: (id: number) => void;
  onOpenDetail: (id: number) => void;
}

function WorkItemCard({ item, onStart, onComplete, onReopen, onOpenDetail }: WorkItemCardProps) {
  const overdue = item.status_resolved === "overdue";
  const isCompleted = item.status === "completed";
  return (
    <button
      type="button"
      className={`w-full rounded-md border p-2.5 text-left transition hover:bg-muted/60 ${
        overdue ? "border-destructive/50 bg-destructive/5" : ""
      }`}
      data-testid="work-board-card"
      onClick={() => onOpenDetail(item.id)}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <PriorityChip priority={item.priority} />
            <span className={`truncate text-sm font-medium ${isCompleted ? "text-muted-foreground line-through" : ""}`}>
              {item.title}
            </span>
          </div>
          {item.detail && (
            <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">{item.detail}</p>
          )}
          <div className="mt-1.5 flex items-center gap-1.5">
            {overdue && (
              <Badge variant="outline" className="border-destructive/50 text-destructive">
                {t("workBoard.overdueBadge")}
              </Badge>
            )}
            <span className="text-[11px] text-muted-foreground">{formatDue(item.due_at)}</span>
          </div>
        </div>
      </div>
      {/* Inline lifecycle actions. stopPropagation so the card's open-detail
          click does not also fire when the user only wanted to transition. */}
      <div className="mt-2 flex justify-end gap-1">
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
  emptyLabel: string;
  loading: boolean;
  onStart: (id: number) => void;
  onComplete: (id: number) => void;
  onReopen: (id: number) => void;
  onOpenDetail: (id: number) => void;
  testId: string;
}

function BoardColumn({
  heading,
  items,
  emptyLabel,
  loading,
  onStart,
  onComplete,
  onReopen,
  onOpenDetail,
  testId,
}: BoardColumnProps) {
  return (
    <section className="flex min-h-0 flex-col gap-2 rounded-md border bg-muted/20 p-2" data-testid={testId}>
      <div className="flex items-center justify-between px-1">
        <h3 className="text-sm font-medium">{heading}</h3>
        <span className="text-[11px] text-muted-foreground">
          {t("workBoard.itemCount", { count: String(items.length) })}
        </span>
      </div>
      <ScrollArea className="min-h-[200px] flex-1">
        {loading ? (
          <div className="py-8 text-center text-sm text-muted-foreground">{t("workBoard.loadingLabel")}</div>
        ) : items.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">{emptyLabel}</div>
        ) : (
          <div className="space-y-2 pr-2">
            {items.map((item) => (
              <WorkItemCard
                key={item.id}
                item={item}
                onStart={onStart}
                onComplete={onComplete}
                onReopen={onReopen}
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
  onClose: () => void;
  onChanged: () => void;
}

const STATUS_LABEL: Record<WorkItemResolved["status_resolved"], string> = {
  planned: "columnPlanned",
  in_progress: "columnInProgress",
  completed: "columnCompleted",
  overdue: "overdueBadge",
};

export function WorkItemDetailDialog({ api, itemId, onClose, onChanged }: DetailDialogProps) {
  const [item, setItem] = useState<WorkItemResolved | null>(null);
  const [loadError, setLoadError] = useState("");

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
  }, [api, itemId]);

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

// ─── Reports section (daily / weekly placeholders for P3) ──────────────────────

function ReportsSection({ api }: { api: LvisApi }) {
  const [busy, setBusy] = useState<"daily" | "weekly" | null>(null);

  const generate = async (kind: "daily" | "weekly") => {
    setBusy(kind);
    try {
      await api.generateWorkBoardReport({ kind });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="rounded-md border bg-muted/20 p-3" data-testid="work-board-reports">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">{t("workBoard.reportsHeading")}</h3>
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">{t("workBoard.reportPlaceholder")}</p>
      <div className="mt-2 flex gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy !== null}
          onClick={() => void generate("daily")}
          data-testid="work-board-report-daily"
        >
          {t("workBoard.reportDaily")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy !== null}
          onClick={() => void generate("weekly")}
          data-testid="work-board-report-weekly"
        >
          {t("workBoard.reportWeekly")}
        </Button>
      </div>
    </section>
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

  const onStart = useCallback((id: number) => void handleTransition(id, "in_progress"), [handleTransition]);
  const onComplete = useCallback((id: number) => void handleComplete(id), [handleComplete]);
  const onReopen = useCallback((id: number) => void handleReopen(id), [handleReopen]);
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
        <CardContent className="flex min-h-0 flex-1 flex-col gap-3">
          <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-3">
            <BoardColumn
              heading={t("workBoard.columnPlanned")}
              items={planned}
              emptyLabel={t("workBoard.emptyPlanned")}
              loading={loading}
              onStart={onStart}
              onComplete={onComplete}
              onReopen={onReopen}
              onOpenDetail={onOpenDetail}
              testId="work-board-column-planned"
            />
            <BoardColumn
              heading={t("workBoard.columnInProgress")}
              items={inProgress}
              emptyLabel={t("workBoard.emptyInProgress")}
              loading={loading}
              onStart={onStart}
              onComplete={onComplete}
              onReopen={onReopen}
              onOpenDetail={onOpenDetail}
              testId="work-board-column-in-progress"
            />
            <BoardColumn
              heading={t("workBoard.columnCompleted")}
              items={completed}
              emptyLabel={t("workBoard.emptyCompleted")}
              loading={loading}
              onStart={onStart}
              onComplete={onComplete}
              onReopen={onReopen}
              onOpenDetail={onOpenDetail}
              testId="work-board-column-completed"
            />
          </div>
          <ReportsSection api={api} />
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
          onClose={() => setDetailId(null)}
          onChanged={() => {
            setDetailId(null);
            void refresh();
          }}
        />
      )}
    </>
  );
}
