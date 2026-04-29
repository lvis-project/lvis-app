import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "../../../components/ui/badge.js";
import { Button } from "../../../components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card.js";
import { Input } from "../../../components/ui/input.js";
import { ScrollArea } from "../../../components/ui/scroll-area.js";
import { Textarea } from "../../../components/ui/textarea.js";
import type { LvisApi, RoutineRecord } from "../types.js";
import {
  DEFAULT_SHUTDOWN_PROMPT,
  DEFAULT_WAKEUP_ROUTINE_PROMPT,
  SCHEDULE_AGENT_OPTIONS,
  MAX_SCHEDULE_ENTRIES,
  createDefaultScheduleEntry,
  getDefaultSchedulePrompt,
  scheduleToCron,
  isValidScheduleEntries,
  type ScheduleRoutineEntry,
} from "../../../routines/schedule.js";

export interface RoutinePanelProps {
  api: LvisApi;
  onActivateHome: () => void;
  onJumpToSession: (sessionId: string) => void | Promise<void>;
  onStartRoutineSession: (routineId: string) => Promise<void>;
}

// ─── 공용 토글 스위치 ──────────────────────────────────
interface SwitchRowProps {
  checked: boolean;
  label: string;
  description?: string;
  onToggle: () => void;
}

function SwitchRow({ checked, label, description, onToggle }: SwitchRowProps) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-3">
      <div className="space-y-0.5">
        <p className="text-sm font-medium">{label}</p>
        {description ? <p className="text-[11px] text-muted-foreground">{description}</p> : null}
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">{checked ? "ON" : "OFF"}</span>
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          aria-label={label}
          className={`relative inline-flex h-6 w-11 items-center rounded-full border transition-colors ${
            checked ? "border-primary bg-primary" : "border-muted-foreground/50 bg-muted"
          }`}
          onClick={onToggle}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-background shadow transition-transform ${
              checked ? "translate-x-5" : "translate-x-1"
            }`}
          />
        </button>
      </div>
    </div>
  );
}

// ─── 스케줄 엔트리 리스트 아이템 ──────────────────────────
interface ScheduleEntryItemProps {
  entry: ScheduleRoutineEntry;
  index: number;
  totalCount: number;
  onUpdate: (updated: ScheduleRoutineEntry) => void;
  onRemove: () => void;
}

const CRON_PRESETS = [
  { label: "5분", value: { minute: "*/5", hour: "*", dayOfMonth: "*", month: "*", dayOfWeek: "*" } },
  { label: "15분", value: { minute: "*/15", hour: "*", dayOfMonth: "*", month: "*", dayOfWeek: "*" } },
  { label: "30분", value: { minute: "*/30", hour: "*", dayOfMonth: "*", month: "*", dayOfWeek: "*" } },
  { label: "평일 업무시간", value: { minute: "0", hour: "9-18", dayOfMonth: "*", month: "*", dayOfWeek: "1-5" } },
] as const;

function ScheduleEntryItem({ entry, index, totalCount, onUpdate, onRemove }: ScheduleEntryItemProps) {
  return (
    <div className="rounded-md border bg-background/60 p-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-medium">스케줄 {index + 1}</div>
          <div className="text-xs text-muted-foreground">{entry.id}</div>
        </div>
        <div className="flex items-center gap-2">
          <SwitchRow
            checked={entry.enabled}
            label="개별 활성화"
            onToggle={() => onUpdate({ ...entry, enabled: !entry.enabled })}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={totalCount <= 1}
            onClick={onRemove}
          >
            제거
          </Button>
        </div>
      </div>

      <div className="mb-3 grid gap-2 md:grid-cols-2">
        <label className="space-y-1">
          <div className="text-xs font-medium text-muted-foreground">에이전트</div>
          <select
            className="h-9 w-full rounded-md border bg-background px-3 text-sm"
            value={entry.agentId}
            onChange={(e) => {
              const nextAgentId = e.target.value as ScheduleRoutineEntry["agentId"];
              const shouldReset =
                entry.prompt.trim().length === 0 ||
                entry.prompt === getDefaultSchedulePrompt(entry.agentId);
              onUpdate({
                ...entry,
                agentId: nextAgentId,
                prompt: shouldReset ? getDefaultSchedulePrompt(nextAgentId) : entry.prompt,
              });
            }}
          >
            {SCHEDULE_AGENT_OPTIONS.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.label} - {opt.description}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="mb-3 block space-y-1">
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs font-medium text-muted-foreground">LLM 자연어 요구사항</div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onUpdate({ ...entry, prompt: getDefaultSchedulePrompt(entry.agentId) })}
          >
            기본 포맷 복원
          </Button>
        </div>
        <div className="text-xs text-muted-foreground">
          기본 포맷을 바탕으로, 원하는 요구사항을 자연어로 자유롭게 수정할 수 있습니다.
        </div>
        <Textarea
          value={entry.prompt}
          onChange={(e) => onUpdate({ ...entry, prompt: e.target.value })}
          rows={4}
        />
      </label>

      <div className="mb-3 flex flex-wrap gap-2">
        {CRON_PRESETS.map((preset) => (
          <Button
            key={preset.label}
            size="sm"
            variant="outline"
            onClick={() => onUpdate({ ...entry, schedule: { ...preset.value } })}
          >
            {preset.label}
          </Button>
        ))}
      </div>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        {([
          ["minute", "분", "*/15"],
          ["hour", "시", "*"],
          ["dayOfMonth", "일", "*"],
          ["month", "월", "*"],
          ["dayOfWeek", "요일", "1-5"],
        ] as const).map(([field, label, placeholder]) => (
          <label key={field} className="space-y-1">
            <div className="text-xs font-medium text-muted-foreground">{label}</div>
            <Input
              value={entry.schedule[field]}
              onChange={(e) => onUpdate({ ...entry, schedule: { ...entry.schedule, [field]: e.target.value } })}
              placeholder={placeholder}
            />
          </label>
        ))}
      </div>

      <div className="mt-3">
        <Badge variant="outline">{scheduleToCron(entry.schedule)}</Badge>
      </div>
    </div>
  );
}

// ─── DEV 버튼 정의 ──────────────────────────────────────
const DEV_TRIGGER_MAP: Record<string, {
  label: string;
  busyLabel: string;
  invoke: (api: LvisApi) => Promise<{ ok: boolean; summary?: string; error?: string }>;
}> = {
  wakeup: {
    label: "웨이크업 루틴 지금 실행",
    busyLabel: "트리거 중...",
    invoke: (api) => api.triggerWakeupRoutineDev(),
  },
  schedule: {
    label: "스케줄 루틴 지금 실행",
    busyLabel: "트리거 중...",
    invoke: (api) => api.triggerScheduleRoutineDev(),
  },
  shutdown: {
    label: "종료 루틴 지금 실행",
    busyLabel: "트리거 중...",
    invoke: (api) => api.triggerShutdownRoutineDev(),
  },
};

// ─── 메인 패널 ──────────────────────────────────────────
export function RoutinePanel({
  api,
  onActivateHome,
  onJumpToSession,
  onStartRoutineSession,
}: RoutinePanelProps) {
  // Match the server-side gate: ipc-bridge.ts devTriggerHandler uses
  // isDevModeUnlocked() which accepts all 5 LVIS_DEV* flags, not just LVIS_DEV.
  const isDevMode = window.lvis?.env?.devUnlocked === true || window.lvis?.env?.isDev === true;
  const [routines, setRoutines] = useState<RoutineRecord[]>([]);
  const [draftTimes, setDraftTimes] = useState<Record<string, string>>({});
  const [contextPromptDrafts, setContextPromptDrafts] = useState<Record<string, string>>({});
  const [scheduleEntryDrafts, setScheduleEntryDrafts] = useState<Record<string, ScheduleRoutineEntry[]>>({});
  const [devTriggerBusy, setDevTriggerBusy] = useState(false);

  const refresh = useCallback(async () => {
    const next = await api.listRoutines();
    setRoutines(next);
    setDraftTimes((cur) => {
      const merged = { ...cur };
      for (const r of next) {
        if (r.scheduleTimeKst && !merged[r.id]) merged[r.id] = r.scheduleTimeKst;
      }
      return merged;
    });
    setScheduleEntryDrafts((cur) => {
      const merged = { ...cur };
      for (const r of next) {
        if (r.scheduleEntries && !merged[r.id]) {
          merged[r.id] = r.scheduleEntries.map(({ cron: _cron, ...entry }) => ({
            ...entry,
            schedule: { ...entry.schedule },
          }));
        }
      }
      return merged;
    });
    setContextPromptDrafts((cur) => {
      const merged = { ...cur };
      for (const r of next) {
        if (r.contextPrompt && !merged[r.id]) merged[r.id] = r.contextPrompt;
      }
      return merged;
    });
  }, [api]);

  useEffect(() => { void refresh(); }, [refresh]);

  const enabledCount = useMemo(
    () => routines.filter((r) => r.enabled).length,
    [routines],
  );

  const updateRoutine = useCallback(
    async (
      routineId: string,
      patch: {
        enabled?: boolean;
        scheduleTimeKst?: string;
        contextPrompt?: string;
        scheduleEntries?: ScheduleRoutineEntry[];
      },
    ) => {
      await api.updateRoutine(routineId, patch);
      await refresh();
    },
    [api, refresh],
  );

  const scheduleEntriesFor = useCallback(
    (routine: RoutineRecord) =>
      scheduleEntryDrafts[routine.id] ??
      routine.scheduleEntries?.map(({ cron: _cron, ...entry }) => ({
        ...entry,
        schedule: { ...entry.schedule },
      })) ??
      [createDefaultScheduleEntry(0)],
    [scheduleEntryDrafts],
  );

  const updateEntry = useCallback(
    (routineId: string, current: ScheduleRoutineEntry[], updated: ScheduleRoutineEntry) => {
      setScheduleEntryDrafts((cur) => ({
        ...cur,
        [routineId]: current.map((e) => (e.id === updated.id ? updated : e)),
      }));
    },
    [],
  );

  const removeEntry = useCallback(
    (routineId: string, current: ScheduleRoutineEntry[], entryId: string) => {
      setScheduleEntryDrafts((cur) => ({
        ...cur,
        [routineId]: current.filter((e) => e.id !== entryId),
      }));
    },
    [],
  );

  const defaultContextPromptFor = useCallback((routineId: string) => {
    if (routineId === "wakeup") return DEFAULT_WAKEUP_ROUTINE_PROMPT;
    if (routineId === "shutdown") return DEFAULT_SHUTDOWN_PROMPT;
    return "";
  }, []);

  const handleDevTrigger = useCallback(
    async (routineId: string) => {
      const def = DEV_TRIGGER_MAP[routineId];
      if (!def) return;
      setDevTriggerBusy(true);
      try {
        const result = await def.invoke(api);
        await refresh();
        if (result.ok) onActivateHome();
      } finally {
        setDevTriggerBusy(false);
      }
    },
    [api, refresh, onActivateHome],
  );

  return (
    <Card className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col overflow-hidden">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle>루틴</CardTitle>
            <CardDescription>등록된 루틴을 확인하고 설정하며, 루틴별 대화를 모아볼 수 있습니다.</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline">{enabledCount}/{routines.length} 활성</Badge>
            <Button size="sm" variant="outline" onClick={() => void refresh()}>새로고침</Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-3">
        <ScrollArea className="flex-1 pr-2">
          <div className="space-y-4">
            {routines.map((routine) => {
              const entries = scheduleEntriesFor(routine);
              return (
                <div key={routine.id} className="rounded-lg border p-4">
                  {/* 헤더: 제목 + 토글 + 대화열기 */}
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <h3 className="text-sm font-semibold">{routine.title}</h3>
                        <Badge variant={routine.enabled ? "default" : "outline"}>{routine.trigger}</Badge>
                      </div>
                      <p className="text-sm text-muted-foreground">{routine.description}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="min-w-[180px]">
                        <SwitchRow
                          checked={routine.enabled}
                          label="루틴 활성화"
                          description="좌우 토글로 바로 켜고 끌 수 있습니다."
                          onToggle={() => void updateRoutine(routine.id, { enabled: !routine.enabled })}
                        />
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void onStartRoutineSession(routine.id).then(refresh)}
                      >
                        대화 열기
                      </Button>
                    </div>
                  </div>

                  {/* 설정 영역 */}
                  {(routine.scheduleTimeKst !== undefined || routine.contextPrompt !== undefined || routine.scheduleEntries !== undefined) && (
                    <div className="mt-4 grid gap-3 rounded-md bg-muted/40 p-3 md:grid-cols-2">
                      {/* 예약 시각 (wakeup) */}
                      {routine.scheduleTimeKst !== undefined && (
                        <div className="space-y-1">
                          <div className="text-xs font-medium text-muted-foreground">예약 시각 (KST)</div>
                          <div className="flex items-center gap-2">
                            <Input
                              type="time"
                              value={draftTimes[routine.id] ?? routine.scheduleTimeKst ?? ""}
                              onChange={(e) =>
                                setDraftTimes((cur) => ({ ...cur, [routine.id]: e.target.value }))
                              }
                            />
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() =>
                                void updateRoutine(routine.id, { scheduleTimeKst: draftTimes[routine.id] ?? routine.scheduleTimeKst })
                              }
                            >
                              저장
                            </Button>
                          </div>
                        </div>
                      )}

                      {/* 컨텍스트 프롬프트 (wakeup/shutdown) */}
                      {routine.contextPrompt !== undefined && (
                        <label className="space-y-1 md:col-span-2">
                          <div className="flex items-center justify-between gap-2">
                            <div className="text-xs font-medium text-muted-foreground">LLM 컨텍스트 요구사항</div>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                setContextPromptDrafts((cur) => ({
                                  ...cur,
                                  [routine.id]: defaultContextPromptFor(routine.id),
                                }))
                              }
                            >
                              예시 복원
                            </Button>
                          </div>
                          <div className="text-xs text-muted-foreground">
                            루틴 시작 시 LLM에게 전달할 컨텍스트 프롬프트를 자유롭게 편집할 수 있습니다.
                          </div>
                          <Textarea
                            value={contextPromptDrafts[routine.id] ?? routine.contextPrompt}
                            onChange={(e) =>
                              setContextPromptDrafts((cur) => ({ ...cur, [routine.id]: e.target.value }))
                            }
                            rows={4}
                          />
                          <div className="flex items-center justify-end">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() =>
                                void updateRoutine(routine.id, {
                                  contextPrompt: contextPromptDrafts[routine.id] ?? routine.contextPrompt,
                                })
                              }
                            >
                              저장
                            </Button>
                          </div>
                        </label>
                      )}

                      {/* DEV 트리거 버튼 */}
                      {isDevMode && DEV_TRIGGER_MAP[routine.id] && (
                        <div className="space-y-2 rounded-md border border-dashed border-amber-500/40 bg-amber-500/5 p-3 md:col-span-2">
                          <div className="text-xs font-medium text-muted-foreground">DEV 재트리거</div>
                          <div className="text-xs text-muted-foreground">
                            {routine.id === "wakeup" && "웨이크업 루틴을 즉시 수동으로 트리거합니다."}
                            {routine.id === "schedule" && "스케줄 루틴을 즉시 수동으로 트리거합니다."}
                            {routine.id === "shutdown" && "종료 루틴을 즉시 수동으로 트리거합니다."}
                          </div>
                          <div className="flex justify-end">
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={devTriggerBusy}
                              onClick={() => void handleDevTrigger(routine.id)}
                            >
                              {devTriggerBusy
                                ? DEV_TRIGGER_MAP[routine.id].busyLabel
                                : DEV_TRIGGER_MAP[routine.id].label}
                            </Button>
                          </div>
                        </div>
                      )}

                      {/* 스케줄 엔트리 리스트 (schedule 루틴) */}
                      {routine.scheduleEntries !== undefined && (
                        <div className="space-y-3 md:col-span-2">
                          <div className="space-y-1">
                            <div className="text-xs font-medium text-muted-foreground">스케줄 엔트리</div>
                            <div className="text-xs text-muted-foreground">
                              최대 {MAX_SCHEDULE_ENTRIES}개까지 등록할 수 있습니다. 각 엔트리는 agent와 cron 스케줄을 따로 가집니다.
                            </div>
                          </div>

                          {/* 엔트리 리스트 */}
                          <div className="space-y-3">
                            {entries.map((entry, idx) => (
                              <ScheduleEntryItem
                                key={entry.id}
                                entry={entry}
                                index={idx}
                                totalCount={entries.length}
                                onUpdate={(updated) => updateEntry(routine.id, entries, updated)}
                                onRemove={() => removeEntry(routine.id, entries, entry.id)}
                              />
                            ))}
                          </div>

                          {/* 하단: 추가 버튼 + 유효성 + 저장 */}
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge variant="outline">{entries.length}/{MAX_SCHEDULE_ENTRIES} 등록</Badge>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={entries.length >= MAX_SCHEDULE_ENTRIES}
                              onClick={() =>
                                setScheduleEntryDrafts((cur) => ({
                                  ...cur,
                                  [routine.id]: [...entries, createDefaultScheduleEntry(entries.length)],
                                }))
                              }
                            >
                              + 엔트리 추가
                            </Button>
                            <Badge
                              variant="outline"
                              className={isValidScheduleEntries(entries) ? undefined : "border-destructive/50 text-destructive"}
                            >
                              {isValidScheduleEntries(entries) ? "유효한 설정" : "유효하지 않은 스케줄 설정"}
                            </Badge>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={!isValidScheduleEntries(entries)}
                              onClick={() => void updateRoutine(routine.id, { scheduleEntries: entries })}
                            >
                              저장
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* 루틴 대화 목록 */}
                  <div className="mt-4 space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="text-xs font-medium text-muted-foreground">루틴 대화</div>
                      <Badge variant="outline">{routine.sessionCount}개</Badge>
                    </div>
                    {routine.sessions.length === 0 ? (
                      <div className="rounded-md border border-dashed px-3 py-4 text-sm text-muted-foreground">
                        아직 이 루틴에 연결된 대화가 없습니다.
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {routine.sessions.map((session) => (
                          <button
                            key={session.id}
                            className="flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-sm hover:bg-muted"
                            onClick={async () => {
                              await onJumpToSession(session.id);
                              onActivateHome();
                            }}
                          >
                            <div className="min-w-0">
                              <div className="truncate font-medium">{session.title}</div>
                              <div className="text-xs text-muted-foreground">
                                {new Date(session.modifiedAt).toLocaleString("ko-KR")}
                              </div>
                            </div>
                            <span className="font-mono text-[11px] text-muted-foreground">
                              #{session.id.slice(0, 8)}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
