/**
 * Boot §4.2 Step 6 — Proactive Engine + calendar 초기 로드.
 */
import type { PluginRuntime } from "../plugins/runtime.js";
import type { TaskService } from "../taskService.js";
import type { MemoryManager } from "../memory/memory-manager.js";
import type { AuditLogger } from "../audit/audit-logger.js";
import { ProactiveEngine } from "../core/proactive-engine.js";
import {
  ProactiveTriggerCoordinator,
  createIdleSignal,
  createScheduleSignal,
  createMeetingSignal,
  createTaskDeadlineSignal,
  type UpcomingEvent,
} from "../core/proactive-trigger-coordinator.js";
import {
  buildManifestEventHints,
  findMethodByCapability,
  registerManifestEventSubscriptions,
} from "./plugins.js";

export function createProactiveEngine(opts: {
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
}): ProactiveEngine {
  const {
    taskService, memoryManager, pluginRuntime,
    isDailyBriefingEnabled, callLlm,
    getLastBriefingDate, setLastBriefingDate, getLastDismissedAt,
    auditLogger,
  } = opts;
  const proactiveEngine = new ProactiveEngine({
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
  proactiveEngine.setEventHints(buildManifestEventHints(pluginRuntime));

  // 이벤트 버스 → Proactive Engine 연동 (manifest.eventSubscriptions 선언 기반)
  registerManifestEventSubscriptions(pluginRuntime, proactiveEngine, auditLogger);

  return proactiveEngine;
}

/** 오늘 일정 초기 로드 (calendar-source capability 플러그인에서 *_today 메서드 자동 탐색) */
export function loadCalendarToday(
  pluginRuntime: PluginRuntime,
  proactiveEngine: ProactiveEngine,
): void {
  const calendarTodayMethod = findMethodByCapability(
    pluginRuntime,
    "calendar-source",
    (method) => method.endsWith("_today"),
  );
  if (calendarTodayMethod) {
    pluginRuntime.call(calendarTodayMethod, {})
      .then((events: unknown) => {
        if (Array.isArray(events)) {
          proactiveEngine.updateCalendarEvents(events as import("../core/proactive-engine.js").CachedCalendarEvent[]);
          console.log(`[lvis] boot: calendar today loaded (${events.length}건)`);
        }
      })
      .catch((e: Error) => console.log("[lvis] boot: calendar today load failed (non-fatal):", e.message));
  }
}

/**
 * Sprint 3-A-2: wire ProactiveTriggerCoordinator with 4 default signals.
 * Flag default OFF — scheduleSignal only fires when `isEnabled()` returns true.
 * Calendar events are fetched via capability lookup (NO plugin-id hardcoding).
 */
export function createProactiveTriggerCoordinator(opts: {
  proactiveEngine: ProactiveEngine;
  taskService: TaskService;
  pluginRuntime: PluginRuntime;
  isIdleScanActive: () => boolean;
  isScheduleEnabled: () => boolean;
  getScheduleTimeKst?: () => string;
  getScheduleLastFiredDayKey: () => string | undefined;
  setScheduleLastFiredDayKey: (key: string) => void;
  logger?: (msg: string) => void;
}): ProactiveTriggerCoordinator {
  const meetingShown = new Set<string>();
  const taskShown = new Set<string>();
  let cachedEvents: UpcomingEvent[] = [];

  const calendarListMethod = findMethodByCapability(
    opts.pluginRuntime,
    "calendar-source",
    (m) => m.endsWith("_list") || m.endsWith("_today"),
  );

  // Refresh calendar events opportunistically; swallow errors.
  const refreshEvents = (): void => {
    if (!calendarListMethod) return;
    opts.pluginRuntime
      .call(calendarListMethod, {})
      .then((r: unknown) => {
        if (Array.isArray(r)) cachedEvents = r as UpcomingEvent[];
      })
      .catch(() => {
        /* non-fatal */
      });
  };
  refreshEvents();

  const coordinator = new ProactiveTriggerCoordinator({
    proactiveEngine: opts.proactiveEngine,
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
          refreshEvents();
          return cachedEvents;
        },
        getShownSet: () => meetingShown,
      }),
      createTaskDeadlineSignal({
        getTasks: () => opts.taskService.getPendingByPriority().map((t) => ({
          id: t.id, title: t.title, status: t.status, dueAt: t.dueAt ?? undefined,
        })),
        getShownSet: () => taskShown,
      }),
    ],
  });

  return coordinator;
}

/** Feature 4: 월요일 주간 일정 캐시 로드 (KST 기준) */
export function loadWeeklyCalendarIfMonday(
  pluginRuntime: PluginRuntime,
  proactiveEngine: ProactiveEngine,
): void {
  const isMonday = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", weekday: "short" }).format(new Date()) === "Mon";
  const calendarListMethod = findMethodByCapability(
    pluginRuntime, "calendar-source", (m) => m.endsWith("_list"),
  );
  if (isMonday && calendarListMethod) {
    pluginRuntime.call(calendarListMethod, { days: 7 })
      .then((events: unknown) => {
        if (Array.isArray(events)) {
          proactiveEngine.updateCalendarEvents(events as import("../core/proactive-engine.js").CachedCalendarEvent[]);
          console.log(`[lvis] boot: weekly calendar loaded (${events.length}건, 월요일 모드)`);
        }
      })
      .catch((e: Error) => console.log("[lvis] boot: weekly calendar load failed (non-fatal):", e.message));
  }
}
