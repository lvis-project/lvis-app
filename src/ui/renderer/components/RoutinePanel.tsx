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
  DEFAULT_WAKEUP_PROMPT,
  HEARTBEAT_AGENT_OPTIONS,
  MAX_HEARTBEAT_ENTRIES,
  createDefaultHeartbeatEntry,
  getDefaultHeartbeatPrompt,
  heartbeatScheduleToCron,
  isValidHeartbeatEntries,
  type HeartbeatEntry,
} from "../../../routines/schedule.js";

export interface RoutinePanelProps {
  api: LvisApi;
  onActivateHome: () => void;
  onJumpToSession: (sessionId: string) => void | Promise<void>;
  onStartRoutineSession: (routineId: string) => Promise<void>;
}

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

export function RoutinePanel({
  api,
  onActivateHome,
  onJumpToSession,
  onStartRoutineSession,
}: RoutinePanelProps) {
  const isDevMode = window.lvis?.env?.isDev === true;
  const [routines, setRoutines] = useState<RoutineRecord[]>([]);
  const [draftTimes, setDraftTimes] = useState<Record<string, string>>({});
  const [contextPromptDrafts, setContextPromptDrafts] = useState<Record<string, string>>({});
  const [heartbeatDrafts, setHeartbeatDrafts] = useState<Record<string, HeartbeatEntry[]>>({});
  const [devResetBusy, setDevResetBusy] = useState(false);

  const refresh = useCallback(async () => {
    const next = await api.listRoutines();
    setRoutines(next);
    setDraftTimes((current) => {
      const merged = { ...current };
      for (const routine of next) {
        if (routine.scheduleTimeKst && !merged[routine.id]) {
          merged[routine.id] = routine.scheduleTimeKst;
        }
      }
      return merged;
    });
    setHeartbeatDrafts((current) => {
      const merged = { ...current };
      for (const routine of next) {
        if (routine.heartbeatEntries && !merged[routine.id]) {
          merged[routine.id] = routine.heartbeatEntries.map(({ cron: _cron, ...entry }) => ({
            ...entry,
            schedule: { ...entry.schedule },
          }));
        }
      }
      return merged;
    });
    setContextPromptDrafts((current) => {
      const merged = { ...current };
      for (const routine of next) {
        if (routine.contextPrompt && !merged[routine.id]) {
          merged[routine.id] = routine.contextPrompt;
        }
      }
      return merged;
    });
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const enabledCount = useMemo(
    () => routines.filter((routine) => routine.enabled).length,
    [routines],
  );

  const updateRoutine = useCallback(
    async (
      routineId: string,
        patch: {
          enabled?: boolean;
          scheduleTimeKst?: string;
          contextPrompt?: string;
          postTurnEnabled?: boolean;
          heartbeatEntries?: HeartbeatEntry[];
        },
    ) => {
      await api.updateRoutine(routineId, patch);
      await refresh();
    },
    [api, refresh],
  );

  const heartbeatEntriesFor = useCallback(
    (routine: RoutineRecord) =>
      heartbeatDrafts[routine.id] ??
      routine.heartbeatEntries?.map(({ cron: _cron, ...entry }) => ({
        ...entry,
        schedule: { ...entry.schedule },
      })) ??
      [createDefaultHeartbeatEntry(0)],
    [heartbeatDrafts],
  );

  const defaultContextPromptFor = useCallback((routineId: string) => {
    switch (routineId) {
      case "daily-briefing":
        return DEFAULT_WAKEUP_PROMPT;
      case "shutdown-summary":
        return DEFAULT_SHUTDOWN_PROMPT;
      default:
        return "";
    }
  }, []);

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
            {routines.map((routine) => (
              <div key={routine.id} className="rounded-lg border p-4">
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

                {routine.scheduleTimeKst !== undefined || routine.contextPrompt !== undefined || routine.heartbeatEntries !== undefined || routine.postTurnEnabled !== undefined ? (
                  <div className="mt-4 grid gap-3 rounded-md bg-muted/40 p-3 md:grid-cols-2">
                    {routine.scheduleTimeKst !== undefined ? (
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-muted-foreground">예약 시각 (KST)</div>
                        <div className="flex items-center gap-2">
                          <Input
                            type="time"
                            value={draftTimes[routine.id] ?? routine.scheduleTimeKst ?? ""}
                            onChange={(event) =>
                              setDraftTimes((current) => ({ ...current, [routine.id]: event.target.value }))
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
                    ) : null}
                    {routine.contextPrompt !== undefined ? (
                      <label className="space-y-1 md:col-span-2">
                        <div className="flex items-center justify-between gap-2">
                          <div className="text-xs font-medium text-muted-foreground">LLM 컨텍스트 요구사항</div>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              setContextPromptDrafts((current) => ({
                                ...current,
                                [routine.id]: defaultContextPromptFor(routine.id),
                              }))
                            }
                          >
                            예시 복원
                          </Button>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          예시 문장을 바탕으로, 시작 브리핑이나 종료 요약에 필요한 맥락을 자연어로 자유롭게 적을 수 있습니다.
                        </div>
                        <Textarea
                          value={contextPromptDrafts[routine.id] ?? routine.contextPrompt}
                          onChange={(event) =>
                            setContextPromptDrafts((current) => ({
                              ...current,
                              [routine.id]: event.target.value,
                            }))
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
                    ) : null}
                    {isDevMode && routine.id === "daily-briefing" ? (
                      <div className="space-y-2 rounded-md border border-dashed border-amber-500/40 bg-amber-500/5 p-3 md:col-span-2">
                        <div className="text-xs font-medium text-muted-foreground">DEV 재트리거</div>
                        <div className="text-xs text-muted-foreground">
                          오늘 이미 온 브리핑, dismiss, snooze 상태를 초기화하고 같은 Routine 경로로 즉시 다시 생성합니다.
                        </div>
                        <div className="flex justify-end">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={devResetBusy}
                            onClick={async () => {
                              setDevResetBusy(true);
                              try {
                                const result = await api.resetDailyBriefingDev();
                                await refresh();
                                if (result.ok && result.generated) {
                                  onActivateHome();
                                }
                              } finally {
                                setDevResetBusy(false);
                              }
                            }}
                          >
                            {devResetBusy ? "재생성 중..." : "오늘 브리핑 상태 초기화 후 지금 다시 보내기"}
                          </Button>
                        </div>
                      </div>
                    ) : null}
                    {routine.heartbeatEntries !== undefined ? (
                      <div className="space-y-3 md:col-span-2">
                        <div className="space-y-1">
                          <div className="text-xs font-medium text-muted-foreground">하트비트 스케줄</div>
                          <div className="text-xs text-muted-foreground">
                            최대 5개까지 등록할 수 있습니다. 각 하트비트는 agent와 cron 스케줄을 따로 가집니다.
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="outline">{heartbeatEntriesFor(routine).length}/{MAX_HEARTBEAT_ENTRIES} 등록</Badge>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={heartbeatEntriesFor(routine).length >= MAX_HEARTBEAT_ENTRIES}
                            onClick={() =>
                              setHeartbeatDrafts((current) => ({
                                ...current,
                                [routine.id]: [...heartbeatEntriesFor(routine), createDefaultHeartbeatEntry(heartbeatEntriesFor(routine).length)],
                              }))
                            }
                          >
                            하트비트 추가
                          </Button>
                        </div>
                        <div className="space-y-3">
                          {heartbeatEntriesFor(routine).map((entry, index) => (
                            <div key={entry.id} className="rounded-md border bg-background/60 p-3">
                              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                                <div>
                                  <div className="text-sm font-medium">Heartbeat {index + 1}</div>
                                  <div className="text-xs text-muted-foreground">{entry.id}</div>
                                </div>
                                <div className="flex items-center gap-2">
                                  <SwitchRow
                                    checked={entry.enabled}
                                    label="개별 활성화"
                                    onToggle={() =>
                                      setHeartbeatDrafts((current) => ({
                                        ...current,
                                        [routine.id]: heartbeatEntriesFor(routine).map((candidate) =>
                                          candidate.id === entry.id ? { ...candidate, enabled: !candidate.enabled } : candidate
                                        ),
                                      }))
                                    }
                                  />
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={heartbeatEntriesFor(routine).length <= 1}
                                    onClick={() =>
                                      setHeartbeatDrafts((current) => ({
                                        ...current,
                                        [routine.id]: heartbeatEntriesFor(routine).filter((candidate) => candidate.id !== entry.id),
                                      }))
                                    }
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
                                     onChange={(event) =>
                                       setHeartbeatDrafts((current) => ({
                                         ...current,
                                         [routine.id]: heartbeatEntriesFor(routine).map((candidate) =>
                                            candidate.id === entry.id
                                            ? (() => {
                                              const nextAgentId = event.target.value as HeartbeatEntry["agentId"];
                                              const shouldResetPrompt =
                                                candidate.prompt.trim().length === 0 ||
                                                candidate.prompt === getDefaultHeartbeatPrompt(candidate.agentId);
                                              return {
                                                ...candidate,
                                                agentId: nextAgentId,
                                                prompt: shouldResetPrompt
                                                  ? getDefaultHeartbeatPrompt(nextAgentId)
                                                  : candidate.prompt,
                                              };
                                            })()
                                             : candidate
                                         ),
                                       }))
                                     }
                                   >
                                    {HEARTBEAT_AGENT_OPTIONS.map((option) => (
                                      <option key={option.id} value={option.id}>
                                        {option.label} - {option.description}
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
                                    onClick={() =>
                                      setHeartbeatDrafts((current) => ({
                                        ...current,
                                        [routine.id]: heartbeatEntriesFor(routine).map((candidate) =>
                                          candidate.id === entry.id
                                            ? { ...candidate, prompt: getDefaultHeartbeatPrompt(candidate.agentId) }
                                            : candidate
                                        ),
                                      }))
                                    }
                                  >
                                    기본 포맷 복원
                                  </Button>
                                </div>
                                <div className="text-xs text-muted-foreground">
                                  기본 포맷을 바탕으로, 원하는 요구사항을 자연어로 자유롭게 수정할 수 있습니다.
                                </div>
                                <Textarea
                                  value={entry.prompt}
                                  onChange={(event) =>
                                    setHeartbeatDrafts((current) => ({
                                      ...current,
                                      [routine.id]: heartbeatEntriesFor(routine).map((candidate) =>
                                        candidate.id === entry.id
                                          ? { ...candidate, prompt: event.target.value }
                                          : candidate
                                      ),
                                    }))
                                  }
                                  rows={4}
                                />
                              </label>
                              <div className="mb-3 flex flex-wrap gap-2">
                                {[
                                  { label: "5분", value: { minute: "*/5", hour: "*", dayOfMonth: "*", month: "*", dayOfWeek: "*" } },
                                  { label: "15분", value: { minute: "*/15", hour: "*", dayOfMonth: "*", month: "*", dayOfWeek: "*" } },
                                  { label: "30분", value: { minute: "*/30", hour: "*", dayOfMonth: "*", month: "*", dayOfWeek: "*" } },
                                  { label: "평일 업무시간", value: { minute: "0", hour: "9-18", dayOfMonth: "*", month: "*", dayOfWeek: "1-5" } },
                                ].map((preset) => (
                                  <Button
                                    key={preset.label}
                                    size="sm"
                                    variant="outline"
                                    onClick={() =>
                                      setHeartbeatDrafts((current) => ({
                                        ...current,
                                        [routine.id]: heartbeatEntriesFor(routine).map((candidate) =>
                                          candidate.id === entry.id ? { ...candidate, schedule: preset.value } : candidate
                                        ),
                                      }))
                                    }
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
                                      onChange={(event) =>
                                        setHeartbeatDrafts((current) => ({
                                          ...current,
                                          [routine.id]: heartbeatEntriesFor(routine).map((candidate) =>
                                            candidate.id === entry.id
                                              ? {
                                                ...candidate,
                                                schedule: { ...candidate.schedule, [field]: event.target.value },
                                              }
                                              : candidate
                                          ),
                                        }))
                                      }
                                      placeholder={placeholder}
                                    />
                                  </label>
                                ))}
                              </div>
                              <div className="mt-3">
                                <Badge variant="outline">{heartbeatScheduleToCron(entry.schedule)}</Badge>
                              </div>
                            </div>
                          ))}
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge
                            variant="outline"
                            className={isValidHeartbeatEntries(heartbeatEntriesFor(routine)) ? undefined : "border-destructive/50 text-destructive"}
                          >
                            {isValidHeartbeatEntries(heartbeatEntriesFor(routine)) ? "유효한 설정" : "유효하지 않은 heartbeat 설정"}
                          </Badge>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={!isValidHeartbeatEntries(heartbeatEntriesFor(routine))}
                            onClick={() =>
                              void updateRoutine(routine.id, {
                                heartbeatEntries: heartbeatEntriesFor(routine),
                              })
                            }
                          >
                            저장
                          </Button>
                        </div>
                      </div>
                    ) : null}
                    {routine.postTurnEnabled !== undefined ? (
                      <SwitchRow
                        checked={routine.postTurnEnabled}
                        label="대화 후 브리핑"
                        description="루틴 대화가 끝난 뒤 브리핑을 자동으로 생성합니다."
                        onToggle={() => void updateRoutine(routine.id, { postTurnEnabled: !routine.postTurnEnabled })}
                      />
                    ) : null}
                  </div>
                ) : null}

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
            ))}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
