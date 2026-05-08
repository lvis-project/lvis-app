/**
 * RoutinePanel v2 — unified routine management UI.
 *
 * Q2: single list with execution mode badge per row.
 * Q4: Add Routine modal with 3 input tabs (Form / Cron / Natural language).
 * Q6: MAX_PERSISTED_ROUTINES = 50 (enforced by store; shown in UI).
 *
 * RemindersList absorbed — removed (atomic cutover, Q3).
 */
import { useCallback, useEffect, useState } from "react";
import { Badge } from "../../../components/ui/badge.js";
import { Button } from "../../../components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card.js";
import { Input } from "../../../components/ui/input.js";
import { ScrollArea } from "../../../components/ui/scroll-area.js";
import { Textarea } from "../../../components/ui/textarea.js";
import type { LvisApi } from "../types.js";
import type { RoutineRecord, RoutineExecution, RepeatKind } from "../../../main/routines-store.js";
import { MAX_PERSISTED_ROUTINES } from "../../../main/routines-store.js";

export interface RoutinePanelProps {
  api: LvisApi;
}

// ─── Execution badge ─────────────────────────────────────────────────────────

function ExecutionBadge({ execution }: { execution: RoutineExecution }) {
  return (
    <Badge variant={execution === "llm-session" ? "default" : "outline"}>
      {execution === "llm-session" ? "LLM" : "알림"}
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
  if (!s) return routine.trigger === "shutdown" ? "앱 종료 시" : "스케줄 없음";
  const repeatKind = s.repeat?.kind;
  const atStr = s.at ? new Date(s.at).toLocaleString("ko-KR") : "";
  if (repeatKind === "cron") {
    const expr = (s.repeat as { kind: "cron"; expression: string }).expression;
    return `크론: ${expr}`;
  }
  if (repeatKind === "daily") return `매일 ${atStr}`;
  if (repeatKind === "weekly") return `매주 ${atStr}`;
  if (repeatKind === "monthly") return `매월 ${atStr}`;
  if (repeatKind === "interval") {
    const ms = (s.repeat as { kind: "interval"; intervalMs: number }).intervalMs;
    const mins = Math.round(ms / 60000);
    return `${mins}분 간격${atStr ? ` (다음: ${atStr})` : ""}`;
  }
  return atStr || "1회";
}

function RoutineRow({ routine, onDismiss, onRemove, onTriggerNow, recentlyFired }: RoutineRowProps) {
  return (
    <div
      className={`rounded-md border p-3 ${recentlyFired ? "border-amber-500/60 bg-amber-500/5" : ""}`}
      data-testid="routine-row"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{routine.title || routine.id.slice(0, 8)}</span>
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
            지금 실행
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-[11px]"
            onClick={() => onDismiss(routine.id)}
          >
            닫기
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-[11px] text-destructive"
            onClick={() => onRemove(routine.id)}
          >
            삭제
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Add Routine Modal ────────────────────────────────────────────────────────

type InputTab = "form" | "cron" | "natural";

const REPEAT_OPTIONS: Array<{ value: RepeatKind; label: string }> = [
  { value: "none", label: "1회" },
  { value: "daily", label: "매일" },
  { value: "weekly", label: "매주" },
  { value: "monthly", label: "매월" },
  { value: "interval", label: "간격" },
];

interface AddRoutineModalProps {
  api: LvisApi;
  onClose: () => void;
  onAdded: () => void;
}

function AddRoutineModal({ api, onClose, onAdded }: AddRoutineModalProps) {
  const [tab, setTab] = useState<InputTab>("form");
  const [execution, setExecution] = useState<RoutineExecution>("llm-session");
  const [title, setTitle] = useState("");
  const [prePrompt, setPrePrompt] = useState("");
  const [notificationTitle, setNotificationTitle] = useState("");
  const [notificationBody, setNotificationBody] = useState("");

  // Form tab fields
  const [atDate, setAtDate] = useState("");
  const [atTime, setAtTime] = useState("09:00");
  const [repeatKind, setRepeatKind] = useState<RepeatKind>("none");
  const [intervalMinutes, setIntervalMinutes] = useState("60");

  // Cron tab
  const [cronExpression, setCronExpression] = useState("0 9 * * 1-5");

  // Natural language tab
  const [naturalInput, setNaturalInput] = useState("");
  const [naturalParsing, setNaturalParsing] = useState(false);
  const [naturalError, setNaturalError] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const buildSchedulePayload = (): Record<string, unknown> | null => {
    if (tab === "form") {
      if (!atDate) return null;
      const at = `${atDate}T${atTime}:00`;
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
      return { repeat: { kind: "cron", expression: expr } };
    }
    return null;
  };

  const handleSubmit = async () => {
    if (tab === "natural") {
      // Natural language: use chatSend to ask LLM to call schedule_routine tool.
      // The LLM will use the tool directly — nothing to submit here manually.
      onClose();
      // Route the natural language input to the main chat.
      await api.chatSend(
        `다음 루틴을 schedule_routine 툴을 사용해서 등록해줘: ${naturalInput}`,
      );
      onAdded();
      return;
    }
    const schedule = buildSchedulePayload();
    if (!schedule) {
      setError("스케줄 정보를 올바르게 입력해주세요.");
      return;
    }
    const payload: Record<string, unknown> = {
      execution,
      schedule,
      ...(title ? { title } : {}),
    };
    if (execution === "llm-session") {
      if (!prePrompt.trim()) {
        setError("LLM 세션 모드에서는 프롬프트가 필요합니다.");
        return;
      }
      payload.prePrompt = prePrompt.trim();
    } else {
      if (notificationTitle.trim()) payload.notificationTitle = notificationTitle.trim();
      if (notificationBody.trim()) payload.notificationBody = notificationBody.trim();
    }

    setSubmitting(true);
    setError("");
    try {
      // Use the LLM tool directly via chatSend — or call IPC add directly.
      // We route via chatSend so the LLM can handle it, but for the UI path
      // we want a direct IPC add. Since we don't have a direct IPC add in the
      // preload (tool is LLM-invoked), we use chatSend with the structured call.
      // The simplest correct approach: send a chat message asking the LLM to
      // call schedule_routine with the exact parameters we've already built.
      onClose();
      const scheduleStr = JSON.stringify(schedule);
      const prePromptStr = execution === "llm-session" ? `prePrompt: "${prePrompt.trim()}", ` : "";
      const notifStr = execution === "notification-only"
        ? `notificationTitle: "${notificationTitle}", notificationBody: "${notificationBody}", `
        : "";
      const titleStr = title ? `title: "${title}", ` : "";
      await api.chatSend(
        `schedule_routine 툴을 직접 호출해줘. 파라미터: execution="${execution}", schedule=${scheduleStr}, ${prePromptStr}${notifStr}${titleStr}`,
      );
      onAdded();
    } catch (err) {
      setError((err as Error).message ?? "루틴 등록 실패");
    } finally {
      setSubmitting(false);
    }
  };

  const handleNaturalLanguageParse = async () => {
    if (!naturalInput.trim()) return;
    setNaturalParsing(true);
    setNaturalError("");
    try {
      // Natural language → LLM parses and calls schedule_routine directly.
      // No client-side parsing needed — just route to chat.
      onClose();
      await api.chatSend(
        `다음 루틴을 schedule_routine 툴을 사용해서 등록해줘: ${naturalInput.trim()}`,
      );
      onAdded();
    } catch (err) {
      setNaturalError((err as Error).message ?? "자연어 파싱 실패");
    } finally {
      setNaturalParsing(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      data-testid="add-routine-modal"
    >
      <div className="w-full max-w-lg rounded-lg border bg-background p-6 shadow-lg">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">루틴 추가</h2>
          <Button size="sm" variant="ghost" onClick={onClose}>✕</Button>
        </div>

        {/* Tab selector (Q4: 3 input types) */}
        <div className="mb-4 flex gap-1 rounded-md border p-1 bg-muted/30" role="tablist">
          {(["form", "cron", "natural"] as InputTab[]).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              className={`flex-1 rounded px-3 py-1.5 text-sm transition-colors ${
                tab === t ? "bg-background font-medium shadow-sm" : "text-muted-foreground"
              }`}
              onClick={() => setTab(t)}
            >
              {t === "form" ? "양식" : t === "cron" ? "크론" : "자연어"}
            </button>
          ))}
        </div>

        {/* Shared: execution mode + title */}
        {tab !== "natural" && (
          <div className="mb-3 grid gap-3 sm:grid-cols-2">
            <label className="space-y-1">
              <div className="text-xs font-medium text-muted-foreground">실행 모드</div>
              <select
                className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                value={execution}
                onChange={(e) => setExecution(e.target.value as RoutineExecution)}
              >
                <option value="llm-session">LLM 세션</option>
                <option value="notification-only">알림만</option>
              </select>
            </label>
            <label className="space-y-1">
              <div className="text-xs font-medium text-muted-foreground">제목 (선택)</div>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="데일리 리포트" />
            </label>
          </div>
        )}

        {/* Form tab */}
        {tab === "form" && (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1">
                <div className="text-xs font-medium text-muted-foreground">날짜</div>
                <Input type="date" value={atDate} onChange={(e) => setAtDate(e.target.value)} />
              </label>
              <label className="space-y-1">
                <div className="text-xs font-medium text-muted-foreground">시각</div>
                <Input type="time" value={atTime} onChange={(e) => setAtTime(e.target.value)} />
              </label>
            </div>
            <label className="space-y-1">
              <div className="text-xs font-medium text-muted-foreground">반복</div>
              <select
                className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                value={repeatKind}
                onChange={(e) => setRepeatKind(e.target.value as RepeatKind)}
              >
                {REPEAT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </label>
            {repeatKind === "interval" && (
              <label className="space-y-1">
                <div className="text-xs font-medium text-muted-foreground">간격 (분)</div>
                <Input
                  type="number"
                  min="1"
                  value={intervalMinutes}
                  onChange={(e) => setIntervalMinutes(e.target.value)}
                />
              </label>
            )}
          </div>
        )}

        {/* Cron tab */}
        {tab === "cron" && (
          <div className="space-y-3">
            <label className="space-y-1">
              <div className="text-xs font-medium text-muted-foreground">
                크론 표현식 (분 시 일 월 요일)
              </div>
              <Input
                value={cronExpression}
                onChange={(e) => setCronExpression(e.target.value)}
                placeholder="0 9 * * 1-5"
                data-testid="cron-input"
              />
              <div className="text-[11px] text-muted-foreground">
                예: <code>0 9 * * 1-5</code> = 평일 오전 9시 &nbsp;·&nbsp;
                <code>*/30 * * * *</code> = 30분마다 &nbsp;·&nbsp;
                <code>0 18 * * 5</code> = 매주 금요일 오후 6시
              </div>
            </label>
          </div>
        )}

        {/* Natural language tab */}
        {tab === "natural" && (
          <div className="space-y-3">
            <label className="space-y-1">
              <div className="text-xs font-medium text-muted-foreground">
                자연어로 루틴을 설명하세요
              </div>
              <Textarea
                value={naturalInput}
                onChange={(e) => setNaturalInput(e.target.value)}
                placeholder="매일 아침 9시에 데일리 리포트 작성해줘"
                rows={3}
                data-testid="natural-input"
              />
            </label>
            <div className="text-[11px] text-muted-foreground">
              LLM이 자연어를 분석해서 schedule_routine 툴을 호출합니다.
            </div>
            {naturalError && (
              <p className="text-sm text-destructive">{naturalError}</p>
            )}
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={onClose}>취소</Button>
              <Button
                size="sm"
                disabled={naturalParsing || !naturalInput.trim()}
                onClick={() => void handleNaturalLanguageParse()}
              >
                {naturalParsing ? "처리 중..." : "등록"}
              </Button>
            </div>
          </div>
        )}

        {/* LLM session prompt / notification fields */}
        {tab !== "natural" && (
          <div className="mt-3 space-y-3">
            {execution === "llm-session" ? (
              <label className="space-y-1">
                <div className="text-xs font-medium text-muted-foreground">LLM 프롬프트</div>
                <Textarea
                  value={prePrompt}
                  onChange={(e) => setPrePrompt(e.target.value)}
                  placeholder="오늘의 데일리 리포트 작성"
                  rows={3}
                  data-testid="pre-prompt-input"
                />
              </label>
            ) : (
              <div className="space-y-2">
                <label className="space-y-1">
                  <div className="text-xs font-medium text-muted-foreground">알림 제목</div>
                  <Input
                    value={notificationTitle}
                    onChange={(e) => setNotificationTitle(e.target.value)}
                    placeholder="알림 제목"
                  />
                </label>
                <label className="space-y-1">
                  <div className="text-xs font-medium text-muted-foreground">알림 본문 (선택)</div>
                  <Input
                    value={notificationBody}
                    onChange={(e) => setNotificationBody(e.target.value)}
                    placeholder="알림 내용"
                  />
                </label>
              </div>
            )}

            {error && <p className="text-sm text-destructive">{error}</p>}

            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={onClose}>취소</Button>
              <Button
                size="sm"
                disabled={submitting}
                onClick={() => void handleSubmit()}
              >
                {submitting ? "등록 중..." : "등록"}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main Panel ───────────────────────────────────────────────────────────────

export function RoutinePanel({ api }: RoutinePanelProps) {
  const [routines, setRoutines] = useState<RoutineRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [recentlyFired, setRecentlyFired] = useState<string[]>([]);
  const [showAddModal, setShowAddModal] = useState(false);

  const refresh = useCallback(async () => {
    if (typeof api.listRoutinesV2 !== "function") return;
    setLoading(true);
    try {
      const list = await api.listRoutinesV2();
      setRoutines(list);
    } finally {
      setLoading(false);
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

  return (
    <>
      <Card
        className="mx-auto flex min-h-0 min-w-0 flex-1 w-full max-w-3xl flex-col overflow-hidden"
        data-testid="routine-panel"
      >
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>루틴</CardTitle>
              <CardDescription>예약된 루틴과 알림 일정</CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="outline">{routines.length}/{MAX_PERSISTED_ROUTINES}</Badge>
              <Button
                size="sm"
                variant="outline"
                disabled={routines.length >= MAX_PERSISTED_ROUTINES}
                onClick={() => setShowAddModal(true)}
              >
                + 루틴 추가
              </Button>
              <Button size="sm" variant="outline" onClick={() => void refresh()}>
                새로고침
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex min-h-0 flex-1 flex-col gap-3">
          <ScrollArea className="flex-1">
            {loading ? (
              <div className="py-8 text-center text-sm text-muted-foreground">로딩 중...</div>
            ) : routines.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
                등록된 루틴이 없습니다.
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
        </CardContent>
      </Card>

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
