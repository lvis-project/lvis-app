/**
 * RoutinePanel v2 — unified routine management UI.
 *
 * Single list with execution mode badge per row, 3 input styles, and the
 * store-enforced persisted routine cap.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../../../i18n/runtime.js";
import { Badge } from "../../../components/ui/badge.js";
import { Button } from "../../../components/ui/button.js";
import { CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card.js";
import { Checkbox } from "../../../components/ui/checkbox.js";
import { Input } from "../../../components/ui/input.js";
import { Label } from "../../../components/ui/label.js";
import { NativeSelect, NativeSelectOption } from "../../../components/ui/native-select.js";
import { ScrollArea } from "../../../components/ui/scroll-area.js";
import { Textarea } from "../../../components/ui/textarea.js";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog.js";
import type { LvisApi, PluginCardSummary } from "../types.js";
import type { AddRoutineInput, RoutineRecord, RoutineExecution, RepeatKind, RoutineSchedule } from "../../../shared/routines-types.js";
import { MAX_PERSISTED_ROUTINES, MAX_LLM_SESSION_ROUTINES } from "../../../shared/routines-types.js";
import { isValidCronExpression } from "../../../routines/cron-evaluator.js";

export interface RoutinePanelProps {
  api: LvisApi;
  onOpenSession?: (sessionId: string) => void | boolean | Promise<void | boolean>;
}

// ─── Execution badge ─────────────────────────────────────────────────────────

function ExecutionBadge({ execution }: { execution: RoutineExecution }) {
  return (
    <Badge variant={execution === "llm-session" ? "default" : "outline"}>
      {execution === "llm-session" ? "LLM" : t("routinePanel.notificationBadge")}
    </Badge>
  );
}

// ─── Routine row ─────────────────────────────────────────────────────────────

interface RoutineRowProps {
  routine: RoutineRecord;
  onDismiss: (id: string) => void;
  onRemove: (id: string) => void;
  onTriggerNow: (id: string) => void;
  recentlyFired: boolean;
}

function describeSchedule(routine: RoutineRecord): string {
  const s = routine.schedule;
  if (!s) return routine.trigger === "shutdown" ? t("routinePanel.onShutdown") : t("routinePanel.noSchedule");
  const repeatKind = s.repeat?.kind;
  const atStr = s.at ? new Date(s.at).toLocaleString("ko-KR") : "";
  if (repeatKind === "cron") {
    const expr = (s.repeat as { kind: "cron"; expression: string }).expression;
    return t("routinePanel.cronSchedule", { expr });
  }
  if (repeatKind === "daily") return t("routinePanel.scheduleDaily", { atStr });
  if (repeatKind === "weekly") return t("routinePanel.scheduleWeekly", { atStr });
  if (repeatKind === "monthly") return t("routinePanel.scheduleMonthly", { atStr });
  if (repeatKind === "interval") {
    const ms = (s.repeat as { kind: "interval"; intervalMs: number }).intervalMs;
    const mins = Math.round(ms / 60000);
    return atStr
      ? t("routinePanel.scheduleIntervalWithNext", { mins: String(mins), atStr })
      : t("routinePanel.scheduleInterval", { mins: String(mins) });
  }
  return atStr || t("routinePanel.scheduleOnce");
}

function RoutineRow({ routine, onDismiss, onRemove, onTriggerNow, recentlyFired }: RoutineRowProps) {
  return (
    <div
      className={`rounded-lg border bg-background p-3 shadow-sm transition-shadow hover:shadow-md ${recentlyFired ? "border-warning/(--opacity-strong) bg-warning/(--opacity-subtle)" : ""}`}
      data-testid="routine-row"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold leading-snug text-foreground">{routine.title || routine.notificationTitle || routine.prePrompt?.slice(0, 30) || routine.id.slice(0, 8)}</span>
            <ExecutionBadge execution={routine.execution} />
          </div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            {describeSchedule(routine)}
          </div>
          {routine.prePrompt && (
            <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">
              {routine.prePrompt}
            </p>
          )}
          {routine.notificationBody && (
            <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">
              {routine.notificationBody}
            </p>
          )}
        </div>
        <div className="flex shrink-0 gap-1">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-[11px]"
            onClick={() => onTriggerNow(routine.id)}
          >
            {t("routinePanel.triggerNowButton")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-[11px]"
            onClick={() => onDismiss(routine.id)}
          >
            {t("routinePanel.dismissButton")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-[11px] text-destructive"
            onClick={() => onRemove(routine.id)}
          >
            {t("routinePanel.deleteButton")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function RoutineSessionRow({ session, onOpen }: { session: RoutineSessionListItem; onOpen: (sessionId: string) => void }) {
  return (
    <button
      type="button"
      className="w-full rounded-lg border bg-background px-3 py-2 text-left shadow-sm transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-testid="routine-session-row"
      onClick={() => onOpen(session.sessionId)}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold leading-snug text-foreground">{session.routineTitle}</div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            {formatSessionTime(session.firedAt)}
          </div>
          {session.preview && (
            <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
              {session.preview}
            </div>
          )}
        </div>
        <Badge variant="outline">{t("routinePanel.openSessionBadge")}</Badge>
      </div>
    </button>
  );
}

function formatSessionTime(firedAt: string): string {
  const parsed = new Date(firedAt);
  if (Number.isNaN(parsed.getTime())) return firedAt;
  return parsed.toLocaleString("ko-KR");
}

// ─── Add Routine Modal ────────────────────────────────────────────────────────

type InputTab = "form" | "cron" | "natural";

const REPEAT_OPTIONS: Array<{ value: RepeatKind; labelKey: string }> = [
  { value: "none", labelKey: "routinePanel.repeatNone" },
  { value: "daily", labelKey: "routinePanel.repeatDaily" },
  { value: "weekly", labelKey: "routinePanel.repeatWeekly" },
  { value: "monthly", labelKey: "routinePanel.repeatMonthly" },
  { value: "interval", labelKey: "routinePanel.repeatInterval" },
];

interface AddRoutineModalProps {
  api: LvisApi;
  onClose: () => void;
  onAdded: () => void;
}

// Exported for renderer tests — the modal owns the button → scope-payload
// mapping that we want to lock down (empty selection MUST
// map to `{ mode: "deny-all" }`, not "inherit" / "allow all").
export function AddRoutineModal({ api, onClose, onAdded }: AddRoutineModalProps) {
  const [tab, setTab] = useState<InputTab>("form");
  const [execution, setExecution] = useState<RoutineExecution>("llm-session");
  const [title, setTitle] = useState("");
  const [prePrompt, setPrePrompt] = useState("");
  const [notificationTitle, setNotificationTitle] = useState("");
  const [notificationBody, setNotificationBody] = useState("");
  const [pluginCards, setPluginCards] = useState<PluginCardSummary[]>([]);
  const [allowedPluginIds, setAllowedPluginIds] = useState<string[]>([]);
  const [pluginScopeError, setPluginScopeError] = useState("");

  // Form tab fields
  const [atDate, setAtDate] = useState("");
  const [atTime, setAtTime] = useState("09:00");
  const [repeatKind, setRepeatKind] = useState<RepeatKind>("none");
  const [intervalMinutes, setIntervalMinutes] = useState("60");

  // Cron tab
  const [cronExpression, setCronExpression] = useState("0 9 * * 1-5");
  const [cronError, setCronError] = useState("");

  // Natural language tab
  const [naturalInput, setNaturalInput] = useState("");
  const [naturalParsing, setNaturalParsing] = useState(false);
  const [naturalError, setNaturalError] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    api.listPluginCards()
      .then((cards) => {
        if (cancelled) return;
        setPluginCards(
          cards
            .filter((card) => card.loadStatus === "loaded" && card.tools.length > 0)
            .sort((a, b) => a.name.localeCompare(b.name)),
        );
        setPluginScopeError("");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setPluginScopeError(message || t("routinePanel.errorLoadPlugins"));
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const toggleAllowedPlugin = (pluginId: string) => {
    setAllowedPluginIds((prev) => (
      prev.includes(pluginId)
        ? prev.filter((id) => id !== pluginId)
        : [...prev, pluginId]
    ));
  };

  const buildSchedulePayload = (): Record<string, unknown> | null => {
    if (tab === "form") {
      if (!atDate) return null;
      // ISO normalize: local datetime string → UTC ISO string before IPC.
      const localDateTimeStr = `${atDate}T${atTime}:00`;
      const parsed = new Date(localDateTimeStr);
      if (Number.isNaN(parsed.getTime())) return null;
      const at = parsed.toISOString();
      const repeat: Record<string, unknown> = { kind: repeatKind };
      if (repeatKind === "interval") {
        const ms = Number.parseInt(intervalMinutes, 10) * 60_000;
        if (!Number.isFinite(ms) || ms <= 0) return null;
        repeat.intervalMs = ms;
      }
      return { at, repeat };
    }
    if (tab === "cron") {
      const expr = cronExpression.trim();
      if (!expr) return null;
      // Client-side cron validation — reject invalid expressions before IPC.
      if (!isValidCronExpression(expr)) return null;
      return { repeat: { kind: "cron", expression: expr } };
    }
    return null;
  };

  const handleSubmit = async () => {
    if (tab === "natural") {
      // Natural language tab has its own submit button; this branch is unreachable
      // from the main submit button (which is hidden for tab === "natural").
      return;
    }

    // Cron-specific inline error before generic schedule check.
    if (tab === "cron") {
      const expr = cronExpression.trim();
      if (!expr || !isValidCronExpression(expr)) {
        setCronError(t("routinePanel.errorInvalidCron"));
        return;
      }
      setCronError("");
    }

    const schedule = buildSchedulePayload();
    if (!schedule) {
      setError(t("routinePanel.errorInvalidSchedule"));
      return;
    }

    if (execution === "llm-session" && !prePrompt.trim()) {
      setError(t("routinePanel.errorPromptRequired"));
      return;
    }

    if (execution === "notification-only" && !notificationTitle.trim()) {
      setError(t("routinePanel.errorNotificationTitleRequired"));
      return;
    }

    const input: AddRoutineInput = {
      trigger: "schedule",
      execution,
      schedule: schedule as RoutineSchedule,
      ...(title.trim() ? { title: title.trim() } : {}),
      ...(execution === "llm-session"
        ? {
            prePrompt: prePrompt.trim(),
            // Permission policy Layer 4 — RoutinePanel always emits an explicit scope:
            // empty plugin selection = deny-all (matches the panel's
            // "허용 안 함" semantic); non-empty = explicit allow-list.
            scope: {
              pluginIds:
                allowedPluginIds.length > 0
                  ? { mode: "allow", ids: allowedPluginIds }
                  : { mode: "deny-all" },
              forcedPluginIds: [],
              directories: [],
            },
          }
        : {
            ...(notificationTitle.trim() ? { notificationTitle: notificationTitle.trim() } : {}),
            ...(notificationBody.trim() ? { notificationBody: notificationBody.trim() } : {}),
          }),
    };

    setSubmitting(true);
    setError("");
    try {
      const result = await api.addRoutineV2(input);
      if (result.ok) {
        onAdded();
        onClose();
      } else {
        setError(result.error ?? t("routinePanel.errorAddRoutineFailed"));
      }
    } catch (err) {
      setError((err as Error).message ?? t("routinePanel.errorAddRoutineFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  const handleNaturalLanguageParse = async () => {
    if (!naturalInput.trim()) return;
    setNaturalParsing(true);
    setNaturalError("");
    try {
      // Natural language → LLM parses and calls routine_schedule directly.
      // Fence the user input so it cannot influence the system prompt region.
      // Cap at 1000 chars to prevent oversized payloads.
      const fencedInput = naturalInput.trim().slice(0, 1000);
      await api.chatSend(
        t("routinePanel.naturalRoutinePrompt", { input: fencedInput }),
        undefined,
        "user-keyboard",
      );
      onAdded();
      onClose();
    } catch (err) {
      setNaturalError((err as Error).message ?? t("routinePanel.errorNaturalParseFailed"));
    } finally {
      setNaturalParsing(false);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent size="md" data-testid="add-routine-modal">
        <DialogHeader className="flex flex-row items-center justify-between space-y-0">
          <DialogTitle className="text-base">{t("routinePanel.addRoutineTitle")}</DialogTitle>
          <DialogClose asChild>
            <Button size="sm" variant="ghost" className="-mr-2 h-7 w-7 p-0" aria-label={t("routinePanel.closeAriaLabel")}>✕</Button>
          </DialogClose>
        </DialogHeader>

        {/* Tab selector for the three routine input styles. */}
        <div className="mb-4 flex gap-1 rounded-md border p-1 bg-muted/(--opacity-muted)" role="tablist">
          {(["form", "cron", "natural"] as InputTab[]).map((tabKey) => (
            <button
              key={tabKey}
              type="button"
              role="tab"
              aria-selected={tab === tabKey}
              className={`flex-1 rounded px-3 py-1.5 text-sm transition-colors ${
                tab === tabKey ? "bg-background font-medium shadow-sm" : "text-muted-foreground"
              }`}
              onClick={() => setTab(tabKey)}
            >
              {tabKey === "form" ? t("routinePanel.tabForm") : tabKey === "cron" ? t("routinePanel.tabCron") : t("routinePanel.tabNatural")}
            </button>
          ))}
        </div>

        {/* Shared: execution mode + title */}
        {tab !== "natural" && (
          <div className="mb-3 grid gap-3 sm:grid-cols-2">
            <Label className="space-y-1">
              <div className="text-xs font-medium text-muted-foreground">{t("routinePanel.executionModeLabel")}</div>
              <NativeSelect
                className="w-full"
                value={execution}
                onChange={(e) => setExecution(e.target.value as RoutineExecution)}
              >
                <NativeSelectOption value="llm-session">{t("routinePanel.executionLlmSession")}</NativeSelectOption>
                <NativeSelectOption value="notification-only">{t("routinePanel.executionNotificationOnly")}</NativeSelectOption>
              </NativeSelect>
            </Label>
            <Label className="space-y-1">
              <div className="text-xs font-medium text-muted-foreground">{t("routinePanel.titleLabel")}</div>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("routinePanel.titlePlaceholder")} />
            </Label>
          </div>
        )}

        {/* Form tab */}
        {tab === "form" && (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Label className="space-y-1">
                <div className="text-xs font-medium text-muted-foreground">{t("routinePanel.dateLabel")}</div>
                <Input type="date" value={atDate} onChange={(e) => setAtDate(e.target.value)} />
              </Label>
              <Label className="space-y-1">
                <div className="text-xs font-medium text-muted-foreground">{t("routinePanel.timeLabel")}</div>
                <Input type="time" value={atTime} onChange={(e) => setAtTime(e.target.value)} />
              </Label>
            </div>
            <Label className="space-y-1">
              <div className="text-xs font-medium text-muted-foreground">{t("routinePanel.repeatLabel")}</div>
              <NativeSelect
                className="w-full"
                value={repeatKind}
                onChange={(e) => setRepeatKind(e.target.value as RepeatKind)}
              >
                {REPEAT_OPTIONS.map((o) => (
                  <NativeSelectOption key={o.value} value={o.value}>{t(o.labelKey)}</NativeSelectOption>
                ))}
              </NativeSelect>
            </Label>
            {repeatKind === "interval" && (
              <Label className="space-y-1">
                <div className="text-xs font-medium text-muted-foreground">{t("routinePanel.intervalMinutesLabel")}</div>
                <Input
                  type="number"
                  min="1"
                  value={intervalMinutes}
                  onChange={(e) => setIntervalMinutes(e.target.value)}
                />
              </Label>
            )}
          </div>
        )}

        {/* Cron tab */}
        {tab === "cron" && (
          <div className="space-y-3">
            <Label className="space-y-1">
              <div className="text-xs font-medium text-muted-foreground">
                {t("routinePanel.cronExpressionLabel")}
              </div>
              <Input
                value={cronExpression}
                onChange={(e) => {
                  setCronExpression(e.target.value);
                  setCronError("");
                }}
                placeholder="0 9 * * 1-5"
                data-testid="cron-input"
                aria-invalid={cronError ? "true" : undefined}
              />
              {cronError && (
                <p className="text-sm text-destructive" data-testid="cron-error">{cronError}</p>
              )}
              <div className="text-[11px] text-muted-foreground">
                {t("routinePanel.cronExamplePrefix")} <code>0 9 * * 1-5</code> = {t("routinePanel.cronExample1")} &nbsp;·&nbsp;
                <code>*/30 * * * *</code> = {t("routinePanel.cronExample2")} &nbsp;·&nbsp;
                <code>0 18 * * 5</code> = {t("routinePanel.cronExample3")}
              </div>
            </Label>
          </div>
        )}

        {/* Natural language tab */}
        {tab === "natural" && (
          <div className="space-y-3">
            <Label className="space-y-1">
              <div className="text-xs font-medium text-muted-foreground">
                {t("routinePanel.naturalLanguageLabel")}
              </div>
              <Textarea
                value={naturalInput}
                onChange={(e) => setNaturalInput(e.target.value)}
                placeholder={t("routinePanel.naturalLanguagePlaceholder")}
                rows={3}
                data-testid="natural-input"
              />
            </Label>
            <div className="text-[11px] text-muted-foreground">
              {t("routinePanel.naturalLanguageHint")}
            </div>
            {naturalError && (
              <p className="text-sm text-destructive">{naturalError}</p>
            )}
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={onClose}>{t("routinePanel.cancelButton")}</Button>
              <Button
                size="sm"
                disabled={naturalParsing || !naturalInput.trim()}
                onClick={() => void handleNaturalLanguageParse()}
              >
                {naturalParsing ? t("routinePanel.processingLabel") : t("routinePanel.submitButton")}
              </Button>
            </div>
          </div>
        )}

        {/* LLM session prompt / notification fields */}
        {tab !== "natural" && (
          <div className="mt-3 space-y-3">
            {execution === "llm-session" ? (
              <div className="space-y-3">
                <Label className="space-y-1">
                  <div className="text-xs font-medium text-muted-foreground">{t("routinePanel.llmPromptLabel")}</div>
                  <Textarea
                    value={prePrompt}
                    onChange={(e) => setPrePrompt(e.target.value)}
                    placeholder={t("routinePanel.llmPromptPlaceholder")}
                    rows={3}
                    data-testid="pre-prompt-input"
                  />
                </Label>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="text-xs font-medium text-muted-foreground">{t("routinePanel.allowedPluginsLabel")}</div>
                    {allowedPluginIds.length > 0 && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-[11px]"
                        onClick={() => setAllowedPluginIds([])}
                        data-testid="routine-clear-allowed-plugins"
                      >
                        {t("routinePanel.clearPluginsButton")}
                      </Button>
                    )}
                  </div>
                  {pluginScopeError ? (
                    <p className="text-sm text-destructive">{pluginScopeError}</p>
                  ) : pluginCards.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground">{t("routinePanel.noPluginsAvailable")}</p>
                  ) : (
                    <div className="grid max-h-32 gap-1 overflow-y-auto rounded-md border p-2 sm:grid-cols-2">
                      {pluginCards.map((plugin) => (
                        <Label
                          key={plugin.id}
                          className="flex min-w-0 items-center gap-2 rounded px-2 py-1 text-xs hover:bg-muted/(--opacity-strong)"
                        >
                          <Checkbox
                            checked={allowedPluginIds.includes(plugin.id)}
                            onCheckedChange={() => toggleAllowedPlugin(plugin.id)}
                            data-testid={`routine-allowed-plugin-${plugin.id}`}
                          />
                          <span className="truncate">{plugin.name}</span>
                        </Label>
                      ))}
                    </div>
                  )}
                  <p className="text-[11px] text-muted-foreground">
                    {t("routinePanel.pluginDenyAllHint")}
                  </p>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <Label className="space-y-1">
                  <div className="text-xs font-medium text-muted-foreground">{t("routinePanel.notificationTitleLabel")}</div>
                  <Input
                    value={notificationTitle}
                    onChange={(e) => setNotificationTitle(e.target.value)}
                    placeholder={t("routinePanel.notificationTitlePlaceholder")}
                  />
                </Label>
                <Label className="space-y-1">
                  <div className="text-xs font-medium text-muted-foreground">{t("routinePanel.notificationBodyLabel")}</div>
                  <Input
                    value={notificationBody}
                    onChange={(e) => setNotificationBody(e.target.value)}
                    placeholder={t("routinePanel.notificationBodyPlaceholder")}
                  />
                </Label>
              </div>
            )}

            {error && <p className="text-sm text-destructive">{error}</p>}

            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={onClose}>{t("routinePanel.cancelButton")}</Button>
              <Button
                size="sm"
                disabled={submitting}
                onClick={() => void handleSubmit()}
              >
                {submitting ? t("routinePanel.submittingLabel") : t("routinePanel.submitButton")}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Main Panel ───────────────────────────────────────────────────────────────

