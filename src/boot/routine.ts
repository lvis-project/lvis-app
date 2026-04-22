/**
 * Boot §4.2 Step 6 — generic RoutineEngine wiring.
 */
import type { PluginRuntime } from "../plugins/runtime.js";
import type { TaskService } from "../taskService.js";
import type { MemoryManager } from "../memory/memory-manager.js";
import type { AuditLogger } from "../audit/audit-logger.js";
import { RoutineEngine } from "../core/routine-engine.js";
import {
  RoutineTriggerCoordinator,
  createIdleSignal,
  createScheduleSignal,
  createMeetingSignal,
  createTaskDeadlineSignal,
  createPostTurnSignal,
  type UpcomingEvent,
} from "../core/routine-trigger-coordinator.js";
import {
  registerManifestEventSubscriptions,
} from "./plugins.js";

export function createRoutineEngine(opts: {
  taskService: TaskService;
  memoryManager: MemoryManager;
  pluginRuntime: PluginRuntime;
  // Sprint 2-D: Daily Briefing gating deps — feature flag, LLM caller,
  // date persistence, dismissal state. All optional so the split helper
  // remains usable in contexts where briefing is disabled.
  isDailyBriefingEnabled?: () => boolean;
  callLlm?: (prompt: string, opts?: { maxTokens?: number; systemPrompt?: string }) => Promise<string>;
  getLastBriefingDate?: () => string | undefined;
  setLastBriefingDate?: (dateKst: string) => void;
  getLastDismissedAt?: () => string | undefined;
  /** M4: audit sink for plugin subscription capability violations. */
  auditLogger?: Pick<AuditLogger, "log">;
}): RoutineEngine {
  const {
    taskService, memoryManager, pluginRuntime,
    isDailyBriefingEnabled, callLlm,
    getLastBriefingDate, setLastBriefingDate, getLastDismissedAt,
    auditLogger,
  } = opts;
  const routineEngine = new RoutineEngine({
    getTaskSummary: () => taskService.getPendingByPriority().map((t) => ({
      title: t.title, priority: t.priority, status: t.status,
      dueAt: t.dueAt ?? undefined, source: t.source,
    })),
    getRecentNotes: () => memoryManager.listNotes().slice(0, 5),
    getRecentSessions: () => memoryManager.listSessions().slice(0, 5),
    // Sprint 3-A: user voice tone hint — note titles only (deterministic).
    getRecentMemoryExcerpts: () => memoryManager.listNotes().slice(0, 3).map((n) => n.title),
    isDailyBriefingEnabled,
    callLlm,
    getLastBriefingDate,
    setLastBriefingDate,
    getLastDismissedAt,
    // Sprint E §2 — 최근 브리핑 피드백 (dismiss 사유). 파일 부재 시 빈 배열.
    getRecentBriefingFeedback: () => {
      try { return memoryManager.readRecentBriefingFeedback(5); }
      catch { return []; }
    },
  });
  // 이벤트 버스 → RoutineEngine 연동 (normalized routine.* only)
  registerManifestEventSubscriptions(pluginRuntime, routineEngine, auditLogger);

  return routineEngine;
}

/** 오늘 일정 초기 로드 (calendar-source capability 플러그인에서 *_today 메서드 자동 탐색) */
/**
 * Sprint 3-A-2: wire RoutineTriggerCoordinator with 4 default signals.
 * Flag default OFF — scheduleSignal only fires when `isEnabled()` returns true.
 * Meeting signals are derived from the RoutineEngine's normalized calendar cache.
 */
export function createRoutineTriggerCoordinator(opts: {
  routineEngine?: RoutineEngine;
  /** @deprecated compatibility alias for older callers. */
  proactiveEngine?: RoutineEngine;
  taskService: TaskService;
  pluginRuntime: PluginRuntime;
  isIdleScanActive: () => boolean;
  isScheduleEnabled: () => boolean;
  /**
   * Issue 3 fix: post-turn briefing flag separate from schedule flag.
   * When absent, falls back to isScheduleEnabled for back-compat.
   */
  isPostTurnEnabled?: () => boolean;
  getScheduleTimeKst?: () => string;
  getScheduleLastFiredDayKey: () => string | undefined;
  setScheduleLastFiredDayKey: (key: string) => void;
  /** Post-turn signal cooldown in ms. Default 600_000 (10 min). */
  postTurnCooldownMs?: number;
  now?: () => Date;
  logger?: (msg: string) => void;
}): RoutineTriggerCoordinator {
  const meetingShown = new Set<string>();
  const taskShown = new Set<string>();
  let postTurnLastFiredAt = 0;
  const routineEngine = opts.routineEngine ?? opts.proactiveEngine;

  const coordinator = new RoutineTriggerCoordinator({
    routineEngine,
    now: opts.now,
    logger: opts.logger,
    evaluators: [
      createIdleSignal(opts.isIdleScanActive),
      createScheduleSignal({
        hhmmKst: opts.getScheduleTimeKst?.() ?? "08:30",
        isEnabled: opts.isScheduleEnabled,
        getLastFiredDayKey: opts.getScheduleLastFiredDayKey,
        setLastFiredDayKey: opts.setScheduleLastFiredDayKey,
      }),
      createMeetingSignal({
        getEvents: () => {
          const engine = opts.routineEngine ?? opts.proactiveEngine;
          if (!engine) return [];
          return engine.getCalendarEvents().map(
            (event): UpcomingEvent => ({
              subject: event.subject,
              start: event.start,
              end: event.end,
              isAllDay: event.isAllDay,
            }),
          );
        },
        getShownSet: () => meetingShown,
      }),
      createTaskDeadlineSignal({
        getTasks: () => opts.taskService.getPendingByPriority().map((t) => ({
          id: t.id, title: t.title, status: t.status, dueAt: t.dueAt ?? undefined,
        })),
        getShownSet: () => taskShown,
      }),
      createPostTurnSignal({
        getCooldownMs: () => opts.postTurnCooldownMs ?? 600_000,
        getLastFiredAt: () => postTurnLastFiredAt,
        setLastFiredAt: (ts) => { postTurnLastFiredAt = ts; },
        // Issue 3 fix: use dedicated post-turn flag; fall back to schedule flag.
        isEnabled: opts.isPostTurnEnabled ?? opts.isScheduleEnabled,
      }),
    ],
  });

  return coordinator;
}

export {
  createRoutineEngine as createProactiveEngine,
  createRoutineTriggerCoordinator as createProactiveTriggerCoordinator,
};
