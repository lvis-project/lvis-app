/**
 * Boot §4.2 Step 6 — Routine coordinator wiring.
 *
 * Wires three independent routine triggers:
 *   1. Schedule cron entries (settingsService.routine.scheduleEntries) →
 *      polled every 60s; matching entry fires `schedule` routine with the
 *      entry's prompt.
 *   2. Long-idle entry (sustained user-idle ≥ routineIdleThresholdMs) →
 *      fires `shutdown` routine. Models "user just walked away".
 *   3. Long-idle exit (user returns after ≥ threshold idle) →
 *      fires `wakeup` routine. Models "user just arrived back" (출근 / 점심 후
 *      자리 복귀 등).
 *
 * (Note) The historical IDLE_SCAN composite listener and the polling
 *  `RoutineTriggerCoordinator` (with idleSignal/scheduleSignal/postTurnSignal)
 *  are intentionally removed — IDLE_SCAN entry semantically means "user just
 *  left", which is opposite of what wakeup needs, and postTurnSignal mapped
 *  every chat turn end to wakeup which conflicted with intent.
 */
import type { BrowserWindow } from "electron";
import type { PluginRuntime } from "../../plugins/runtime.js";
import type { TaskService } from "../../taskService.js";
import type { SettingsService } from "../../data/settings-store.js";
import type { RoutineEngine, RoutineResult } from "../../core/routine-engine.js";
import type { PowerMonitorLike } from "../../main/idle-scheduler.js";
import {
  getKstMinuteKey,
  matchesSchedule,
  normalizeScheduleEntries,
} from "../../routines/schedule.js";
import { deliverRoutineResult, notifyRoutineStarted, notifyRoutineFailed } from "../../routines/routine-delivery.js";
import { REGISTERED_ROUTINES, buildRoutineForTrigger } from "../../routines/registry.js";
import { RoutineIdleSignaler } from "../../routines/idle-signaler.js";

export interface WireRoutineCoordinatorInput {
  routineEngine: RoutineEngine;
  taskService: TaskService;
  pluginRuntime: PluginRuntime;
  settingsService: SettingsService;
  /** Electron powerMonitor (or test fake). Optional — Linux/test envs may pass undefined. */
  powerMonitor?: PowerMonitorLike;
  mainWindow: BrowserWindow;
}

export interface WiredRoutineCoordinator {
  /** Force-evaluate cron schedule entries immediately (used by IPC dev trigger). */
  evaluateSchedulesNow(): void;
  dispose(): void;
}

const DEFAULT_ROUTINE_IDLE_THRESHOLD_MS = 10 * 60_000;

export function wireRoutineCoordinator(input: WireRoutineCoordinatorInput): WiredRoutineCoordinator {
  const { routineEngine, settingsService, powerMonitor, mainWindow } = input;

  const scheduleLastMinuteKeyByEntry = new Map<string, string>();

  // Issue #260: notification fire happens INSIDE deliverRoutineResult so all
  // 3 callers (this coordinator, IPC dev-trigger, main.ts shutdown) get the
  // user-facing cue without duplicating wiring. See routine-delivery.ts.
  const onRoutineCompleted = async (result: RoutineResult): Promise<void> => {
    await deliverRoutineResult(mainWindow, result).catch((e: Error) => {
      console.warn("[lvis] boot: routine result persist failed:", e.message);
    });
  };

  // ─── Trigger 1: schedule cron entries ──────────────────────────────────────
  const evaluateSchedulesNow = (): void => {
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
      notifyRoutineStarted(mainWindow, { routineId: entry.id, trigger: "schedule", startedAt: new Date().toISOString() });
      void routineEngine
        .runRoutine({
          id: entry.id,
          trigger: "schedule",
          prePrompt: entry.prompt,
          title: `스케줄 — ${entry.id}`,
        })
        .then((result) => onRoutineCompleted(result))
        .catch((e: Error) => {
          console.warn("[lvis] boot: schedule routine failed:", e.message);
          notifyRoutineFailed(mainWindow, { routineId: entry.id, trigger: "schedule" }, e.message);
        });
    }
  };

  const scheduleTimer = setInterval(evaluateSchedulesNow, 60_000);
  scheduleTimer.unref?.();
  evaluateSchedulesNow();

  // ─── Trigger 2/3: long-idle entry (shutdown) / exit (wakeup) ───────────────
  let idleSignaler: RoutineIdleSignaler | null = null;
  if (powerMonitor) {
    idleSignaler = new RoutineIdleSignaler({
      powerMonitor,
      getLongIdleThresholdMs: () =>
        settingsService.get("routine")?.routineIdleThresholdMs ?? DEFAULT_ROUTINE_IDLE_THRESHOLD_MS,
    });

    idleSignaler.on((event) => {
      const routineSettings = settingsService.get("routine");
      if (event === "idle-long-exit") {
        if (!(routineSettings?.enableWakeupRoutine ?? false)) return;
        const built = buildRoutineForTrigger("wakeup", routineSettings);
        if (!built.ok) return;
        notifyRoutineStarted(mainWindow, { routineId: "wakeup", trigger: "wakeup", startedAt: new Date().toISOString() });
        void routineEngine
          .runRoutine(built.routine)
          .then((result) => onRoutineCompleted(result))
          .catch((e: Error) => {
            console.warn("[lvis] boot: wakeup routine failed:", e.message);
            notifyRoutineFailed(mainWindow, { routineId: "wakeup", trigger: "wakeup" }, e.message);
          });
      } else if (event === "idle-long-entry") {
        if (!(routineSettings?.enableShutdownRoutine ?? true)) return;
        const built = buildRoutineForTrigger("shutdown", routineSettings);
        if (!built.ok) return;
        notifyRoutineStarted(mainWindow, { routineId: "shutdown", trigger: "shutdown", startedAt: new Date().toISOString() });
        void routineEngine
          .runRoutine(built.routine)
          .then((result) => onRoutineCompleted(result))
          .catch((e: Error) => {
            console.warn("[lvis] boot: idle-shutdown routine failed:", e.message);
            notifyRoutineFailed(mainWindow, { routineId: "shutdown", trigger: "shutdown" }, e.message);
          });
      }
    });

    idleSignaler.start();
  } else {
    console.warn(
      "[lvis] boot: powerMonitor unavailable — RoutineIdleSignaler disabled (wakeup/shutdown by-idle won't fire)",
    );
  }

  return {
    evaluateSchedulesNow,
    dispose: () => {
      clearInterval(scheduleTimer);
      idleSignaler?.stop();
    },
  };
}
