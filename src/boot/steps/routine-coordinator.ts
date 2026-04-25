/**
 * Boot §4.2 Step 6 — Routine coordinator wiring.
 */
import type { BrowserWindow } from "electron";
import type { PluginRuntime } from "../../plugins/runtime.js";
import type { TaskService } from "../../taskService.js";
import type { SettingsService } from "../../data/settings-store.js";
import type { RoutineEngine, RoutineResult } from "../../core/routine-engine.js";
import type { IdleSchedulerService, IdleState } from "../../main/idle-scheduler.js";
import { createRoutineTriggerCoordinator } from "../routine.js";
import {
  getKstMinuteKey,
  matchesSchedule,
  normalizeScheduleEntries,
} from "../../routines/schedule.js";
import { deliverRoutineResult } from "../../routines/routine-delivery.js";
import { REGISTERED_ROUTINES } from "../../routines/registry.js";

export interface WireRoutineCoordinatorInput {
  routineEngine: RoutineEngine;
  taskService: TaskService;
  pluginRuntime: PluginRuntime;
  settingsService: SettingsService;
  idleScheduler: IdleSchedulerService | undefined;
  mainWindow: BrowserWindow;
}

export interface WiredRoutineCoordinator {
  notify(event: string): void;
  dispose(): void;
}

export function wireRoutineCoordinator(input: WireRoutineCoordinatorInput): WiredRoutineCoordinator {
  const { routineEngine, taskService, pluginRuntime, settingsService, idleScheduler, mainWindow } = input;

  let wakeupScheduleLastDay: string | undefined;
  const scheduleLastMinuteKeyByEntry = new Map<string, string>();

  const onRoutineCompleted = async (result: RoutineResult): Promise<void> => {
    await deliverRoutineResult(mainWindow, result).catch((e: Error) => {
      console.warn("[lvis] boot: routine result persist failed:", e.message);
    });
  };

  const routineCoordinator = createRoutineTriggerCoordinator({
    routineEngine,
    taskService,
    pluginRuntime,
    isIdleScanActive: () => idleScheduler?.getState() === "IDLE_SCAN",
    isScheduleEnabled: () =>
      settingsService.get("routine")?.enableWakeupRoutine ?? false,
    getScheduleTimeKst: () =>
      settingsService.get("routine")?.scheduleTimeKst ?? "08:30",
    onRoutineCompleted,
    getScheduleLastFiredDayKey: () => wakeupScheduleLastDay,
    setScheduleLastFiredDayKey: (key) => { wakeupScheduleLastDay = key; },
  });
  routineCoordinator.start();

  // schedule 루틴: cron 기반 주기 실행
  const maybeRunScheduleRoutines = () => {
    const routineSettings = settingsService.get("routine");
    if (!(routineSettings?.enableScheduleRoutine ?? true)) return;
    const now = new Date();
    const minuteKey = getKstMinuteKey(now);
    const entries = normalizeScheduleEntries(routineSettings?.scheduleEntries);
    const activeIds = new Set(entries.map((e) => e.id));
    for (const knownId of scheduleLastMinuteKeyByEntry.keys()) {
      if (!activeIds.has(knownId)) scheduleLastMinuteKeyByEntry.delete(knownId);
    }
    const scheduleRegistered = REGISTERED_ROUTINES.find((r) => r.id === "schedule");
    if (!scheduleRegistered) return;
    for (const entry of entries) {
      if (!entry.enabled) continue;
      if (scheduleLastMinuteKeyByEntry.get(entry.id) === minuteKey) continue;
      if (!matchesSchedule(entry.schedule, now)) continue;
      scheduleLastMinuteKeyByEntry.set(entry.id, minuteKey);
      void routineEngine
        .runRoutine({ id: entry.id, trigger: "schedule", prePrompt: entry.prompt })
        .then((result) => onRoutineCompleted(result))
        .catch((e: Error) =>
          console.warn("[lvis] boot: schedule routine failed:", e.message),
        );
    }
  };

  const scheduleTimer = setInterval(maybeRunScheduleRoutines, 60_000);
  scheduleTimer.unref?.();
  maybeRunScheduleRoutines();

  let compositeListenerInstalled = false;

  if (idleScheduler) {
    const existing = idleScheduler;
    const composite = (newState: IdleState, _oldState: IdleState, _reason: string): void => {
      if (newState === "IDLE_SCAN" && !routineCoordinator.isWithinGlobalCooldown()) {
        const wakeupRoutine = { id: "wakeup", trigger: "wakeup" as const, prePrompt: "오늘 업무 맥락을 정리해줘." };
        void routineEngine
          .runRoutine(wakeupRoutine)
          .then((result) => onRoutineCompleted(result))
          .catch((e: Error) =>
            console.warn("[lvis] boot: wakeup routine failed:", e.message),
          );
        maybeRunScheduleRoutines();
      }
      if (newState === "IDLE_SCAN") routineCoordinator.notify("idle-scan");
    };
    existing.setStateChangeListener(composite);
    compositeListenerInstalled = true;
  }

  return {
    notify: (event: string) => routineCoordinator.notify(event),
    dispose: () => {
      clearInterval(scheduleTimer);
      if (compositeListenerInstalled) {
        idleScheduler?.setStateChangeListener(null);
      }
      routineCoordinator.stop();
    },
  };
}