export function RoutinePanel({ api, onOpenSession }: RoutinePanelProps) {
  const [routines, setRoutines] = useState<RoutineRecord[]>([]);
  const [routineSessions, setRoutineSessions] = useState<RoutineSessionListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [recentlyFired, setRecentlyFired] = useState<string[]>([]);
  const [showAddModal, setShowAddModal] = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const refresh = useCallback(async () => {
    if (typeof api.listRoutinesV2 !== "function") return;
    setLoading(true);
    try {
      const list = await api.listRoutinesV2();
      const sessions = (
        await Promise.all(
          list
            .filter((routine) => routine.execution === "llm-session")
            .map(async (routine) => {
              const records = await api.listRoutineSessionsV2(routine.id, 10);
              const routineTitle =
                routine.title ?? routine.notificationTitle ?? routine.prePrompt?.slice(0, 30) ?? routine.id.slice(0, 8);
              return records.map((record) => ({
                routineId: record.routineId,
                routineTitle,
                firedAt: record.firedAt,
                sessionId: record.sessionId,
                preview: record.preview,
              }));
            }),
        )
      )
        .flat()
        .sort((a, b) => b.firedAt.localeCompare(a.firedAt))
        .slice(0, 30);
      if (!mountedRef.current) return;
      setRoutines(list);
      setRoutineSessions(sessions);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
    if (typeof api.onRoutineFiredV2 !== "function") return undefined;
    const unsub = api.onRoutineFiredV2((r) => {
      setRecentlyFired((prev) => (prev.includes(r.id) ? prev : [...prev, r.id]));
      void refresh();
    });
    return unsub;
  }, [api, refresh]);

  const handleDismiss = useCallback(
    async (id: string) => {
      await api.dismissRoutineV2(id);
      await refresh();
    },
    [api, refresh],
  );

  const handleRemove = useCallback(
    async (id: string) => {
      await api.removeRoutineV2(id);
      await refresh();
    },
    [api, refresh],
  );

  const handleTriggerNow = useCallback(
    async (id: string) => {
      await api.triggerRoutineNowV2(id);
      setRecentlyFired((prev) => (prev.includes(id) ? prev : [...prev, id]));
      await refresh();
    },
    [api, refresh],
  );

  const llmCount = routines.filter((r) => r.execution === "llm-session").length;
  const totalCapReached = routines.length >= MAX_PERSISTED_ROUTINES;

  return (
    <>
      <div
        className="mx-auto flex min-h-0 min-w-0 flex-1 w-full max-w-3xl flex-col overflow-hidden"
        data-testid="routine-panel"
      >
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>{t("routinePanel.panelTitle")}</CardTitle>
              <CardDescription>{t("routinePanel.panelDescription")}</CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="outline" title={t("routinePanel.totalRoutineBadgeTitle")}>
                {routines.length}/{MAX_PERSISTED_ROUTINES}
              </Badge>
              <Badge variant="outline" title={t("routinePanel.llmRoutineBadgeTitle")}>
                LLM {llmCount}/{MAX_LLM_SESSION_ROUTINES}
              </Badge>
              {totalCapReached && (
                <span className="text-xs text-destructive">{t("routinePanel.capReachedLabel")}</span>
              )}
              <Button
                size="sm"
                variant="outline"
                disabled={totalCapReached}
                onClick={() => setShowAddModal(true)}
              >
                {t("routinePanel.addRoutineButton")}
              </Button>
              <Button size="sm" variant="outline" onClick={() => void refresh()}>
                {t("routinePanel.refreshButton")}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex min-h-0 flex-1 flex-col gap-3">
          <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(240px,0.72fr)]">
            <section className="flex min-h-0 flex-col gap-2" data-testid="routine-list-section">
              <div className="flex items-center justify-between rounded-t-lg border-b bg-muted/(--opacity-medium) px-3 py-2">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t("routinePanel.routineListHeading")}</h3>
                <Badge variant="outline" className="h-5 px-1.5 text-[11px] tabular-nums">{routines.length}</Badge>
              </div>
              <ScrollArea className="min-h-[220px] flex-1">
                {loading ? (
                  <div className="py-8 text-center text-sm text-muted-foreground">{t("routinePanel.loadingLabel")}</div>
                ) : routines.length === 0 ? (
                  <div className="py-8 text-center text-sm text-muted-foreground">
                    {t("routinePanel.noRoutinesEmpty")}
                  </div>
                ) : (
                  <div className="space-y-2 pr-2">
                    {routines.map((r) => (
                      <RoutineRow
                        key={r.id}
                        routine={r}
                        onDismiss={(id) => void handleDismiss(id)}
                        onRemove={(id) => void handleRemove(id)}
                        onTriggerNow={(id) => void handleTriggerNow(id)}
                        recentlyFired={recentlyFired.includes(r.id)}
                      />
                    ))}
                  </div>
                )}
              </ScrollArea>
            </section>

            <section className="flex min-h-0 flex-col gap-2" data-testid="routine-session-list">
              <div className="flex items-center justify-between rounded-t-lg border-b bg-muted/(--opacity-medium) px-3 py-2">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t("routinePanel.sessionListHeading")}</h3>
                <Badge variant="outline" className="h-5 px-1.5 text-[11px] tabular-nums">{routineSessions.length}</Badge>
              </div>
              <ScrollArea className="min-h-[220px] flex-1">
                {loading ? (
                  <div className="py-8 text-center text-sm text-muted-foreground">{t("routinePanel.loadingLabel")}</div>
                ) : routineSessions.length === 0 ? (
                  <div className="py-8 text-center text-sm text-muted-foreground">
                    {t("routinePanel.noSessionsEmpty")}
                  </div>
                ) : (
                  <div className="space-y-2 pr-2">
                    {routineSessions.map((session) => (
                      <RoutineSessionRow
                        key={`${session.routineId}:${session.firedAt}:${session.sessionId}`}
                        session={session}
                        onOpen={(sessionId) => onOpenSession?.(sessionId)}
                      />
                    ))}
                  </div>
                )}
              </ScrollArea>
            </section>
          </div>
        </CardContent>
      </div>

      {showAddModal && (
        <AddRoutineModal
          api={api}
          onClose={() => setShowAddModal(false)}
          onAdded={() => {
            setShowAddModal(false);
            void refresh();
          }}
        />
      )}
    </>
  );
}
interface RoutineSessionListItem {
  routineId: string;
  routineTitle: string;
  firedAt: string;
  sessionId: string;
  preview: string;
}
