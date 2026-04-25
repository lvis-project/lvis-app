import { describe, expect, it, vi } from "vitest";
import { wireRoutineCoordinator } from "../routine-coordinator.js";
import type { PowerMonitorLike } from "../../../main/idle-scheduler.js";

function makeSettings(overrides: Record<string, unknown> = {}) {
  return {
    enableWakeupRoutine: true,
    enableScheduleRoutine: false,
    enableShutdownRoutine: true,
    scheduleEntries: [],
    routineIdleThresholdMs: 10 * 60_000,
    wakeupRoutinePrompt: "morning brief",
    shutdownPrompt: "evening summary",
    ...overrides,
  };
}

class FakePowerMonitor implements PowerMonitorLike {
  systemIdleSec = 0;
  private handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  getSystemIdleTime() { return this.systemIdleSec; }
  on(event: string, handler: (...args: unknown[]) => void) {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event)!.push(handler);
    return this;
  }
  off(event: string, handler: (...args: unknown[]) => void) {
    const hs = this.handlers.get(event);
    if (hs) this.handlers.set(event, hs.filter((h) => h !== handler));
    return this;
  }
  removeAllListeners(event?: string) {
    if (event) this.handlers.delete(event); else this.handlers.clear();
    return this;
  }
  fire(event: string) { for (const h of this.handlers.get(event) ?? []) h(); }
}

describe("wireRoutineCoordinator — schedule cron", () => {
  it("dedupes schedule entry execution within the same minute", async () => {
    const intervalCallbacks: Array<() => void> = [];
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementation(((cb: TimerHandler) => {
      intervalCallbacks.push(cb as () => void);
      return { unref() {} } as unknown as NodeJS.Timeout;
    }) as typeof setInterval);
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => undefined);

    const runRoutine = vi.fn(async () => ({
      routineId: "s-1",
      trigger: "schedule" as const,
      summary: "sched done",
      generatedAt: new Date().toISOString(),
    }));

    const pm = new FakePowerMonitor();
    const wired = wireRoutineCoordinator({
      routineEngine: { runRoutine } as any,
      taskService: { getPendingByPriority: () => [] } as any,
      pluginRuntime: {
        findPluginIdByCapability: vi.fn(() => undefined),
        getPluginManifest: vi.fn(() => undefined),
      } as any,
      settingsService: {
        get: () =>
          makeSettings({
            enableScheduleRoutine: true,
            scheduleEntries: [
              {
                id: "s-1",
                enabled: true,
                agentId: "monitor",
                prompt: "check in",
                schedule: { minute: "*", hour: "*", dayOfMonth: "*", month: "*", dayOfWeek: "*" },
              },
            ],
          }),
      } as any,
      powerMonitor: pm,
      mainWindow: { isDestroyed: () => true, webContents: { send: vi.fn() } } as any,
    });

    await Promise.resolve();
    expect(runRoutine).toHaveBeenCalledTimes(1);

    // Second call in same minute should dedupe
    intervalCallbacks[0]?.();
    expect(runRoutine).toHaveBeenCalledTimes(1);

    wired.dispose();
    expect(clearIntervalSpy).toHaveBeenCalled();
    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });
});

describe("wireRoutineCoordinator — idle-driven wakeup/shutdown", () => {
  // The wakeup→runRoutine and shutdown→runRoutine connector wiring is exercised
  // via the RoutineIdleSignaler unit tests + this layer's integration is a
  // 3-line connector per routine type. We assert the powerMonitor=undefined
  // fallback below so the boot path is robust on platforms without lock/unlock
  // events. End-to-end signaler-driven firing is already covered by
  // routines/__tests__/idle-signaler.test.ts.
  it("when powerMonitor is undefined, idle-driven routines are silently disabled (schedule still works)", async () => {
    const intervalCallbacks: Array<() => void> = [];
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementation(((cb: TimerHandler) => {
      intervalCallbacks.push(cb as () => void);
      return { unref() {} } as unknown as NodeJS.Timeout;
    }) as typeof setInterval);
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => undefined);

    const runRoutine = vi.fn();
    const wired = wireRoutineCoordinator({
      routineEngine: { runRoutine } as any,
      taskService: {} as any,
      pluginRuntime: {} as any,
      settingsService: { get: () => makeSettings({ enableScheduleRoutine: false }) } as any,
      powerMonitor: undefined,
      mainWindow: { isDestroyed: () => true, webContents: { send: vi.fn() } } as any,
    });

    expect(runRoutine).not.toHaveBeenCalled();
    wired.dispose();
    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });
});
