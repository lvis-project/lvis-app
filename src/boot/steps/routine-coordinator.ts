/**
 * Boot §4.2 Step 6 — Routine coordinator wiring.
 *
 * Builds the RoutineTriggerCoordinator, starts it, and (when idleScheduler
 * is present) installs the composite idle-state listener that fans IDLE_SCAN
 * into both (a) direct briefing generation and (b) the coordinator's
 * `idle-scan` notifier. Extracted from boot.ts for readability.
 */
import type { BrowserWindow } from "electron";
import type { PluginRuntime } from "../../plugins/runtime.js";
import type { TaskService } from "../../taskService.js";
import type { SettingsService } from "../../data/settings-store.js";
import type { Briefing, RoutineEngine } from "../../core/routine-engine.js";
import type { MemoryManager } from "../../memory/memory-manager.js";
import type { IdleSchedulerService, IdleState } from "../../main/idle-scheduler.js";
import { createRoutineTriggerCoordinator } from "../routine.js";
import {
  getKstMinuteKey,
  matchesHeartbeatSchedule,
  normalizeHeartbeatEntries,
} from "../../routines/schedule.js";
import { deliverRoutineBriefing } from "../../routines/briefing-delivery.js";

export interface WireRoutineCoordinatorInput {
  routineEngine: RoutineEngine;
  taskService: TaskService;
  pluginRuntime: PluginRuntime;
  settingsService: SettingsService;
  memoryManager: MemoryManager;
  idleScheduler: IdleSchedulerService | undefined;
  mainWindow: BrowserWindow;
}

export interface WiredRoutineCoordinator {
  notify(event: string): void;
  dispose(): void;
}

export function wireRoutineCoordinator(input: WireRoutineCoordinatorInput): WiredRoutineCoordinator {
  const { routineEngine, taskService, pluginRuntime, settingsService, memoryManager, idleScheduler, mainWindow } = input;

  let proactiveScheduleLastDay: string | undefined;
  const heartbeatLastMinuteKeyByEntry = new Map<string, string>();
  const sendRoutineBriefing = async (briefing: Briefing): Promise<void> => {
    await deliverRoutineBriefing(mainWindow, memoryManager, briefing).catch((e: Error) => {
      console.warn("[lvis] boot: briefing session persist failed:", e.message);
    });
  };
  const routineCoordinator = createRoutineTriggerCoordinator({
    routineEngine,
    taskService,
    pluginRuntime,
    isIdleScanActive: () => idleScheduler?.getState() === "IDLE_SCAN",
    isScheduleEnabled: () =>
      settingsService.get("routine")?.enableDailyBriefing ?? false,
    getScheduleTimeKst: () =>
      settingsService.get("routine")?.scheduleTimeKst ?? "08:30",
    isPostTurnEnabled: () =>
      settingsService.get("routine")?.enablePostTurnBriefing ?? false,
    onBriefingGenerated: sendRoutineBriefing,
    getScheduleLastFiredDayKey: () => proactiveScheduleLastDay,
    setScheduleLastFiredDayKey: (key) => { proactiveScheduleLastDay = key; },
  });
  routineCoordinator.start();

  const maybeRunHeartbeat = () => {
    const routineSettings = settingsService.get("routine");
    if (!(routineSettings?.enableHeartbeat ?? true)) return;
    const now = new Date();
    const minuteKey = getKstMinuteKey(now);
    const entries = normalizeHeartbeatEntries(routineSettings?.heartbeatEntries);
    const activeIds = new Set(entries.map((entry) => entry.id));
    for (const knownId of heartbeatLastMinuteKeyByEntry.keys()) {
      if (!activeIds.has(knownId)) heartbeatLastMinuteKeyByEntry.delete(knownId);
    }
    for (const entry of entries) {
      if (!entry.enabled) continue;
      if (heartbeatLastMinuteKeyByEntry.get(entry.id) === minuteKey) continue;
      if (!matchesHeartbeatSchedule(entry.schedule, now)) continue;
      heartbeatLastMinuteKeyByEntry.set(entry.id, minuteKey);
      void routineEngine.runHeartbeatRoutine(now, entry);
    }
  };

  const heartbeatTimer = setInterval(maybeRunHeartbeat, 60_000);
  heartbeatTimer.unref?.();
  maybeRunHeartbeat();

  let compositeListenerInstalled = false;

  if (idleScheduler) {
    const existing = idleScheduler;
    const notifyCoordinator = (state: IdleState) => {
      if (state === "IDLE_SCAN") routineCoordinator.notify("idle-scan");
    };
    // setStateChangeListener accepts only one listener; this `composite` IS the
    // idle-scheduler wiring for routine execution — fans IDLE_SCAN into direct briefing
    // generation + the coordinator notifier.
    const composite = (
      newState: IdleState,
      oldState: IdleState,
      reason: string,
    ): void => {
      if (newState === "IDLE_SCAN" && !routineCoordinator.isWithinGlobalCooldown()) {
        routineEngine
          .generateDailyBriefing({ idleState: "long_idle" })
          .then((r) => {
            if (r.status === "generated") {
              void sendRoutineBriefing(r.briefing);
            }
          })
          .catch((e: Error) =>
            console.warn("[lvis] boot: daily briefing trigger failed (non-fatal):", e.message),
          );
        maybeRunHeartbeat();
      }
      notifyCoordinator(newState);
      void oldState; void reason;
    };
    existing.setStateChangeListener(composite);
    compositeListenerInstalled = true;
  }

  return {
    notify: (event: string) => routineCoordinator.notify(event),
    dispose: () => {
      clearInterval(heartbeatTimer);
      if (compositeListenerInstalled) {
        idleScheduler?.setStateChangeListener(null);
      }
    },
  };
}
