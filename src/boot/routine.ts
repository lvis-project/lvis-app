/**
 * Boot §4.2 Step 6 — Routine runtime + calendar 초기 로드.
 */
import type { PluginRuntime } from "../plugins/runtime.js";
import type { TaskService } from "../taskService.js";
import { RoutineEngine, type Briefing } from "../core/routine-engine.js";
import type { RoutineToolBindings } from "../plugins/types.js";
import {
  RoutineTriggerCoordinator,
  createIdleSignal,
  createScheduleSignal,
  createMeetingSignal,
  createTaskDeadlineSignal,
  createPostTurnSignal,
  type UpcomingEvent,
} from "../core/routine-trigger-coordinator.js";
import { findMethodByCapability } from "./plugins.js";

function resolveRoutineTools(pluginRuntime: PluginRuntime): RoutineToolBindings {
  const providerPluginId = pluginRuntime.findPluginIdByCapability("routine-provider");
  if (!providerPluginId) return {};
  const manifest = pluginRuntime.getPluginManifest(providerPluginId);
  return manifest?.routineTools ?? {};
}

export function createRoutineEngine(opts: {
  taskService?: TaskService;
  memoryManager?: unknown;
  pluginRuntime: PluginRuntime;
  isDailyBriefingEnabled?: () => boolean;
  callLlm?: (prompt: string, opts?: { maxTokens?: number; systemPrompt?: string }) => Promise<string>;
  getLastBriefingDate?: () => string | undefined;
  setLastBriefingDate?: (dateKst: string) => void;
  getLastDismissedAt?: () => string | undefined;
  getDailyBriefingPrompt?: () => string | undefined;
  getShutdownPrompt?: () => string | undefined;
  auditLogger?: unknown;
}): RoutineEngine {
  const {
    pluginRuntime,
    isDailyBriefingEnabled,
    getLastBriefingDate, setLastBriefingDate, getLastDismissedAt, getDailyBriefingPrompt, getShutdownPrompt,
  } = opts;
  const routineTools = resolveRoutineTools(pluginRuntime);
  return new RoutineEngine({
    pluginRuntime,
    memoryManager: opts.memoryManager,
    taskService: opts.taskService,
    isDailyBriefingEnabled,
      getLastBriefingDate,
      setLastBriefingDate,
      getLastDismissedAt,
      getDailyBriefingPrompt,
      getShutdownPrompt,
      dailyBriefingTool: routineTools.dailyBriefing,
    shutdownSummaryTool: routineTools.shutdownSummary,
    heartbeatTool: routineTools.heartbeat,
  });
}

/**
 * Sprint 3-A-2: wire RoutineTriggerCoordinator with 4 default signals.
 * Flag default OFF — scheduleSignal only fires when `isEnabled()` returns true.
 * Calendar events are fetched via capability lookup (NO plugin-id hardcoding).
 */
export function createRoutineTriggerCoordinator(opts: {
  routineEngine: RoutineEngine;
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
  logger?: (msg: string) => void;
  onBriefingGenerated?: (briefing: Briefing) => void | Promise<void>;
}): RoutineTriggerCoordinator {
  const meetingShown = new Set<string>();
  const taskShown = new Set<string>();
  let cachedEvents: UpcomingEvent[] = [];
  let postTurnLastFiredAt = 0;

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

  const coordinator = new RoutineTriggerCoordinator({
    routineEngine: opts.routineEngine,
    logger: opts.logger,
    onBriefingGenerated: opts.onBriefingGenerated,
    evaluators: [
      createIdleSignal(opts.isIdleScanActive),
      createScheduleSignal({
        getHhmmKst: opts.getScheduleTimeKst,
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
