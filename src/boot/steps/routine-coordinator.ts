/**
 * Boot §4.2 Step 6 — Proactive engine coordinator wiring.
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
import type { RoutineEngine } from "../../core/routine-engine.js";
import type { IdleSchedulerService, IdleState } from "../../main/idle-scheduler.js";
import { createRoutineTriggerCoordinator } from "../routine.js";

export interface WireRoutineCoordinatorInput {
  routineEngine?: RoutineEngine;
  /** @deprecated compatibility alias while callers migrate. */
  proactiveEngine?: RoutineEngine;
  taskService: TaskService;
  pluginRuntime: PluginRuntime;
  settingsService: SettingsService;
  idleScheduler: IdleSchedulerService | undefined;
  mainWindow: BrowserWindow;
}

export function wireRoutineCoordinator(input: WireRoutineCoordinatorInput): void {
  const { taskService, pluginRuntime, settingsService, idleScheduler, mainWindow } = input;
  const routineEngine = input.routineEngine ?? input.proactiveEngine;
  if (!routineEngine) return;

  let routineScheduleLastDay: string | undefined;
  const routineCoordinator = createRoutineTriggerCoordinator({
    routineEngine,
    taskService,
    pluginRuntime,
    isIdleScanActive: () => idleScheduler?.getState() === "IDLE_SCAN",
    isScheduleEnabled: () =>
      settingsService.get("proactive")?.enableDailyBriefing ?? false,
    isPostTurnEnabled: () =>
      settingsService.get("proactive")?.enablePostTurnBriefing ?? false,
    getScheduleLastFiredDayKey: () => routineScheduleLastDay,
    setScheduleLastFiredDayKey: (key) => { routineScheduleLastDay = key; },
  });
  routineCoordinator.start();

  if (!idleScheduler) return;

  const existing = idleScheduler;
  const notifyCoordinator = (state: IdleState) => {
    if (state === "IDLE_SCAN") routineCoordinator.notify("idle-scan");
  };
  // setStateChangeListener accepts only one listener; this `composite` IS the
  // idle-scheduler wiring for the routine runtime — fans IDLE_SCAN into direct briefing
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
            const win = mainWindow;
            if (!win.isDestroyed()) {
              try {
                win.webContents.send("lvis:proactive:briefing", r.briefing); // compatibility: renderer bridge remains proactive for now
              } catch (e) {
                console.warn("[lvis] boot: briefing webContents.send failed:", (e as Error).message);
              }
            }
          }
        })
        .catch((e: Error) =>
          console.warn("[lvis] boot: daily briefing trigger failed (non-fatal):", e.message),
        );
    }
    notifyCoordinator(newState);
    void oldState; void reason;
  };
  existing.setStateChangeListener(composite);
}

export type WireProactiveCoordinatorInput = WireRoutineCoordinatorInput;
export { wireRoutineCoordinator as wireProactiveCoordinator };
