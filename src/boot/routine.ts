/**
 * Boot §4.2 Step 6 — Routine runtime wiring.
 */
import type { PluginRuntime } from "../plugins/runtime.js";
import type { TaskService } from "../taskService.js";
import type { ConversationLoopDeps } from "../engine/conversation-loop.js";
import { ConversationLoop } from "../engine/conversation-loop.js";
import { RoutineEngine } from "../core/routine-engine.js";
import {
  RoutineTriggerCoordinator,
  createIdleSignal,
  createScheduleSignal,
  createPostTurnSignal,
  type RoutineCompletedCallback,
} from "../core/routine-trigger-coordinator.js";
import { findMethodByCapability } from "./plugins.js";
import type { UpcomingEvent } from "../core/routine-trigger-coordinator.js";

export function createRoutineEngine(opts: {
  createConversationLoop: () => ConversationLoop;
}): RoutineEngine {
  return new RoutineEngine({
    createConversationLoop: opts.createConversationLoop,
  });
}

/**
 * Sprint 3-A-2: wire RoutineTriggerCoordinator with wakeup/schedule signals.
 */
export function createRoutineTriggerCoordinator(opts: {
  routineEngine: RoutineEngine;
  taskService: TaskService;
  pluginRuntime: PluginRuntime;
  isIdleScanActive: () => boolean;
  isScheduleEnabled: () => boolean;
  isPostTurnEnabled?: () => boolean;
  getScheduleTimeKst?: () => string;
  getScheduleLastFiredDayKey: () => string | undefined;
  setScheduleLastFiredDayKey: (key: string) => void;
  /** Wakeup routine prePrompt provider — see RoutineTriggerCoordinator deps. */
  getWakeupPrompt: () => string;
  postTurnCooldownMs?: number;
  logger?: (msg: string) => void;
  onRoutineCompleted?: RoutineCompletedCallback;
}): RoutineTriggerCoordinator {
  let cachedEvents: UpcomingEvent[] = [];
  let postTurnLastFiredAt = 0;

  const calendarListMethod = findMethodByCapability(
    opts.pluginRuntime,
    "calendar-source",
    (m) => m.endsWith("_list") || m.endsWith("_today"),
  );

  const refreshEvents = (): void => {
    if (!calendarListMethod) return;
    opts.pluginRuntime
      .call(calendarListMethod, {})
      .then((r: unknown) => {
        if (Array.isArray(r)) cachedEvents = r as UpcomingEvent[];
      })
      .catch(() => { /* non-fatal */ });
  };
  refreshEvents();

  const coordinator = new RoutineTriggerCoordinator({
    routineEngine: opts.routineEngine,
    getWakeupPrompt: opts.getWakeupPrompt,
    logger: opts.logger,
    onRoutineCompleted: opts.onRoutineCompleted,
    evaluators: [
      createIdleSignal(opts.isIdleScanActive),
      createScheduleSignal({
        getHhmmKst: opts.getScheduleTimeKst,
        isEnabled: opts.isScheduleEnabled,
        getLastFiredDayKey: opts.getScheduleLastFiredDayKey,
        setLastFiredDayKey: opts.setScheduleLastFiredDayKey,
      }),
      createPostTurnSignal({
        getCooldownMs: () => opts.postTurnCooldownMs ?? 600_000,
        getLastFiredAt: () => postTurnLastFiredAt,
        setLastFiredAt: (ts) => { postTurnLastFiredAt = ts; },
        isEnabled: opts.isPostTurnEnabled ?? opts.isScheduleEnabled,
      }),
    ],
  });

  return coordinator;
}
