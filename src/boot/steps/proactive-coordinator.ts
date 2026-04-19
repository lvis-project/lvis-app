/**
 * Boot §4.2 Step 6 — Proactive engine coordinator wiring.
 *
 * Builds the ProactiveTriggerCoordinator, starts it, and (when idleScheduler
 * is present) installs the composite idle-state listener that fans IDLE_SCAN
 * into both (a) direct briefing generation and (b) the coordinator's
 * `idle-scan` notifier. Extracted from boot.ts for readability.
 */
import type { BrowserWindow } from "electron";
import type { PluginRuntime } from "../../plugins/runtime.js";
import type { TaskService } from "../../taskService.js";
import type { SettingsService } from "../../data/settings-store.js";
import type { ProactiveEngine } from "../../core/proactive-engine.js";
import type { IdleSchedulerService, IdleState } from "../../main/idle-scheduler.js";
import { createProactiveTriggerCoordinator } from "../proactive.js";

export interface WireProactiveCoordinatorInput {
  proactiveEngine: ProactiveEngine;
  taskService: TaskService;
  pluginRuntime: PluginRuntime;
  settingsService: SettingsService;
  idleScheduler: IdleSchedulerService | undefined;
  mainWindow: BrowserWindow;
}

export function wireProactiveCoordinator(input: WireProactiveCoordinatorInput): void {
  const { proactiveEngine, taskService, pluginRuntime, settingsService, idleScheduler, mainWindow } = input;

  let proactiveScheduleLastDay: string | undefined;
  const proactiveCoordinator = createProactiveTriggerCoordinator({
    proactiveEngine,
    taskService,
    pluginRuntime,
    isIdleScanActive: () => idleScheduler?.getState() === "IDLE_SCAN",
    isScheduleEnabled: () =>
      settingsService.get("proactive")?.enableDailyBriefing ?? false,
    isPostTurnEnabled: () =>
      settingsService.get("proactive")?.enablePostTurnBriefing ?? false,
    getScheduleLastFiredDayKey: () => proactiveScheduleLastDay,
    setScheduleLastFiredDayKey: (key) => { proactiveScheduleLastDay = key; },
  });
  proactiveCoordinator.start();

  if (!idleScheduler) return;

  const existing = idleScheduler;
  const notifyCoordinator = (state: IdleState) => {
    if (state === "IDLE_SCAN") proactiveCoordinator.notify("idle-scan");
  };
  // setStateChangeListener accepts only one listener; this `composite` IS the
  // idle-scheduler wiring for proactive — fans IDLE_SCAN into direct briefing
  // generation + the coordinator notifier.
  const composite = (
    newState: IdleState,
    oldState: IdleState,
    reason: string,
  ): void => {
    if (newState === "IDLE_SCAN" && !proactiveCoordinator.isWithinGlobalCooldown()) {
      proactiveEngine
        .generateDailyBriefing({ idleState: "long_idle" })
        .then((r) => {
          if (r.status === "generated") {
            const win = mainWindow;
            if (!win.isDestroyed()) {
              try {
                win.webContents.send("lvis:proactive:briefing", r.briefing);
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
